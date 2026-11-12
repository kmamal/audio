const { RENDER_QUANTUM: N } = require('../constants')
const { rfft, irfft } = require('./fft')
const { sharedFloat32 } = require('../remote/shared')

const MAX_BLOCK = 4096
const FIRST_PARTITIONS = 2
const GAIN_CALIBRATION = 0.00125
const GAIN_CALIBRATION_SAMPLE_RATE = 44100
const MIN_POWER = 0.000125

const normalizationScale = (channels, sampleRate) => {
	let sum = 0
	let total = 0
	for (const data of channels) {
		for (let i = 0; i < data.length; i++) { sum += data[i] * data[i] }
		total += data.length
	}
	let power = Math.sqrt(sum / total)
	if (!Number.isFinite(power) || power < MIN_POWER) { power = MIN_POWER }
	let scale = 1 / power
	scale *= GAIN_CALIBRATION
	scale *= Math.sqrt(GAIN_CALIBRATION_SAMPLE_RATE / sampleRate)
	if (channels.length === 4) { scale *= 0.5 }
	return scale
}

const planStages = (length) => {
	const stages = []
	let offset = 0
	let block = N
	let partitions = FIRST_PARTITIONS
	while (offset < length) {
		const remaining = Math.ceil((length - offset) / block)
		const count = block < MAX_BLOCK ? Math.min(partitions, remaining) : remaining
		stages.push({ block, offset, partitions: count })
		offset += block * count
		block = Math.min(block * 2, MAX_BLOCK)
		partitions = 1
	}
	return stages
}

const scratches = new Map()

const getScratch = (size) => {
	let scratch = scratches.get(size)
	if (!scratch) {
		scratch = {
			re: new Float64Array(size),
			accRe: new Float64Array(size / 2 + 1),
			accIm: new Float64Array(size / 2 + 1),
		}
		scratches.set(size, scratch)
	}
	return scratch
}

const buildKernelParts = (data, scale = 1, shared = false) => {
	const stages = planStages(data.length)
	const make = shared ? sharedFloat32 : (length) => new Float32Array(length)
	const re = new Array(stages.length)
	const im = new Array(stages.length)
	for (let k = 0; k < stages.length; k++) {
		const { block, offset, partitions } = stages[k]
		const size = 2 * block
		const scratch = getScratch(size)
		re[k] = new Array(partitions)
		im[k] = new Array(partitions)
		for (let p = 0; p < partitions; p++) {
			scratch.re.fill(0)
			const start = offset + p * block
			const end = Math.min(start + block, data.length)
			for (let i = start; i < end; i++) { scratch.re[i - start] = data[i] * scale }
			re[k][p] = make(block + 1)
			im[k][p] = make(block + 1)
			rfft(scratch.re, re[k][p], im[k][p])
		}
	}
	return { length: data.length, stages, re, im }
}

const buildKernelSet = (channels, sampleRate, normalize, shared) => {
	const scale = normalize ? normalizationScale(channels, sampleRate) : 1
	return channels.map((data) => buildKernelParts(data, scale, shared))
}

class Kernel {
	constructor (parts) {
		this.length = parts.length
		this.stages = parts.stages
		this.re = parts.re
		this.im = parts.im
	}

	static fromData (data, scale = 1) {
		return new Kernel(buildKernelParts(data, scale))
	}
}

class Input {
	constructor (stages) {
		this.stages = stages
		this.frame = 0
		const largest = stages.length > 0 ? stages[stages.length - 1].block : N
		this.size = 2 * largest
		this.history = new Float32Array(this.size)
		this.position = 0
		this.spectra = stages.map(({ block, partitions }) => {
			const count = partitions + 1
			const re = new Array(count)
			const im = new Array(count)
			for (let i = 0; i < count; i++) {
				re[i] = new Float32Array(block + 1)
				im[i] = new Float32Array(block + 1)
			}
			return { re, im, head: 0, count }
		})
	}

