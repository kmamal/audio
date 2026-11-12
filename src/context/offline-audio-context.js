const { MAX_CHANNELS } = require('../constants')
const { BaseAudioContext } = require('./base')
const { AudioBuffer } = require('../audio-buffer')
const { invalidStateError, notSupportedError, abortError, checkFinite, toUnsignedLong } = require('../errors')
const { defineEventHandlers } = require('../events')

const BLOCKS_PER_YIELD = 256

class OfflineAudioCompletionEvent extends Event {
	constructor (type, { renderedBuffer }) {
		super(type)
		this.renderedBuffer = renderedBuffer
	}
}

const parseOfflineArgs = (args) => {
	let numberOfChannels
	let length
	let sampleRate
	let renderSizeHint
	if (args.length === 0) { throw new TypeError("OfflineAudioContext needs options or numberOfChannels, length and sampleRate") }
	if (args.length === 1) {
		const options = args[0]
		if (typeof options !== 'object' || options === null) { throw new TypeError("OfflineAudioContext options must be an object") }
		if (options.sampleRate === undefined) { throw new TypeError("OfflineAudioContext options need a sampleRate") }
		({ numberOfChannels = 1, length = null, sampleRate, renderSizeHint } = options)
	}
	else if (args.length < 3) {
		throw new TypeError("OfflineAudioContext needs numberOfChannels, length and sampleRate")
	}
	else {
		[ numberOfChannels, length, sampleRate ] = args
	}
	numberOfChannels = toUnsignedLong(numberOfChannels)
	if (length !== null) { length = toUnsignedLong(length) }

	if (!Number.isInteger(numberOfChannels) || numberOfChannels < 1 || numberOfChannels > MAX_CHANNELS) {
		throw notSupportedError(`numberOfChannels must be between 1 and ${MAX_CHANNELS}`)
	}
	if (length !== null && (!Number.isInteger(length) || length < 1)) { throw notSupportedError("length must be a positive integer") }
	return { numberOfChannels, length, sampleRate, renderSizeHint }
}

const offlineChunkFrames = (chunkSize, length, committed, quantum) => {
	if (chunkSize === undefined) { return length === null ? quantum : length - committed }
	const frames = Math.max(Math.ceil(toUnsignedLong(chunkSize) / quantum), 1) * quantum
	return length === null ? frames : Math.min(frames, length - committed)
}

class OfflineAudioContext extends BaseAudioContext {
	constructor (...args) {
		const { numberOfChannels, length, sampleRate, renderSizeHint } = parseOfflineArgs(args)
		super({ sampleRate, destination: { channelCount: numberOfChannels, maxChannelCount: numberOfChannels, fixed: true }, renderSizeHint })

		this._length = length
		this._committed = 0
		this._started = false
		this._rendering = false
		this._closing = null
		this._jobs = []
		this._suspensions = new Map()
		this._resume = null
	}

	get length () { return this._length }

	startRendering (chunkSize) {
		if (this._state === 'closed' || this._closing !== null) { return Promise.reject(invalidStateError("the OfflineAudioContext is closed")) }
		const length = this._length
		if (length !== null && this._committed >= length) { return Promise.reject(invalidStateError("the whole length has already been rendered")) }

		let frames
		try { frames = offlineChunkFrames(chunkSize, length, this._committed, this._quantum) }
		catch (error) { return Promise.reject(error) }
		this._committed += frames

		if (!this._started) {
			this._started = true
			this._setState('running')
		}

		return new Promise((resolve, reject) => {
			this._jobs.push({ frames, resolve, reject, complete: chunkSize === undefined && length !== null })
			this._drain()
		})
	}

