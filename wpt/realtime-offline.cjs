const { AudioContext, CAPTURE } = require('../src/context/audio-context')
const { OfflineAudioCompletionEvent, parseOfflineArgs, offlineChunkFrames } = require('../src/context/offline-audio-context')
const { AudioBuffer } = require('../src/audio-buffer')
const { sharedFloat32 } = require('../src/remote/shared')
const { defineEventHandlers } = require('../src/events')
const { invalidStateError, abortError, checkFinite } = require('../src/errors')

class RealtimeOfflineAudioContext extends AudioContext {
	constructor (...args) {
		const { numberOfChannels, length, sampleRate, renderSizeHint } = parseOfflineArgs(args)
		super({ sampleRate, renderSizeHint, sinkId: { type: 'none' }, latencyHint: 1, [CAPTURE]: { channels: numberOfChannels } })
		this._shimChannels = numberOfChannels
		this._shimLength = length
		this._committed = 0
		this._started = false
		this._jobs = []
		this._nextJob = 0
		this._suspensions = new Map()
		this._heldFrame = null
		this._onCapture = (type, data) => {
			if (type === 'captured') { this._filled(data) }
			else { this._suspended(data) }
		}
		this.destination.channelCount = numberOfChannels
	}

	get length () { return this._shimLength }

	_call (method, ...args) {
		if (this._remote !== null) { this._remote.send(this, method, args) }
		else { this[method](...args) }
	}

	_filled (id) {
		const job = this._jobs[0]
		if (job === undefined || job.id !== id) { return }
		this._jobs.shift()
		const buffer = AudioBuffer._fromChannels(job.channels, this.sampleRate)
		const done = this._shimLength !== null && this._jobs.length === 0 && this._committed >= this._shimLength
		if (!done) {
			job.resolve(buffer)
			return
		}
		super.close().catch(() => {}).then(() => {
			job.resolve(buffer)
			if (job.complete) { this.dispatchEvent(new OfflineAudioCompletionEvent('complete', { renderedBuffer: buffer })) }
		})
	}

	_suspended (frame) {
		const pending = this._suspensions.get(frame)
		if (pending === undefined) { return }
		this._suspensions.delete(frame)
		this._heldFrame = frame
		this._setState('suspended')
		pending.resolve()
	}

	startRendering (chunkSize) {
		if (this._target === 'closed') { return Promise.reject(invalidStateError("the OfflineAudioContext is closed")) }
		const length = this._shimLength
		if (length !== null && this._committed >= length) { return Promise.reject(invalidStateError("the whole length has already been rendered")) }

		let frames
		try { frames = offlineChunkFrames(chunkSize, length, this._committed, this.renderQuantumSize) }
		catch (error) { return Promise.reject(error) }
		this._committed += frames

		if (!this._started) {
			this._started = true
			this._setState('running')
			super.resume().catch(() => {})
		}

		const id = this._nextJob++
		const channels = Array.from({ length: this._shimChannels }, () => sharedFloat32(frames))
		return new Promise((resolve, reject) => {
			this._jobs.push({ id, channels, resolve, reject, complete: chunkSize === undefined && length !== null })
			this._call('_captureSegment', { id, channels, length: frames })
		})
	}

	suspend (suspendTime) {
		let time
		try { time = checkFinite(suspendTime, 'suspendTime') }
		catch (error) { return Promise.reject(error) }
		if (time < 0) { return Promise.reject(invalidStateError("suspendTime must be non-negative")) }
		const frame = Math.ceil(time * this.sampleRate / this.renderQuantumSize) * this.renderQuantumSize
		if (frame < this.currentTime * this.sampleRate) { return Promise.reject(invalidStateError("suspendTime is in the past")) }
		if (this._shimLength !== null && frame >= this._shimLength) { return Promise.reject(invalidStateError("suspendTime is beyond the rendering length")) }
		if (this._suspensions.has(frame)) { return Promise.reject(invalidStateError("a suspension is already scheduled at that time")) }
		if (this._target === 'closed') { return Promise.reject(invalidStateError("the OfflineAudioContext is closed")) }
		return new Promise((resolve, reject) => {
			this._suspensions.set(frame, { resolve, reject })
			this._call('_captureSuspend', frame)
		})
	}

	resume () {
		if (this._target === 'closed') { return Promise.reject(invalidStateError("the OfflineAudioContext is closed")) }
		if (!this._started) { return Promise.reject(invalidStateError("rendering has not started")) }
		if (this._heldFrame === null) { return Promise.resolve() }
		const frame = this._heldFrame
		this._heldFrame = null
		this._setState('running')
		this._call('_captureResume', frame)
		return Promise.resolve()
	}

	close () {
		if (this._target === 'closed') { return Promise.reject(invalidStateError("the OfflineAudioContext is already closed")) }
		for (const job of this._jobs.splice(0)) { job.reject(abortError("the OfflineAudioContext was closed")) }
		for (const { reject } of this._suspensions.values()) { reject(invalidStateError("the OfflineAudioContext was closed")) }
		this._suspensions.clear()
		this._heldFrame = null
		return super.close()
	}
}

defineEventHandlers(RealtimeOfflineAudioContext.prototype, [ 'complete' ])

module.exports = { RealtimeOfflineAudioContext }
