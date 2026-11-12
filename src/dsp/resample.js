
const { MAX_BUFFER_LENGTH } = require('../constants')

const HALF_TAPS = 16
const TAPS = HALF_TAPS * 2
const PHASES = 256

const kernels = new Map()

const sinc = (x) => x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)

const window = (x) => {
	if (x <= -1 || x >= 1) { return 0 }
	const t = (x + 1) / 2
	return 0.35875 - 0.48829 * Math.cos(2 * Math.PI * t) + 0.14128 * Math.cos(4 * Math.PI * t) - 0.01168 * Math.cos(6 * Math.PI * t)
}

const getKernel = (cutoff) => {
	const key = cutoff.toFixed(6)
	let kernel = kernels.get(key)
	if (kernel) { return kernel }

	kernel = new Float32Array((PHASES + 1) * TAPS)
	for (let p = 0; p <= PHASES; p++) {
		const frac = p / PHASES
		let sum = 0
		for (let k = 0; k < TAPS; k++) {
			const x = (k - HALF_TAPS + 1) - frac
			const value = sinc(x * cutoff) * cutoff * window(x / HALF_TAPS)
			kernel[p * TAPS + k] = value
			sum += value
		}
		for (let k = 0; k < TAPS; k++) { kernel[p * TAPS + k] /= sum }
	}

	kernels.set(key, kernel)
	return kernel
}

const resampleChannel = (source, from, to) => {
	const ratio = from / to
	const length = Math.max(1, Math.round(source.length * to / from))
	const out = new Float32Array(length)
	const cutoff = Math.min(1, to / from)
	const kernel = getKernel(cutoff)
	const n = source.length

	for (let i = 0; i < length; i++) {
		const position = i * ratio
		const i0 = Math.floor(position)
		const frac = position - i0
		const phase = frac * PHASES
		const p0 = Math.floor(phase)
		const pf = phase - p0
		const base0 = p0 * TAPS
		const base1 = base0 + TAPS

		let sum = 0
		for (let k = 0; k < TAPS; k++) {
			const j = i0 + k - HALF_TAPS + 1
			if (j < 0 || j >= n) { continue }
			const w = kernel[base0 + k] + (kernel[base1 + k] - kernel[base0 + k]) * pf
			sum += source[j] * w
		}
		out[i] = sum
	}

	return out
}

const resample = (channelData, from, to) => {
	if (from === to) { return channelData }
	if (channelData.length > 0 && Math.round(channelData[0].length * to / from) > MAX_BUFFER_LENGTH) {
		throw new Error(`the resampled length exceeds the maximum AudioBuffer length of ${MAX_BUFFER_LENGTH}`)
	}
	return channelData.map((channel) => resampleChannel(channel, from, to))
}

module.exports = { resample, resampleChannel }
