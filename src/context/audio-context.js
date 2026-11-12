const { BaseAudioContext } = require('./base')
const { SDLSink, findDevice } = require('../sink/sdl')
const { NullSink } = require('../sink/null')
const { CaptureSink } = require('../sink/capture')
const { invalidStateError, notFoundError, checkFinite } = require('../errors')
const { defineEventHandlers, queueTask } = require('../events')
const { mixAdd, makeChannels, resizeChannels } = require('../mixing')
const { getClient, created } = require('../remote/client')
const { notify, forwarding, remoteSide } = require('../remote/notify')
const { loadHostSDL, preferredSampleRate } = require('../sdl')
const { CLOCK } = require('./clock')
const { AudioRenderCapacity } = require('./render-capacity')
const { AudioPlaybackStats } = require('./playback-stats')
const { getRemoteProcessors } = require('../worklet')
const Timers = require('node:timers')

const PUMP_INTERVAL = 5
const FALLBACK_INTERVAL = 50
const DEFAULT_SAMPLE_RATE = 48000
const MAX_DEVICE_CHANNELS = 8
const SINK_DEVICE = Symbol('sinkDevice')
const CAPTURE = Symbol('capture')
const TWIN = Symbol('twin')

const LATENCY_HINTS = {
	interactive: { buffered: 512, lead: 0.1 },
	balanced: { buffered: 2048, lead: 0.15 },
	playback: { buffered: 4096, lead: 0.25 },
}

const nextPowerOfTwo = (x) => 2 ** Math.ceil(Math.log2(Math.max(x, 1)))

const resolveLatency = (hint, sampleRate) => {
	if (hint === undefined || hint === null) { return { ...LATENCY_HINTS.interactive, adaptive: true } }
	if (typeof hint === 'string') {
		const entry = LATENCY_HINTS[hint]
		if (!entry) { throw new TypeError("latencyHint must be 'interactive', 'balanced', 'playback' or a number of seconds") }
		return { ...entry, adaptive: true }
	}
	const seconds = checkFinite(hint, 'latencyHint')
	if (seconds < 0) { throw new RangeError("latencyHint must be non-negative") }
	const buffered = Math.min(Math.max(nextPowerOfTwo(seconds * sampleRate), 256), 8192)
	return { buffered, lead: Math.max(seconds * 2, 0.05), adaptive: false }
}

const normalizeSinkId = (sinkId) => {
	if (typeof sinkId === 'string') { return sinkId }
	if (typeof sinkId === 'object' && sinkId !== null && sinkId.type === 'none') { return { type: 'none' } }
	throw new TypeError("sinkId must be a string or { type: 'none' }")
}

const defaultSampleRate = (sinkId) => {
	if (typeof sinkId !== 'string') { return DEFAULT_SAMPLE_RATE }
	const device = lookupDevice(sinkId)
	if (device === undefined) { return DEFAULT_SAMPLE_RATE }
	return preferredSampleRate('playback', device) ?? DEFAULT_SAMPLE_RATE
}

const lookupDevice = (sinkId) => {
	if (typeof sinkId === 'object') { return undefined }
	try { return findDevice(sinkId) }
	catch { return undefined }
}

class AudioContext extends BaseAudioContext {
	constructor (rawOptions = {}) {
		const options = rawOptions === null ? {} : rawOptions
		if (typeof options !== 'object') { throw new TypeError("AudioContext options must be an object") }

		const sinkId = options.sinkId === undefined ? '' : normalizeSinkId(options.sinkId)
		const sampleRate = options.sampleRate === undefined ? defaultSampleRate(sinkId) : options.sampleRate
		super({ sampleRate, destination: { channelCount: 2, maxChannelCount: MAX_DEVICE_CHANNELS }, renderSizeHint: options.renderSizeHint })

		const latency = resolveLatency(options.latencyHint, this._sampleRate)
		this._buffered = latency.buffered
		this._leadMax = Math.max(this._blocks(latency.lead * this._sampleRate), 2 * latency.buffered)
		this._adaptive = latency.adaptive
		this._leadMin = this._leadMax
		this._leadFrames = this._leadMax
		this._underruns = 0
		this._primed = false
		this._sinkId = sinkId
		this._requestedSinkId = sinkId
		this._target = 'suspended'
		this._hasSinkDevice = false
		this._sinkDevice = undefined
		this._sinkSeq = 0
		this._sinkKind = 'unknown'
		this._sinkError = null
		this._sinkChanges = new Set()
		this._lastPump = 0
		this._sink = null
		this._timer = null
		this._elements = new Set()
		this._elementMix = makeChannels(2)
		this._interleaved = null

		this._capture = options[CAPTURE] ?? null
		this._onCapture = null
		if (SINK_DEVICE in options) {
			this._hasSinkDevice = true
			this._sinkDevice = options[SINK_DEVICE]
		}

		const client = getClient()
		if (client !== null) {
			if (typeof this._sinkId === 'string') { loadHostSDL() }
			this._remote = client
			const twinOptions = { sampleRate: this._sampleRate, latencyHint: options.latencyHint, sinkId: this._sinkId, renderSizeHint: options.renderSizeHint }
			created(this, this, 'AudioContext', [ twinOptions, lookupDevice(this._sinkId), this._capture ], null, { copyShared: false })
		}
		else {
			this._openSink()
		}

		if (this._capture === null && !options[TWIN]) { this.resume().catch(() => {}) }
	}

