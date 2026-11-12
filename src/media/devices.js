const { MediaStream, MediaStreamTrack } = require('./stream')
const { notFoundError, notSupportedError, abortError } = require('../errors')
const { defineEventHandlers, queueTask } = require('../events')
const { makeChannels, resizeChannels, zeroChannels } = require('../mixing')
const { notify } = require('../remote/notify')

const { loadSDL, findDevice, listDevices } = require('../sdl')

const PRIME_BLOCKS = 4

class RecordingSource {
	constructor ({ device = null, channels = 1 } = {}) {
		this._device = device
		this._channels = channels
		this._stream = null
		this._context = null
		this._queue = []
		this._queuedFrames = 0
		this._primed = false
		this._out = makeChannels(channels)
		this._blockId = -1
		this._tracks = new Set()
	}

	_snapshot () {
		return { cls: 'RecordingSource', args: [ { device: this._device, channels: this._channels } ] }
	}

	_open (context) {
		const sdl = loadSDL()
		this._context = context
		this._stream = sdl.audio.recording.openDevice(this._device, {
			channels: this._channels,
			frequency: context.sampleRate,
			format: 'f32',
			buffered: 512,
		})
		this._stream.on('close', () => { this._lost() })
		this._stream.play()
	}

	_lost () {
		const stream = this._stream
		if (stream === null) { return }
		this._stream = null
		try { stream.close() }
		catch {}
		for (const track of this._tracks) {
			if (track.readyState === 'live') {
				track._readyState = 'ended'
				track.dispatchEvent(new Event('ended'))
				notify(track, 'ended')
			}
		}
	}

	_drain () {
		try { this._read() }
		catch { this._lost() }
	}

	_read () {
		const stream = this._stream
		if (stream === null || stream.closed) { return }
		const available = stream.available
		if (available <= 0) { return }
		const frameSize = this._channels * 4
		const bytes = available - (available % frameSize)
		if (bytes <= 0) { return }
		const buffer = Buffer.alloc(bytes)
		const read = stream.getData(buffer, bytes)
		const frames = Math.floor(read / frameSize)
		if (frames <= 0) { return }
		this._queue.push({ data: new Float32Array(buffer.buffer, buffer.byteOffset, frames * this._channels), offset: 0 })
		this._queuedFrames += frames
	}

	_renderTrack (context) {
		if (this._blockId === context._blockId && this._context === context) { return this._out }
		this._blockId = context._blockId
		const N = context._quantum

		if (this._stream === null && this._context === null) {
			try { this._open(context) }
			catch { this._context = context }
		}

		const out = resizeChannels(this._out, this._channels, N)
		this._out = out
		zeroChannels(out)

		this._drain()

		if (!this._primed) {
			if (this._queuedFrames < PRIME_BLOCKS * N) { return out }
			this._primed = true
		}

		if (this._queuedFrames < N) {
			this._primed = false
			return out
		}

		const channels = this._channels
		let written = 0
		while (written < N) {
			const chunk = this._queue[0]
			const chunkFrames = chunk.data.length / channels - chunk.offset
			const take = Math.min(chunkFrames, N - written)
			for (let i = 0; i < take; i++) {
				const base = (chunk.offset + i) * channels
				for (let c = 0; c < channels; c++) { out[c][written + i] = chunk.data[base + c] }
			}
			chunk.offset += take
			written += take
			if (chunk.offset * channels >= chunk.data.length) { this._queue.shift() }
		}
		this._queuedFrames -= N

		return out
	}

	_stopTrack (track) {
		this._tracks.delete(track)
		if (this._tracks.size === 0 && this._stream !== null && !this._stream.closed) {
			this._stream.close()
			this._stream = null
		}
	}
}

const deviceId = (type, device) => device.id === null ? 'default' : `${type}:${device.id}`

const DEVICE_EVENTS = [ 'deviceAdd', 'deviceRemove' ]

class MediaDevices extends EventTarget {
	constructor () {
		super()
		this._listeners = new Set()
		this._watching = false
		this._pending = false
		this._onDevice = () => {
			if (this._pending) { return }
			this._pending = true
			queueTask(() => {
				this._pending = false
				this.dispatchEvent(new Event('devicechange'))
			})
		}
	}

	addEventListener (type, listener, options) {
		super.addEventListener(type, listener, options)
		if (type !== 'devicechange' || typeof listener !== 'function' && typeof listener?.handleEvent !== 'function') { return }
		this._listeners.add(listener)
		this._watch(true)
	}

	removeEventListener (type, listener, options) {
		super.removeEventListener(type, listener, options)
		if (type !== 'devicechange') { return }
		this._listeners.delete(listener)
		if (this._listeners.size === 0) { this._watch(false) }
	}

	_watch (wanted) {
		if (wanted === this._watching) { return }
		let sdl
		try { sdl = loadSDL() }
		catch { return }
		this._watching = wanted
		const method = wanted ? 'on' : 'off'
		for (const kind of [ 'playback', 'recording' ]) {
			for (const event of DEVICE_EVENTS) { sdl.audio[kind][method](event, this._onDevice) }
		}
	}

	enumerateDevices () {
		const list = []
		for (const device of listDevices('recording')) {
			list.push({ deviceId: deviceId('recording', device), kind: 'audioinput', label: device.name ?? 'Default', groupId: '' })
		}
		for (const device of listDevices('playback')) {
			list.push({ deviceId: deviceId('playback', device), kind: 'audiooutput', label: device.name ?? 'Default', groupId: '' })
		}
		return Promise.resolve(list)
	}

	getSupportedConstraints () {
		return { deviceId: true, channelCount: true, sampleRate: true }
	}

	getUserMedia (constraints = {}) {
		return new Promise((resolve) => { resolve(this._getUserMedia(constraints)) })
	}

	_getUserMedia (constraints) {
		if (constraints.video) { throw notSupportedError("video capture is not supported") }
		if (!constraints.audio) { throw new TypeError("getUserMedia() needs audio constraints") }

		const audio = typeof constraints.audio === 'object' ? constraints.audio : {}
		const sdl = loadSDL()
		if (!sdl.audio.isAvailable()) { throw notFoundError("the audio subsystem is not available") }

		const wanted = audio.deviceId?.exact ?? audio.deviceId?.ideal ?? audio.deviceId
		let device = findDevice('recording', wanted)
		if (device === undefined) {
			if (audio.deviceId?.exact !== undefined) { throw notFoundError(`no recording device matches ${wanted}`) }
			device = findDevice('recording', 'default')
		}

		const channelCount = audio.channelCount?.exact ?? audio.channelCount?.ideal ?? audio.channelCount ?? 1
		const channels = Math.min(Math.max(Number(channelCount) || 1, 1), 8)

		const source = new RecordingSource({ device, channels })
		const track = new MediaStreamTrack({
			kind: 'audio',
			label: device?.name ?? 'Default',
			source,
			settings: { deviceId: device ? deviceId('recording', device) : 'default', channelCount: channels },
		})

		try {
			const probe = sdl.audio.recording.openDevice(device, { channels, frequency: 48000, format: 'f32' })
			probe.close()
		}
		catch (error) {
			throw abortError(error.message)
		}

		return new MediaStream([ track ])
	}
}

defineEventHandlers(MediaDevices.prototype, [ 'devicechange' ])

let mediaDevices = null
const getMediaDevices = () => {
	if (mediaDevices === null) { mediaDevices = new MediaDevices() }
	return mediaDevices
}

module.exports = { MediaDevices, getMediaDevices, RecordingSource }