	_drain () {
		if (this._rendering || this._jobs.length === 0) { return }
		this._rendering = true
		const job = this._jobs[0]
		this._renderJob(job).then(
			(buffer) => {
				this._jobs.shift()
				this._rendering = false
				job.resolve(buffer)
				if (this._closing === null && this._length !== null && this._frame >= this._length) {
					this._setState('closed')
					if (job.complete) { this.dispatchEvent(new OfflineAudioCompletionEvent('complete', { renderedBuffer: buffer })) }
				}
				this._drain()
			},
			(error) => {
				this._jobs.shift()
				this._rendering = false
				job.reject(error)
				this._drain()
			},
		)
	}

	async _renderJob (job) {
		const channels = this._destination.channelCount
		const quantum = this._quantum
		const start = this._frame
		const end = start + job.frames
		const output = Array.from({ length: channels }, () => new Float32Array(job.frames))

		let rendered = 0
		while (this._frame < end) {
			if (this._closing !== null) { throw abortError("the OfflineAudioContext was closed") }

			const suspension = this._suspensions.get(this._frame)
			if (suspension !== undefined) {
				this._suspensions.delete(this._frame)
				this._setState('suspended')
				suspension.resolve()
				await new Promise((resolve) => { this._resume = resolve })
				this._resume = null
				if (this._closing !== null) { throw abortError("the OfflineAudioContext was closed") }
				this._setState('running')
			}

			const frame = this._frame
			const block = this._renderBlock()
			const count = Math.min(quantum, end - frame)
			for (let c = 0; c < channels; c++) {
				const src = block[c]
				if (src) { output[c].set(count === src.length ? src : src.subarray(0, count), frame - start) }
			}

			if (++rendered % BLOCKS_PER_YIELD === 0) {
				await new Promise((resolve) => { setImmediate(resolve) })
			}
		}

		return AudioBuffer._fromChannels(output, this._sampleRate)
	}

	suspend (suspendTime) {
		let time
		try { time = checkFinite(suspendTime, 'suspendTime') }
		catch (error) { return Promise.reject(error) }
		if (time < 0) { return Promise.reject(invalidStateError("suspendTime must be non-negative")) }
		const frame = Math.ceil(time * this._sampleRate / this._quantum) * this._quantum
		if (frame < this._frame) { return Promise.reject(invalidStateError("suspendTime is in the past")) }
		if (this._length !== null && frame >= this._length) { return Promise.reject(invalidStateError("suspendTime is beyond the rendering length")) }
		if (this._suspensions.has(frame)) { return Promise.reject(invalidStateError("a suspension is already scheduled at that time")) }
		if (this._state === 'closed' || this._closing !== null) { return Promise.reject(invalidStateError("the OfflineAudioContext is closed")) }

		return new Promise((resolve, reject) => { this._suspensions.set(frame, { resolve, reject }) })
	}

	resume () {
		if (this._state === 'closed') { return Promise.reject(invalidStateError("the OfflineAudioContext is closed")) }
		if (!this._started) { return Promise.reject(invalidStateError("rendering has not started")) }
		if (this._state !== 'suspended') { return Promise.resolve() }
		if (this._resume !== null) { this._resume() }
		return Promise.resolve()
	}

	close () {
		if (this._state === 'closed' || this._closing !== null) { return Promise.reject(invalidStateError("the OfflineAudioContext is already closed")) }

		const closed = new Promise((resolve) => { this._closing = resolve })

		const queued = this._jobs.splice(this._rendering ? 1 : 0)
		for (const job of queued) { job.reject(abortError("the OfflineAudioContext was closed")) }

		for (const { reject } of this._suspensions.values()) { reject(invalidStateError("the OfflineAudioContext was closed")) }
		this._suspensions.clear()

		const finish = () => {
			this._setState('closed')
			this._closing()
		}

		if (this._rendering) {
			const job = this._jobs[0]
			const { reject } = job
			job.reject = (error) => {
				reject(error)
				finish()
			}
			if (this._resume !== null) { this._resume() }
		}
		else {
			finish()
		}

		return closed
	}
}

defineEventHandlers(OfflineAudioContext.prototype, [ 'complete' ])

module.exports = { OfflineAudioContext, OfflineAudioCompletionEvent, parseOfflineArgs, offlineChunkFrames }
