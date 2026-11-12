const { AudioNode } = require('../audio-node')
const { invalidStateError, checkEnum, isEnum } = require('../errors')
const { applyChannelOptions, checkOptions } = require('./options')
const { created } = require('../remote/client')

const OVERSAMPLE = [ 'none', '2x', '4x' ]

class WaveShaperNode extends AudioNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'WaveShaperNode')
		super(context)

		this._curve = null
		this._oversample = 'none'
		this._lasts = []

		applyChannelOptions(this, options)
		if (options.curve !== undefined) { this.curve = options.curve }
		if (options.oversample !== undefined) { this.oversample = checkEnum(options.oversample, OVERSAMPLE, 'oversample') }
		created(context, this, 'WaveShaperNode', [ context, rawOptions ])
	}

	get curve () { return this._curve }
	set curve (curve) {
		if (curve === null) {
			this._curve = null
			return
		}
		if (typeof curve.length !== 'number') { throw new TypeError("curve must be a Float32Array or null") }
		if (curve.length < 2) { throw invalidStateError("curve must have at least two elements") }
		this._curve = Float32Array.from(curve)
	}

	get oversample () { return this._oversample }
	set oversample (value) {
		if (!isEnum(value, OVERSAMPLE)) { return }
		this._oversample = value
	}

	_shape (x) {
		const curve = this._curve
		const n = curve.length
		const v = (n - 1) * (x + 1) / 2
		if (v <= 0) { return curve[0] }
		if (v >= n - 1) { return curve[n - 1] }
		const k = Math.floor(v)
		const f = v - k
		return curve[k] + (curve[k + 1] - curve[k]) * f
	}

	_process (inputs) {
		const input = inputs[0]
		const N = this._context._quantum
		const count = input.length
		const out = this._setOutputChannels(0, count)

		if (this._curve === null) {
			for (let c = 0; c < count; c++) { out[c].set(input[c]) }
			return
		}

		const factor = this._oversample === '4x' ? 4 : this._oversample === '2x' ? 2 : 1

		while (this._lasts.length < count) { this._lasts.push(0) }

		for (let c = 0; c < count; c++) {
			const src = input[c]
			const dst = out[c]

			if (factor === 1) {
				for (let i = 0; i < N; i++) { dst[i] = this._shape(src[i]) }
				continue
			}

			let previous = this._lasts[c]
			for (let i = 0; i < N; i++) {
				const current = src[i]
				let sum = 0
				for (let k = 1; k <= factor; k++) {
					const t = k / factor
					sum += this._shape(previous + (current - previous) * t)
				}
				dst[i] = sum / factor
				previous = current
			}
			this._lasts[c] = previous
		}
	}
}

module.exports = { WaveShaperNode }