	clone () {
		const copy = new Input(this.stages)
		copy.frame = this.frame
		copy.history.set(this.history)
		copy.position = this.position
		for (let k = 0; k < this.spectra.length; k++) {
			const from = this.spectra[k]
			const to = copy.spectra[k]
			to.head = from.head
			for (let i = 0; i < from.count; i++) {
				to.re[i].set(from.re[i])
				to.im[i].set(from.im[i])
			}
		}
		return copy
	}

	push (block) {
		const history = this.history
		const size = this.size
		let position = this.position
		for (let i = 0; i < N; i++) {
			history[position] = block[i]
			position = (position + 1) % size
		}
		this.position = position
		this.frame += N

		for (let k = 0; k < this.stages.length; k++) {
			const { block: B } = this.stages[k]
			if (this.frame % B !== 0) { continue }
			const window = 2 * B
			const scratch = getScratch(window)
			const re = scratch.re
			let from = (position - window + size) % size
			for (let i = 0; i < window; i++) {
				re[i] = history[from]
				from = (from + 1) % size
			}
			const ring = this.spectra[k]
			ring.head = (ring.head + ring.count - 1) % ring.count
			rfft(re, ring.re[ring.head], ring.im[ring.head])
		}
	}
}

class Convolution {
	constructor (stages) {
		this.stages = stages
		this.kernel = null
		this.outputs = stages.map(({ block }) => ({ buffer: new Float32Array(block), start: -1 }))
	}

	setKernel (kernel, input) {
		this.kernel = kernel
		if (kernel === null) { return }
		const frame = input.frame
		for (let k = 0; k < this.stages.length; k++) {
			const { block: B, offset } = this.stages[k]
			if (offset === 0) {
				this._compute(k, input, 0, frame - N)
				continue
			}
			const t = frame - N
			const start = Math.floor(t / B) * B
			const latest = Math.floor(frame / B) * B
			this._compute(k, input, latest === start ? 0 : 1, start)
		}
	}

	_compute (k, input, shift, start) {
		const { block: B, partitions } = this.stages[k]
		const size = 2 * B
		const scratch = getScratch(size)
		const accRe = scratch.accRe
		const accIm = scratch.accIm
		accRe.fill(0)
		accIm.fill(0)
		const ring = input.spectra[k]
		const kre = this.kernel.re[k]
		const kim = this.kernel.im[k]
		const bins = B + 1

		for (let p = 0; p < partitions; p++) {
			const index = (ring.head + shift + p) % ring.count
			const xr = ring.re[index]
			const xi = ring.im[index]
			const hr = kre[p]
			const hi = kim[p]
			for (let b = 0; b < bins; b++) {
				accRe[b] += xr[b] * hr[b] - xi[b] * hi[b]
				accIm[b] += xr[b] * hi[b] + xi[b] * hr[b]
			}
		}

		const re = scratch.re
		irfft(accRe, accIm, re)

		const output = this.outputs[k]
		output.buffer.set(re.subarray(B, size))
		output.start = start
	}

	process (input, out) {
		if (this.kernel === null) { return }
		const frame = input.frame
		const t = frame - N

		for (let k = 0; k < this.stages.length; k++) {
			if (this.stages[k].offset === 0) { this._compute(k, input, 0, t) }
		}

		for (let k = 0; k < this.stages.length; k++) {
			const output = this.outputs[k]
			const offset = t - output.start
			if (offset < 0 || offset >= this.stages[k].block) { continue }
			const buffer = output.buffer
			for (let i = 0; i < N; i++) { out[i] += buffer[offset + i] }
		}

		for (let k = 0; k < this.stages.length; k++) {
			const { block: B, offset } = this.stages[k]
			if (offset === 0 || frame % B !== 0) { continue }
			this._compute(k, input, 0, frame)
		}
	}
}

module.exports = { planStages, buildKernelParts, buildKernelSet, normalizationScale, Kernel, Input, Convolution }
