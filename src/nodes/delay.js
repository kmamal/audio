const { AudioNode } = require('../audio-node')
const { AudioParam, defineParamAccessors } = require('../audio-param')
const { notSupportedError, checkFinite } = require('../errors')
const { applyChannelOptions, applyParamOptions, checkOptions } = require('./options')
const { created } = require('../remote/client')

class DelayNode extends AudioNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'DelayNode')
		super(context)

		const maxDelayTime = options.maxDelayTime === undefined ? 1 : checkFinite(options.maxDelayTime, 'maxDelayTime')
		if (maxDelayTime <= 0 || maxDelayTime >= 180) { throw notSupportedError("maxDelayTime must be greater than 0 and less than 180") }

		const N = context._quantum
		this._maxDelayTime = maxDelayTime
		this._maxDelayFrames = Math.ceil(maxDelayTime * context.sampleRate)
		this._size = Math.ceil((this._maxDelayFrames + N + 1) / N) * N
		this._delayTime = new AudioParam(context, { name: 'DelayNode.delayTime', defaultValue: 0, minValue: 0, maxValue: maxDelayTime })

		this._lines = []
		this._blockChannels = new Uint8Array(this._size / N)
		this._write = 0
		this._breaksCycles = true
		this._inCycle = false

		applyChannelOptions(this, options)
		applyParamOptions(this, options, [ 'delayTime' ])
		created(context, this, 'DelayNode', [ context, rawOptions ])
	}

	_tailFrames () { return this._maxDelayFrames }

	_ensureLines (count) {
		while (this._lines.length < count) { this._lines.push(new Float32Array(this._size)) }
	}

	_writeBlock (input) {
		const N = this._context._quantum
		this._ensureLines(input.length)
		const lines = this._lines
		const size = this._size
		const write = this._write
		for (let c = 0; c < lines.length; c++) {
			const line = lines[c]
			const src = c < input.length ? input[c] : null
			for (let i = 0; i < N; i++) { line[(write + i) % size] = src === null ? 0 : src[i] }
		}
		this._blockChannels[Math.floor(write / N)] = input.length
	}

	_readChannels (delay) {
		const N = this._context._quantum
		let minDelay = Infinity
		let maxDelay = 0
		for (let i = 0; i < N; i++) {
			const d = this._delayFrames(delay, i)
			if (d < minDelay) { minDelay = d }
			if (d > maxDelay) { maxDelay = d }
		}
		const size = this._size
		const blocks = this._blockChannels.length
		const wrap = (position) => ((position % size) + size) % size
		const first = Math.floor(wrap(this._write - Math.ceil(maxDelay)) / N)
		const last = Math.floor(wrap(this._write + N - Math.floor(minDelay)) / N)
		const span = ((last - first + blocks) % blocks) + 1
		let count = 0
		for (let b = 0; b < span; b++) {
			const channels = this._blockChannels[(first + b) % blocks]
			if (channels > count) { count = channels }
		}
		return Math.max(count, 1)
	}

	_read (line, position) {
		const size = this._size
		let p = position % size
		if (p < 0) { p += size }
		const i0 = Math.floor(p)
		const frac = p - i0
		const a = line[i0]
		const b = line[(i0 + 1) % size]
		return a + (b - a) * frac
	}

	_delayFrames (delay, index) {
		const frames = delay[index] * this._context.sampleRate
		return Math.min(Math.max(frames, 0), this._maxDelayFrames)
	}

	_pull (output = 0) {
		if (!this._inCycle || this._muted) { return super._pull(output) }
		const context = this._context
		if (this._blockId !== context._blockId) {
			this._blockId = context._blockId
			this._readLine()
			context._deferred.push(this)
		}
		return this._outputs[output]
	}

	_readLine () {
		const N = this._context._quantum
		const delay = this.delayTime._block()
		const count = this._readChannels(delay)
		const out = this._setOutputChannels(0, count)
		const lines = this._lines
		const write = this._write

		for (let c = 0; c < count; c++) {
			const line = lines[c]
			const dst = out[c]
			if (!line) {
				dst.fill(0)
				continue
			}
			for (let i = 0; i < N; i++) {
				const d = Math.max(this._delayFrames(delay, i), N)
				dst[i] = this._read(line, write + i - d)
			}
		}
	}

	_deferredProcess () {
		this._gatherInputs()
		this._writeBlock(this._inputBlocks[0])
		this._write = (this._write + this._context._quantum) % this._size
	}

	_process (inputs) {
		const N = this._context._quantum
		const input = inputs[0]
		this._writeBlock(input)
		const delay = this.delayTime._block()
		const count = this._readChannels(delay)
		const out = this._setOutputChannels(0, count)
		const lines = this._lines
		const write = this._write

		for (let c = 0; c < count; c++) {
			const line = lines[c]
			const dst = out[c]
			if (!line) {
				dst.fill(0)
				continue
			}
			for (let i = 0; i < N; i++) {
				const d = this._delayFrames(delay, i)
				dst[i] = this._read(line, write + i - d)
			}
		}

		this._write = (write + N) % this._size
	}
}

defineParamAccessors(DelayNode, [ 'delayTime' ])

module.exports = { DelayNode }
