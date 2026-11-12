const { loadSDL, findDevice: findAnyDevice } = require('../sdl')

const findDevice = (sinkId) => findAnyDevice('playback', sinkId)

class SDLSink {
	constructor ({ sampleRate, channels, buffered, sinkId = '', device, onClose = null, onDrain = null }) {
		const sdl = loadSDL()
		if (device === undefined) { throw new Error(`no playback device matches ${sinkId}`) }

		this._stream = sdl.audio.playback.openDevice(device, {
			channels,
			frequency: sampleRate,
			format: 'f32',
			buffered,
		})
		this.sampleRate = sampleRate
		this.channels = channels
		this.sinkId = sinkId
		this._buffered = buffered
		this._frameBytes = channels * 4
		this._closed = false
		this._onClose = onClose
		this._underruns = 0

		this._stream.on('drain', (event) => {
			this._underruns = (this._underruns + event.underruns) >>> 0
			if (!this._closed) { onDrain?.() }
		})
		this._stream.on('close', () => { this._lost() })
	}

	get drivesPump () { return true }

	_lost () {
		if (this._closed) { return }
		this._closed = true
		try { this._stream.close() }
		catch {}
		this._onClose?.()
	}

	get bufferedFrames () {
		return this._stream.device.buffered ?? this._buffered
	}

	get queuedFrames () {
		if (this._closed) { return Infinity }
		try { return this._stream.queued / this._frameBytes }
		catch {
			this._lost()
			return Infinity
		}
	}

	get underruns () {
		if (this._closed) { return undefined }
		return this._underruns
	}

	get closed () { return this._closed }

	write (interleaved) {
		if (this._closed) { return }
		try { this._stream.putData(Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength)) }
		catch { this._lost() }
	}

	_call (method) {
		if (this._closed) { return }
		try { this._stream[method]() }
		catch { this._lost() }
	}

	play () { this._call('play') }
	pause () { this._call('pause') }

	close () {
		if (this._closed) { return }
		this._closed = true
		try { this._stream.close() }
		catch {}
	}
}

module.exports = { SDLSink, findDevice }
