const { AudioNode } = require('../audio-node')
const { notSupportedError, invalidStateError, invalidAccessError } = require('../errors')
const { applyChannelOptions, checkOptions } = require('./options')
const { created } = require('../remote/client')

const MAX_ORDER = 20

const checkCoefficients = (values, name) => {
	if (!values || typeof values.length !== 'number') { throw new TypeError(`${name} must be a sequence of numbers`) }
	if (values.length === 0 || values.length > MAX_ORDER) { throw notSupportedError(`${name} must have between 1 and ${MAX_ORDER} elements`) }
	const out = Float64Array.from(values, Number)
	for (const value of out) {
		if (!Number.isFinite(value)) { throw new TypeError(`${name} must contain finite numbers`) }
	}
	return out
}

class IIRFilterNode extends AudioNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'IIRFilterNode')
		super(context)

		const feedforward = checkCoefficients(options.feedforward, 'feedforward')
		const feedback = checkCoefficients(options.feedback, 'feedback')
		if (feedback[0] === 0) { throw invalidStateError("the first feedback coefficient must not be zero") }
		if (feedforward.every((x) => x === 0)) { throw invalidStateError("at least one feedforward coefficient must be non-zero") }

		const a0 = feedback[0]
		this._b = feedforward.map((x) => x / a0)
		this._a = feedback.map((x) => x / a0)
		this._order = Math.max(this._b.length, this._a.length)
		this._states = []

		applyChannelOptions(this, options)
		created(context, this, 'IIRFilterNode', [ context, rawOptions ])
	}

	_tailFrames () { return this._context.sampleRate * 0.2 }

	_process (inputs) {
		const input = inputs[0]
		const N = this._context._quantum
		const count = input.length
		const out = this._setOutputChannels(0, count)
		const order = this._order
		const b = this._b
		const a = this._a

		while (this._states.length < count) { this._states.push({ x: new Float64Array(order), y: new Float64Array(order), index: 0 }) }
		if (this._states.length > count) { this._states.length = count }

		for (let c = 0; c < count; c++) {
			const src = input[c]
			const dst = out[c]
			const state = this._states[c]
			const xs = state.x
			const ys = state.y
			let index = state.index

			for (let i = 0; i < N; i++) {
				xs[index] = src[i]
				let y = 0
				for (let k = 0; k < b.length; k++) {
					y += b[k] * xs[(index - k + order) % order]
				}
				for (let k = 1; k < a.length; k++) {
					y -= a[k] * ys[(index - k + order) % order]
				}
				if (!Number.isFinite(y)) { y = 0 }
				ys[index] = y
				dst[i] = y
				index = (index + 1) % order
			}

			state.index = index
		}
	}

	getFrequencyResponse (frequencyHz, magResponse, phaseResponse) {
		if (!(frequencyHz instanceof Float32Array) || !(magResponse instanceof Float32Array) || !(phaseResponse instanceof Float32Array)) {
			throw new TypeError("getFrequencyResponse() arguments must be Float32Arrays")
		}
		if (frequencyHz.length !== magResponse.length || frequencyHz.length !== phaseResponse.length) {
			throw invalidAccessError("getFrequencyResponse() arrays must have the same length")
		}

		const nyquist = this._context.sampleRate / 2
		const b = this._b
		const a = this._a

		for (let i = 0; i < frequencyHz.length; i++) {
			const hz = frequencyHz[i]
			if (hz < 0 || hz > nyquist) {
				magResponse[i] = NaN
				phaseResponse[i] = NaN
				continue
			}
			const w = Math.PI * hz / nyquist
			let nr = 0
			let ni = 0
			for (let k = 0; k < b.length; k++) {
				nr += b[k] * Math.cos(k * w)
				ni -= b[k] * Math.sin(k * w)
			}
			let dr = 0
			let di = 0
			for (let k = 0; k < a.length; k++) {
				dr += a[k] * Math.cos(k * w)
				di -= a[k] * Math.sin(k * w)
			}
			const d = dr * dr + di * di
			const re = (nr * dr + ni * di) / d
			const im = (ni * dr - nr * di) / d
			magResponse[i] = Math.hypot(re, im)
			phaseResponse[i] = Math.atan2(im, re)
		}
	}
}

module.exports = { IIRFilterNode }