	_blocks (frames) { return Math.ceil(frames / this._quantum) * this._quantum }

	get baseLatency () { return Math.max(this._buffered, this._quantum) / this._sampleRate }

	get outputLatency () {
		if (this._remote !== null) { return this._clock[CLOCK.OUTPUT_LATENCY] }
		if (this._sink === null) { return 0 }
		const queued = Number.isFinite(this._sink.queuedFrames) ? this._sink.queuedFrames : 0
		return (queued + this._sink.bufferedFrames) / this._sampleRate
	}

	get sinkId () { return this._sinkId }

	get renderCapacity () {
		if (this._renderCapacity === undefined) { this._renderCapacity = new AudioRenderCapacity(this) }
		return this._renderCapacity
	}

	get playbackStats () {
		if (this._playbackStats === undefined) { this._playbackStats = new AudioPlaybackStats(this) }
		return this._playbackStats
	}

	getOutputTimestamp () {
		return {
			contextTime: Math.max(this.currentTime - this.outputLatency, 0),
			performanceTime: performance.now(),
		}
	}

	_applyState (state) {
		const changed = super._applyState(state)
		if (changed) { this._updateAlive() }
		return changed
	}

	_updateAlive () {
		const running = this._state === 'running'
		this._remote?.setAlive(this, running, running && this._sinkKind !== 'null')
	}

	_remoteFailed (error) {
		if (this._state === 'closed') { return }
		const event = new Event('error')
		event.error = error
		event.message = error.message
		this.dispatchEvent(event)
		this._target = 'closed'
		this._setState('closed')
	}

	_captureFull (id) { this._captureEvent('captured', id) }

	_captureEvent (type, data) {
		if (forwarding(this)) {
			notify(this, type, data)
			return
		}
		this._onCapture?.(type, data)
	}

	_captureSegment (segment) { this._sink?.addSegment?.(segment) }
	_captureSuspend (frame) { this._sink?.suspendAt?.(frame) }
	_captureResume (frame) { this._sink?.release?.(frame) }

	_onRemote (type, data) {
		if (type === 'processorRegistered') {
			getRemoteProcessors(this).set(data.name, { descriptors: data.descriptors })
			return
		}
		if (type === 'captured' || type === 'captureSuspended') {
			this._onCapture?.(type, data)
			return
		}
		if (type !== 'sink' || data.seq !== this._sinkSeq) { return }
		this._sinkKind = data.kind
		if (data.error) { this._dispatchSinkError(data.error) }
		if (JSON.stringify(data.sinkId) !== JSON.stringify(this._requestedSinkId)) {
			this._sinkId = data.sinkId
			this._requestedSinkId = data.sinkId
		}
		this._updateAlive()
	}

	_twinReady () { this._reportSink() }

	_reportSink () {
		const error = this._sinkError
		if (remoteSide()) {
			if (!forwarding(this)) { return }
			notify(this, 'sink', { kind: this._sink instanceof SDLSink ? 'sdl' : 'null', sinkId: this._sinkId, seq: this._sinkSeq, error })
			this._sinkError = null
			return
		}
		this._sinkError = null
		if (error !== null) { this._dispatchSinkError(error) }
	}

	_dispatchSinkError (message) {
		queueTask(() => {
			if (this._target === 'closed') { return }
			this.dispatchEvent(Object.assign(new Event('error'), { message, error: notFoundError(message) }))
		})
	}

