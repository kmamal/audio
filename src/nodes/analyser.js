const { AudioNode } = require('../audio-node')
const { indexSizeError, checkFinite, toUnsignedLong } = require('../errors')
const { rfft } = require('../dsp/fft')
const { mixAdd } = require('../mixing')
const { applyChannelOptions, checkOptions } = require('./options')
const { created } = require('../remote/client')

const MIN_FFT = 32
const MAX_FFT = 32768

class AnalyserNode extends AudioNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'AnalyserNode')
		super(context)

		this._fftSize = 2048
		this._minDecibels = -100
		this._maxDecibels = -30
		this._smoothingTimeConstant = 0.8

		this._bindShared(new SharedArrayBuffer(MAX_FFT * 4 + 8))
		this._mono = [ new Float32Array(context._quantum) ]
		this._re = null
		this._im = null
		this._window = null
		this._smoothed = null
		this._spectrum = null
		this._samples = null
		this._spectrumBlock = -1

		context._addSideNode(this)

		applyChannelOptions(this, options)
		for (const key of [ 'fftSize', 'smoothingTimeConstant' ]) {
			if (options[key] !== undefined) { this[key] = options[key] }
		}
		if (options.minDecibels !== undefined) { this._minDecibels = checkFinite(options.minDecibels, 'minDecibels') }
		if (options.maxDecibels !== undefined) { this._maxDecibels = checkFinite(options.maxDecibels, 'maxDecibels') }
		if (this._minDecibels >= this._maxDecibels) { throw indexSizeError("minDecibels must be less than maxDecibels") }
		created(context, this, 'AnalyserNode', [ context, rawOptions ])
	}

	_bindShared (shared) {
		this._shared = shared
		this._history = new Float32Array(shared, 0, MAX_FFT)
		this._writtenCell = new Float64Array(shared, MAX_FFT * 4, 1)
	}

	_adoptShared (shared) { this._bindShared(shared) }

	get _written () { return this._writtenCell[0] }
	set _written (value) { this._writtenCell[0] = value }

	get fftSize () { return this._fftSize }
	set fftSize (rawValue) {
		const value = toUnsignedLong(rawValue)
		if (value < MIN_FFT || value > MAX_FFT || (value & (value - 1)) !== 0) {
			throw indexSizeError(`fftSize must be a power of two between ${MIN_FFT} and ${MAX_FFT}`)
		}
		if (value !== this._fftSize) {
			this._fftSize = value
			this._smoothed = null
			this._re = null
		}
	}

	get frequencyBinCount () { return this._fftSize / 2 }

	get minDecibels () { return this._minDecibels }
	set minDecibels (value) {
		const v = checkFinite(value, 'minDecibels')
		if (v >= this._maxDecibels) { throw indexSizeError("minDecibels must be less than maxDecibels") }
		this._minDecibels = v
	}

	get maxDecibels () { return this._maxDecibels }
	set maxDecibels (value) {
		const v = checkFinite(value, 'maxDecibels')
		if (v <= this._minDecibels) { throw indexSizeError("maxDecibels must be greater than minDecibels") }
		this._maxDecibels = v
	}

	get smoothingTimeConstant () { return this._smoothingTimeConstant }
	set smoothingTimeConstant (value) {
		const v = checkFinite(value, 'smoothingTimeConstant')
		if (v < 0 || v > 1) { throw indexSizeError("smoothingTimeConstant must be between 0 and 1") }
		this._smoothingTimeConstant = v
	}

	_process (inputs) {
		const input = inputs[0]
		const out = this._setOutputChannels(0, input.length)
		for (let c = 0; c < input.length; c++) { out[c].set(input[c]) }

		const mono = this._mono
		mono[0].fill(0)
		mixAdd(mono, input, 'speakers')

		const history = this._history
		const count = mono[0].length
		const src = count > MAX_FFT ? mono[0].subarray(count - MAX_FFT) : mono[0]
		const n = src.length
		const start = (this._written + count - n) % MAX_FFT
		const first = Math.min(n, MAX_FFT - start)
		history.set(src.subarray(0, first), start)
		if (first < n) { history.set(src.subarray(first), 0) }
		this._written += count
	}

	_latest (out) {
		const count = out.length
		const history = this._history
		let start = (this._written - count) % MAX_FFT
		if (start < 0) { start += MAX_FFT }
		const first = Math.min(count, MAX_FFT - start)
		out.set(history.subarray(start, start + first))
		if (first < count) { out.set(history.subarray(0, count - first), first) }
	}

	_ensureScratch () {
		const n = this._fftSize
		if (this._re !== null && this._windowed.length === n) { return }
		this._re = new Float64Array(n / 2 + 1)
		this._im = new Float64Array(n / 2 + 1)
		this._windowed = new Float64Array(n)
		this._window = new Float64Array(n)
		for (let i = 0; i < n; i++) {
			this._window[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / n) + 0.08 * Math.cos(4 * Math.PI * i / n)
		}
		this._spectrum = new Float32Array(n / 2)
		this._samples = new Float32Array(n)
	}

	_latestSamples () {
		this._ensureScratch()
		this._latest(this._samples)
		return this._samples
	}

	_computeSpectrum () {
		if (this._spectrumBlock === this._context._blockId && this._spectrum !== null && this._spectrum.length === this._fftSize / 2) {
			return this._spectrum
		}
		this._ensureScratch()
		this._spectrumBlock = this._context._blockId

		const n = this._fftSize
		const re = this._re
		const im = this._im
		const windowed = this._windowed
		const samples = this._latestSamples()

		for (let i = 0; i < n; i++) { windowed[i] = samples[i] * this._window[i] }
		rfft(windowed, re, im)

		const bins = n / 2
		const smoothing = this._smoothingTimeConstant
		if (this._smoothed === null || this._smoothed.length !== bins) { this._smoothed = new Float64Array(bins) }
		const smoothed = this._smoothed
		const spectrum = this._spectrum

		for (let k = 0; k < bins; k++) {
			const magnitude = Math.hypot(re[k], im[k]) / n
			let value = smoothing * smoothed[k] + (1 - smoothing) * magnitude
			if (!Number.isFinite(value)) { value = 0 }
			smoothed[k] = value
			spectrum[k] = value <= 0 ? -Infinity : 20 * Math.log10(value)
		}

		return spectrum
	}

	getFloatFrequencyData (array) {
		if (!(array instanceof Float32Array)) { throw new TypeError("array must be a Float32Array") }
		const spectrum = this._computeSpectrum()
		const count = Math.min(array.length, spectrum.length)
		for (let k = 0; k < count; k++) { array[k] = spectrum[k] }
	}

	getByteFrequencyData (array) {
		if (!(array instanceof Uint8Array)) { throw new TypeError("array must be a Uint8Array") }
		const spectrum = this._computeSpectrum()
		const count = Math.min(array.length, spectrum.length)
		const min = this._minDecibels
		const range = this._maxDecibels - min
		for (let k = 0; k < count; k++) {
			const scaled = Math.floor(255 * (spectrum[k] - min) / range)
			array[k] = scaled < 0 ? 0 : scaled > 255 ? 255 : scaled
		}
	}

	getFloatTimeDomainData (array) {
		if (!(array instanceof Float32Array)) { throw new TypeError("array must be a Float32Array") }
		const count = Math.min(array.length, this._fftSize)
		const samples = this._latestSamples()
		for (let i = 0; i < count; i++) { array[i] = samples[i] }
	}

	getByteTimeDomainData (array) {
		if (!(array instanceof Uint8Array)) { throw new TypeError("array must be a Uint8Array") }
		const count = Math.min(array.length, this._fftSize)
		const samples = this._latestSamples()
		for (let i = 0; i < count; i++) {
			const scaled = Math.floor(128 * (1 + samples[i]))
			array[i] = scaled < 0 ? 0 : scaled > 255 ? 255 : scaled
		}
	}
}

module.exports = { AnalyserNode }
