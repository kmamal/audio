const { AudioNode } = require('../audio-node')
const { AudioParam, defineParamAccessors } = require('../audio-param')
const { checkEnum, isEnum, invalidAccessError } = require('../errors')
const { applyChannelOptions, applyParamOptions, checkOptions } = require('./options')
const { created } = require('../remote/client')

const TYPES = [ 'lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass' ]

const coefficients = (type, frequency, Q, gain, sampleRate, out) => {
	const nyquist = sampleRate / 2
	const cutoff = Math.min(Math.max(frequency / nyquist, 0), 1)
	const A = 10 ** (gain / 40)

	let b0 = 1
	let b1 = 0
	let b2 = 0
	let a0 = 1
	let a1 = 0
	let a2 = 0

	const w0 = Math.PI * cutoff
	const cos = Math.cos(w0)
	const sin = Math.sin(w0)

	switch (type) {
		case 'lowpass': {
			if (cutoff >= 1) { break }
			if (cutoff <= 0) {
				b0 = 0
				break
			}
			const g = 10 ** (Q / 20)
			const alpha = sin / (2 * g)
			b0 = (1 - cos) / 2
			b1 = 1 - cos
			b2 = b0
			a0 = 1 + alpha
			a1 = -2 * cos
			a2 = 1 - alpha
		} break

		case 'highpass': {
			if (cutoff >= 1) {
				b0 = 0
				break
			}
			if (cutoff <= 0) { break }
			const g = 10 ** (Q / 20)
			const alpha = sin / (2 * g)
			b0 = (1 + cos) / 2
			b1 = -(1 + cos)
			b2 = b0
			a0 = 1 + alpha
			a1 = -2 * cos
			a2 = 1 - alpha
		} break

		case 'bandpass': {
			if (cutoff <= 0 || cutoff >= 1) {
				b0 = 0
				break
			}
			if (Q <= 0) { break }
			const alpha = sin / (2 * Q)
			b0 = alpha
			b1 = 0
			b2 = -alpha
			a0 = 1 + alpha
			a1 = -2 * cos
			a2 = 1 - alpha
		} break

		case 'notch': {
			if (cutoff <= 0 || cutoff >= 1) { break }
			if (Q <= 0) {
				b0 = 0
				break
			}
			const alpha = sin / (2 * Q)
			b0 = 1
			b1 = -2 * cos
			b2 = 1
			a0 = 1 + alpha
			a1 = -2 * cos
			a2 = 1 - alpha
		} break

		case 'allpass': {
			if (cutoff <= 0 || cutoff >= 1) { break }
			if (Q <= 0) {
				b0 = -1
				break
			}
			const alpha = sin / (2 * Q)
			b0 = 1 - alpha
			b1 = -2 * cos
			b2 = 1 + alpha
			a0 = 1 + alpha
			a1 = -2 * cos
			a2 = 1 - alpha
		} break

		case 'peaking': {
			if (cutoff <= 0 || cutoff >= 1) { break }
			if (Q <= 0) {
				b0 = A * A
				break
			}
			const alpha = sin / (2 * Q)
			b0 = 1 + alpha * A
			b1 = -2 * cos
			b2 = 1 - alpha * A
			a0 = 1 + alpha / A
			a1 = -2 * cos
			a2 = 1 - alpha / A
		} break

		case 'lowshelf': {
			if (cutoff >= 1) {
				b0 = A * A
				break
			}
			if (cutoff <= 0) { break }
			const alpha = (sin / 2) * Math.SQRT2
			const k = 2 * Math.sqrt(A) * alpha
			b0 = A * ((A + 1) - (A - 1) * cos + k)
			b1 = 2 * A * ((A - 1) - (A + 1) * cos)
			b2 = A * ((A + 1) - (A - 1) * cos - k)
			a0 = (A + 1) + (A - 1) * cos + k
			a1 = -2 * ((A - 1) + (A + 1) * cos)
			a2 = (A + 1) + (A - 1) * cos - k
		} break

		case 'highshelf': {
			if (cutoff >= 1) { break }
			if (cutoff <= 0) {
				b0 = A * A
				break
			}
			const alpha = (sin / 2) * Math.SQRT2
			const k = 2 * Math.sqrt(A) * alpha
			b0 = A * ((A + 1) + (A - 1) * cos + k)
			b1 = -2 * A * ((A - 1) + (A + 1) * cos)
			b2 = A * ((A + 1) + (A - 1) * cos - k)
			a0 = (A + 1) - (A - 1) * cos + k
			a1 = 2 * ((A - 1) - (A + 1) * cos)
			a2 = (A + 1) - (A - 1) * cos - k
		} break

		// No default
	}

	out[0] = b0 / a0
	out[1] = b1 / a0
	out[2] = b2 / a0
	out[3] = a1 / a0
	out[4] = a2 / a0
	return out
}