	_openSink () {
		const channels = this._destination.channelCount
		const options = { sampleRate: this._sampleRate, channels, buffered: this._buffered }

		if (this._capture !== null) {
			this._sink = new CaptureSink({
				capture: this._capture,
				onFull: (id) => { this._captureFull(id) },
				onSuspend: (frame) => { this._captureEvent('captureSuspended', frame) },
			})
		}
		else if (typeof this._sinkId === 'object') {
			this._sink = new NullSink(options)
		}
		else {
			try {
				const device = this._hasSinkDevice ? this._sinkDevice : findDevice(this._sinkId)
				this._sink = new SDLSink({
					...options,
					sinkId: this._sinkId,
					device,
					onClose: () => { this._onSinkLost() },
					onDrain: () => { if (this._timer !== null) { this._pump() } },
				})
			}
			catch {
				this._sink = new NullSink(options)
				if (this._sinkId !== '') {
					this._sinkError = `no playback device matches ${this._sinkId}`
					this._sinkId = ''
					this._requestedSinkId = ''
					this._hasSinkDevice = false
				}
			}
		}

		const margin = this._sink.drivesPump ? 2 * this._quantum : this._blocks(2 * PUMP_INTERVAL / 1000 * this._sampleRate)
		this._leadMin = this._adaptive ? Math.min(this._buffered + margin, this._leadMax) : this._leadMax
		this._leadFrames = this._leadMin
		this._underruns = this._sink.underruns ?? 0
		this._primed = false
		this._reportSink()
		if (this._timer !== null) { this._startTimer() }
	}

	_startTimer () {
		if (this._timer !== null) { Timers.clearInterval(this._timer) }
		const interval = this._sink?.drivesPump ? FALLBACK_INTERVAL : PUMP_INTERVAL
		this._timer = Timers.setInterval(() => { this._pump() }, interval)
		this._timer.unref()
	}

	_onSinkLost () {
		if (this._target === 'closed') { return }
		const previous = this._sink
		this._sink = null
		queueMicrotask(() => {
			if (this._target === 'closed' || this._sink !== null) { return }
			this._openSink()
			if (this._sink instanceof NullSink && previous instanceof SDLSink) {
				this._sinkId = ''
				this._requestedSinkId = ''
				this._hasSinkDevice = false
				this._reportSink()
			}
			if (this._target === 'running') { this._sink.play() }
		})
	}

	_onDestinationChannelsChanged () {
		if (this._sink === null) { return }
		const running = this._target === 'running'
		this._sink.close()
		this._openSink()
		if (running) { this._sink.play() }
	}

	setSinkId (sinkId) {
		let normalized
		try { normalized = normalizeSinkId(sinkId) }
		catch (error) { return Promise.reject(error) }
		if (this._target === 'closed') { return Promise.reject(invalidStateError("the AudioContext is closed")) }
		if (JSON.stringify(normalized) === JSON.stringify(this._sinkId)) { return Promise.resolve() }

		const device = lookupDevice(normalized)
		if (typeof normalized === 'string' && device === undefined) {
			return Promise.reject(notFoundError(`no playback device matches ${normalized}`))
		}

		const seq = ++this._sinkSeq
		const wasRunning = this._target === 'running'
		this._requestedSinkId = normalized
		const changed = () => {
			if (wasRunning) {
				queueTask(() => {
					if (this._applyState('suspended')) { this.dispatchEvent(new Event('statechange')) }
				})
			}
			this._sinkId = normalized
			queueTask(() => { this.dispatchEvent(new Event('sinkchange')) })
			if (wasRunning) {
				queueTask(() => {
					if (this._target === 'running' && this._applyState('running')) { this.dispatchEvent(new Event('statechange')) }
				})
			}
		}

		const pending = {}
		this._sinkChanges.add(pending)
		return new Promise((resolve, reject) => {
			pending.reject = reject
			const finish = () => {
				if (!this._sinkChanges.delete(pending)) { return }
				resolve()
				changed()
			}
			if (this._remote !== null) {
				if (typeof normalized === 'string') { loadHostSDL() }
				this._remote.request('invoke', { target: this, method: '_useSink', args: [ normalized, device, seq ] }).then(
					finish,
					(error) => { if (this._sinkChanges.delete(pending)) { reject(error) } },
				)
				return
			}
			this._useSink(normalized, device, seq)
			queueTask(finish)
		})
	}

	_useSink (sinkId, device, seq) {
		const running = this._target === 'running'
		this._sink?.close()
		this._sinkId = sinkId
		this._sinkSeq = seq
		this._hasSinkDevice = true
		this._sinkDevice = device
		this._openSink()
		if (running) { this._sink.play() }
	}

	_attachElement (element) {
		this._elements.add(element)
		this._remote?.send(this, '_attachElement', [ element ])
	}

	_detachElement (element) {
		this._elements.delete(element)
		this._remote?.send(this, '_detachElement', [ element ])
	}

