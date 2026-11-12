const { AudioScheduledSourceNode } = require('./scheduled-source')
const { AudioParam, defineParamAccessors } = require('../audio-param')
const { AudioBuffer } = require('../audio-buffer')
const { invalidStateError, checkFinite } = require('../errors')
const { checkOptions } = require('./options')
const { created } = require('../remote/client')

class AudioBufferSourceNode extends AudioScheduledSourceNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'AudioBufferSourceNode')
		super(context)

		this._buffer = null
		this._bufferSet = false
		this._loop = false
		this._loopStart = 0
		this._loopEnd = 0
		if (options.loop !== undefined) { this.loop = options.loop }
		if (options.loopStart !== undefined) { this.loopStart = options.loopStart }
		if (options.loopEnd !== undefined) { this.loopEnd = options.loopEnd }

		this._playbackRate = new AudioParam(context, { name: 'AudioBufferSourceNode.playbackRate', defaultValue: 1, automationRate: 'k-rate', fixedRate: true })
		this._detune = new AudioParam(context, { name: 'AudioBufferSourceNode.detune', defaultValue: 0, automationRate: 'k-rate', fixedRate: true })
		if (options.playbackRate !== undefined) { this.playbackRate.value = options.playbackRate }
		if (options.detune !== undefined) { this.detune.value = options.detune }

		this._offset = 0
		this._duration = null
		this._position = null
		this._startOffset = 0
		this._elapsed = 0
		this._enteredLoop = false
		this._data = null

		if (options.buffer !== undefined) { this.buffer = options.buffer }
		created(context, this, 'AudioBufferSourceNode', [ context, rawOptions ])
	}

	get loop () { return this._loop }
	set loop (value) { this._loop = Boolean(value) }

	get loopStart () { return this._loopStart }
	set loopStart (value) { this._loopStart = checkFinite(value, 'loopStart') }

	get loopEnd () { return this._loopEnd }
	set loopEnd (value) { this._loopEnd = checkFinite(value, 'loopEnd') }

	get buffer () { return this._buffer }
	set buffer (buffer) {
		if (buffer !== null && !(buffer instanceof AudioBuffer)) { throw new TypeError("buffer must be an AudioBuffer or null") }
		if (buffer !== null && this._bufferSet) { throw invalidStateError("buffer has already been set") }
		if (buffer !== null) { this._bufferSet = true }
		this._buffer = buffer
		if (buffer !== null && this._started) { this._data = buffer._acquire(this._context._remote === null) }
	}

	start (when, offset, duration) {
		if (offset !== undefined) {
			const value = checkFinite(offset, 'offset')
			if (value < 0) { throw new RangeError("offset must be non-negative") }
			this._offset = value
		}
		if (duration !== undefined) {
			const value = checkFinite(duration, 'duration')
			if (value < 0) { throw new RangeError("duration must be non-negative") }
			this._duration = value
		}
		super.start(when === undefined ? 0 : when)
		if (this._buffer !== null) { this._data = this._buffer._acquire(this._context._remote === null) }
	}

	_process () {
		const context = this._context
		const N = context._quantum
		const buffer = this._buffer
		const data = this._data
		const active = buffer !== null && data !== null && this._started && !this._ended
		const out = this._silence(0, active ? buffer.numberOfChannels : 1)

		if (!this._started || this._ended) { return }

		if (buffer === null || data === null) {
			this._finish()
			return
		}

		const blockStart = context._frame
		const blockEnd = blockStart + N
		if (this._startFrame >= blockEnd) { return }

		if (this._stopFrame <= blockStart || this._stopFrame <= this._startFrame) {
			this._finish()
			return
		}

		const bufferRate = buffer.sampleRate
		const length = buffer.length
		const rate = this.playbackRate._block()[0] * (2 ** (this.detune._block()[0] / 1200))
		const step = rate * bufferRate / context.sampleRate
		const limit = this._duration === null ? Infinity : this._duration * bufferRate

		let loopStart = 0
		let loopEnd = length
		if (this._loop) {
			const start = Math.min(Math.max(this._loopStart * bufferRate, 0), length)
			const end = Math.min(Math.max(this._loopEnd * bufferRate, 0), length)
			if (start < end) {
				loopStart = start
				loopEnd = end
			}
		}
		else {
			this._enteredLoop = false
		}
		const loopLength = loopEnd - loopStart
		const loopStartIndex = Math.floor(loopStart)

		const first = Math.max(Math.ceil(this._startFrame - blockStart), 0)
		const channels = data.length
		let position = this._position
		let elapsed = this._elapsed

		for (let i = first; i < N; i++) {
			if (blockStart + i >= this._stopFrame || elapsed >= limit) {
				this._finish()
				break
			}

			if (position === null) {
				let offset = Math.min(this._offset * bufferRate, length)
				if (this._loop && step >= 0 && offset >= loopEnd) { offset = loopEnd }
				if (this._loop && step < 0 && offset < loopStart) { offset = loopStart }
				this._startOffset = offset
				const lead = Math.min(blockStart + i - this._startFrame, 1)
				position = offset + lead * step
				elapsed = lead * Math.abs(step)
			}

			if (this._loop) {
				if (!this._enteredLoop) {
					const offset = this._startOffset
					if (offset < loopEnd && position >= loopStart) { this._enteredLoop = true }
					if (offset >= loopEnd && position < loopEnd) { this._enteredLoop = true }
				}
				if (this._enteredLoop && loopLength > 0) {
					while (position >= loopEnd) { position -= loopLength }
					while (position < loopStart) { position += loopLength }
				}
			}

			if (position >= 0 && position < length) {
				const i0 = Math.floor(position)
				const frac = position - i0
				let i1 = i0 + 1
				if (this._loop && this._enteredLoop && i1 >= loopEnd) { i1 = loopStartIndex }
				if (i1 < length) {
					for (let c = 0; c < channels; c++) {
						const src = data[c]
						const a = src[i0]
						out[c][i] = a + (src[i1] - a) * frac
					}
				}
				else if (i0 > 0) {
					for (let c = 0; c < channels; c++) {
						const src = data[c]
						const a = src[i0]
						out[c][i] = a + (a - src[i0 - 1]) * frac
					}
				}
				else {
					for (let c = 0; c < channels; c++) { out[c][i] = data[c][i0] }
				}
			}
			else if (!this._loop && ((position >= length && step > 0) || (position < 0 && step < 0))) {
				this._finish()
				break
			}

			position += step
			elapsed += Math.abs(step)
		}

		this._position = position
		this._elapsed = elapsed
	}
}

defineParamAccessors(AudioBufferSourceNode, [ 'playbackRate', 'detune' ])

module.exports = { AudioBufferSourceNode }