class BiquadFilterNode extends AudioNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'BiquadFilterNode')
		super(context)

		const nyquist = context.sampleRate / 2
		this._frequency = new AudioParam(context, { name: 'BiquadFilterNode.frequency', defaultValue: 350, minValue: 0, maxValue: nyquist })
		this._detune = new AudioParam(context, { name: 'BiquadFilterNode.detune', defaultValue: 0, minValue: -153600, maxValue: 153600 })
		this._Q = new AudioParam(context, { name: 'BiquadFilterNode.Q', defaultValue: 1 })
		this._gain = new AudioParam(context, { name: 'BiquadFilterNode.gain', defaultValue: 0, maxValue: 1541.273681640625 })

		this._type = 'lowpass'
		this._states = []
		this._coefficients = new Float64Array(5)
		this._table = new Float64Array(5 * context._quantum)

		applyChannelOptions(this, options)
		applyParamOptions(this, options, [ 'frequency', 'detune', 'Q', 'gain' ])
		if (options.type !== undefined) { this.type = checkEnum(options.type, TYPES, 'type') }
		created(context, this, 'BiquadFilterNode', [ context, rawOptions ])
	}

	get type () { return this._type }
	set type (type) {
		if (!isEnum(type, TYPES)) { return }
		this._type = type
	}

	_tailFrames () { return this._context.sampleRate * 0.2 }

	_process (inputs) {
		const input = inputs[0]
		const N = this._context._quantum
		const count = input.length
		const out = this._setOutputChannels(0, count)

		while (this._states.length < count) { this._states.push(new Float64Array(4)) }
		if (this._states.length > count) { this._states.length = count }

		const frequency = this.frequency._block()
		const detune = this.detune._block()
		const Q = this.Q._block()
		const gain = this.gain._block()
		const detuneConstant = this.detune._isConstant()
		const constant = detuneConstant && this.frequency._isConstant() && this.Q._isConstant() && this.gain._isConstant()

		const table = this._table
		const computed = this._coefficients
		const sampleRate = this._context.sampleRate
		const detuneScale = 2 ** (detune[0] / 1200)
		if (constant) {
			coefficients(this._type, frequency[0] * detuneScale, Q[0], gain[0], sampleRate, computed)
			table.set(computed, 0)
		}
		else {
			let lastF = NaN
			let lastD = NaN
			let lastQ = NaN
			let lastG = NaN
			for (let i = 0; i < N; i++) {
				const f = frequency[i]
				const d = detune[i]
				const q = Q[i]
				const g = gain[i]
				if (f !== lastF || d !== lastD || q !== lastQ || g !== lastG) {
					coefficients(this._type, f * (detuneConstant ? detuneScale : 2 ** (d / 1200)), q, g, sampleRate, computed)
					lastF = f
					lastD = d
					lastQ = q
					lastG = g
				}
				const k = i * 5
				table[k] = computed[0]
				table[k + 1] = computed[1]
				table[k + 2] = computed[2]
				table[k + 3] = computed[3]
				table[k + 4] = computed[4]
			}
		}

		for (let c = 0; c < count; c++) {
			const src = input[c]
			const dst = out[c]
			const state = this._states[c]
			let x1 = state[0]
			let x2 = state[1]
			let y1 = state[2]
			let y2 = state[3]
			let b0 = table[0]
			let b1 = table[1]
			let b2 = table[2]
			let a1 = table[3]
			let a2 = table[4]

			for (let i = 0; i < N; i++) {
				if (!constant) {
					const k = i * 5
					b0 = table[k]
					b1 = table[k + 1]
					b2 = table[k + 2]
					a1 = table[k + 3]
					a2 = table[k + 4]
				}
				const x = src[i]
				const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
				x2 = x1
				x1 = x
				y2 = y1
				y1 = y
				dst[i] = y
			}

			if (!Number.isFinite(y1) || !Number.isFinite(y2)) {
				y1 = 0
				y2 = 0
			}
			state[0] = x1
			state[1] = x2
			state[2] = y1
			state[3] = y2
		}
	}

	getFrequencyResponse (frequencyHz, magResponse, phaseResponse) {
		if (!(frequencyHz instanceof Float32Array) || !(magResponse instanceof Float32Array) || !(phaseResponse instanceof Float32Array)) {
			throw new TypeError("getFrequencyResponse() arguments must be Float32Arrays")
		}
		if (frequencyHz.length !== magResponse.length || frequencyHz.length !== phaseResponse.length) {
			throw invalidAccessError("getFrequencyResponse() arrays must have the same length")
		}

		const sampleRate = this._context.sampleRate
		const nyquist = sampleRate / 2
		const f = this.frequency.value * (2 ** (this.detune.value / 1200))
		const [ b0, b1, b2, a1, a2 ] = coefficients(this._type, f, this.Q.value, this.gain.value, sampleRate, this._coefficients)

		for (let i = 0; i < frequencyHz.length; i++) {
			const hz = frequencyHz[i]
			if (hz < 0 || hz > nyquist) {
				magResponse[i] = NaN
				phaseResponse[i] = NaN
				continue
			}
			const w = Math.PI * hz / nyquist
			const c1 = Math.cos(w)
			const s1 = Math.sin(w)
			const c2 = Math.cos(2 * w)
			const s2 = Math.sin(2 * w)
			const nr = b0 + b1 * c1 + b2 * c2
			const ni = -(b1 * s1 + b2 * s2)
			const dr = 1 + a1 * c1 + a2 * c2
			const di = -(a1 * s1 + a2 * s2)
			const d = dr * dr + di * di
			const re = (nr * dr + ni * di) / d
			const im = (ni * dr - nr * di) / d
			magResponse[i] = Math.hypot(re, im)
			phaseResponse[i] = Math.atan2(im, re)
		}
	}
}

defineParamAccessors(BiquadFilterNode, [ 'frequency', 'detune', 'Q', 'gain' ])

module.exports = { BiquadFilterNode, coefficients }