	_pump () {
		const sink = this._sink
		if (sink === null) { return }
		const channels = this._destination.channelCount

		const underruns = sink.underruns
		const starved = underruns === undefined ? sink.queuedFrames <= 0 : underruns !== this._underruns
		if (underruns !== undefined) {
			if (starved) { this._clock[CLOCK.UNDERRUNS] += (underruns - this._underruns) >>> 0 }
			this._underruns = underruns
		}
		else if (this._primed && starved) { this._clock[CLOCK.UNDERRUNS]++ }
		if (this._primed && starved && this._leadFrames < this._leadMax) {
			this._leadFrames = Math.min(this._blocks(this._leadFrames * 2), this._leadMax)
		}

		const lead = this._leadFrames
		const limit = Math.ceil(lead / this._quantum) + 1
		let rendered = 0
		const clock = this._clock
		const blockSeconds = this._quantum / this._sampleRate
		while (sink.queuedFrames < lead && rendered++ < limit) {
			const start = performance.now()
			const output = this._renderBlock()
			if (sink.writeBlock) { sink.writeBlock(output) }
			else { sink.write(this._interleave(output, channels)) }
			const busy = (performance.now() - start) / 1000
			clock[CLOCK.BUSY] += busy
			clock[CLOCK.RENDERED] += this._quantum
			if (busy / blockSeconds > clock[CLOCK.PEAK]) { clock[CLOCK.PEAK] = busy / blockSeconds }
		}
		if (sink.queuedFrames >= lead) { this._primed = true }

		clock[CLOCK.LEAD] = this._leadFrames
		clock[CLOCK.OUTPUT_LATENCY] = this.outputLatency
		this._lastPump = performance.now()
	}

	_catchUp () {
		if (this._timer === null || this._lastPump === 0) { return }
		const interval = this._sink?.drivesPump ? FALLBACK_INTERVAL : PUMP_INTERVAL
		if (performance.now() - this._lastPump > 2 * interval) { this._pump() }
	}

	_renderBlock () {
		const output = super._renderBlock()
		if (this._elements.size === 0) { return output }

		const mix = resizeChannels(this._elementMix, output.length)
		this._elementMix = mix
		for (let c = 0; c < output.length; c++) { mix[c].set(output[c]) }
		for (const element of this._elements) { mixAdd(mix, element._render(this), 'speakers') }
		return mix
	}

	_interleave (channels, count) {
		const N = this._quantum
		if (this._interleaved === null || this._interleaved.length !== N * count) { this._interleaved = new Float32Array(N * count) }
		const out = this._interleaved
		for (let c = 0; c < count; c++) {
			const src = channels[c] ?? null
			if (src === null) {
				for (let i = 0; i < N; i++) { out[i * count + c] = 0 }
				continue
			}
			for (let i = 0; i < N; i++) {
				const v = src[i]
				out[i * count + c] = v < -1 ? -1 : v > 1 ? 1 : v
			}
		}
		return out
	}

	_settle (apply) {
		return new Promise((resolve) => {
			queueTask(() => {
				resolve()
				apply()
			})
		})
	}

	_invokeTwin (method, state) {
		const apply = () => { this._setState(state) }
		return this._remote.request('invoke', { target: this, method }).then(apply, apply)
	}

	resume () {
		if (this._target === 'closed') { return Promise.reject(invalidStateError("the AudioContext is closed")) }
		this._target = 'running'
		if (this._remote !== null) { return this._invokeTwin('resume', 'running') }
		if (this._timer === null) {
			this._startTimer()
			setImmediate(() => {
				if (this._timer === null) { return }
				this._pump()
				if (this._sink !== null) { this._sink.play() }
			})
		}
		return this._settle(() => { this._setState('running') })
	}

	suspend () {
		if (this._target === 'closed') { return Promise.reject(invalidStateError("the AudioContext is closed")) }
		this._target = 'suspended'
		if (this._remote !== null) { return this._invokeTwin('suspend', 'suspended') }
		if (this._timer !== null) {
			Timers.clearInterval(this._timer)
			this._timer = null
			if (this._sink !== null) { this._sink.pause() }
		}
		return this._settle(() => { this._setState('suspended') })
	}

	close () {
		if (this._target === 'closed') { return Promise.reject(invalidStateError("the AudioContext is already closed")) }
		this._target = 'closed'
		for (const pending of this._sinkChanges) { pending.reject(invalidStateError("the AudioContext is closed")) }
		this._sinkChanges.clear()
		if (this._remote !== null) { return this._invokeTwin('close', 'closed') }
		if (this._timer !== null) {
			Timers.clearInterval(this._timer)
			this._timer = null
		}
		if (this._sink !== null) {
			this._sink.close()
			this._sink = null
		}
		return this._settle(() => { this._setState('closed') })
	}
}

defineEventHandlers(AudioContext.prototype, [ 'sinkchange', 'error' ])

module.exports = { AudioContext, SINK_DEVICE, CAPTURE, TWIN }
