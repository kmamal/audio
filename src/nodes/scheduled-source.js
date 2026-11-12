const { AudioNode } = require('../audio-node')
const { invalidStateError, checkFinite } = require('../errors')
const { queueTask, defineEventHandlers } = require('../events')
const { notify } = require('../remote/notify')

const FRAME_EPSILON = 1e-6

const checkWhen = (when) => {
	const value = checkFinite(when, 'when')
	if (value < 0) { throw new RangeError("when must be non-negative") }
	return value
}

const toFrame = (time, sampleRate) => {
	const frame = time * sampleRate
	const rounded = Math.round(frame)
	return Math.abs(frame - rounded) < FRAME_EPSILON ? rounded : frame
}

class AudioScheduledSourceNode extends AudioNode {
	constructor (context, options = {}) {
		super(context, {
			numberOfInputs: 0,
			numberOfOutputs: 1,
			channelCount: 2,
			channelCountMode: 'max',
			channelInterpretation: 'speakers',
			...options,
		})

		this._started = false
		this._ended = false
		this._startFrame = Infinity
		this._stopFrame = Infinity
	}

	start (when = 0) {
		if (this._started) { throw invalidStateError("start() may only be called once") }
		const time = checkWhen(when)
		this._started = true
		this._startFrame = toFrame(Math.max(time, this._context.currentTime), this._context.sampleRate)
		this._context._activeSources.add(this)
	}

	stop (when = 0) {
		if (!this._started) { throw invalidStateError("stop() may only be called after start()") }
		const time = checkWhen(when)
		this._stopFrame = toFrame(Math.max(time, this._context.currentTime), this._context.sampleRate)
	}

	_finish () {
		if (this._ended) { return }
		this._ended = true
		this._context._activeSources.delete(this)
		notify(this, 'ended')
		queueTask(() => {
			this.dispatchEvent(new Event('ended'))
			this._detach()
		})
	}

	_onRemote (type) {
		if (type === 'ended') { this._finish() }
	}

	_detach () {
		for (const entries of this._outputConnections) {
			for (const entry of entries) {
				if (entry.detached) { continue }
				entry.detached = true
				this._removeConnection(entry)
			}
		}
	}

	_removeConnection (entry) {
		if (entry.detached && entry.removed) { return }
		entry.removed = true
		super._removeConnection(entry)
	}

	get _playing () {
		return this._started && !this._ended
	}

	_computeActive () {
		return this._started && !this._ended && this._startFrame < this._context._frame + this._context._quantum
	}
}

defineEventHandlers(AudioScheduledSourceNode.prototype, [ 'ended' ])

module.exports = { AudioScheduledSourceNode }
