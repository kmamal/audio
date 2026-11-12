const { AudioNode } = require('../audio-node')
const { AudioBuffer } = require('../audio-buffer')
const { notSupportedError } = require('../errors')
const { buildKernelSet, Kernel, Input, Convolution } = require('../dsp/convolution')
const { BlockAdapter, BLOCK } = require('../dsp/blocks')
const { applyChannelOptions, checkOptions } = require('./options')
const { created } = require('../remote/client')

const JOBS = {
	'1x1': [ [ 0, 0, 0 ] ],
	'1x2': [ [ 0, 0, 0 ], [ 0, 1, 1 ] ],
	'1x4': [ [ 0, 0, 0 ], [ 0, 1, 1 ], [ 0, 2, 0 ], [ 0, 3, 1 ] ],
	'2x1': [ [ 0, 0, 0 ], [ 1, 0, 1 ] ],
	'2x2': [ [ 0, 0, 0 ], [ 1, 1, 1 ] ],
	'2x4': [ [ 0, 0, 0 ], [ 0, 1, 1 ], [ 1, 2, 0 ], [ 1, 3, 1 ] ],
}

class ConvolverNode extends AudioNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'ConvolverNode')
		super(context, { channelCountMode: 'clamped-max' })

		this._buffer = null
		this._normalize = true
		this._kernels = null
		this._inputs2 = []
		this._convolutions = []
		this._jobs = null
		this._tailBlocks = 0
		this._silence0 = new Float32Array(BLOCK)
		this._adapter = new BlockAdapter(context._quantum)

		applyChannelOptions(this, options)
		if (options.disableNormalization !== undefined) { this._normalize = !options.disableNormalization }
		created(context, this, 'ConvolverNode', [ context, rawOptions === undefined ? undefined : { ...rawOptions, buffer: undefined } ])
		if (options.buffer !== undefined) { this.buffer = options.buffer }
	}

	_setChannelCount (count) {
		if (count > 2) { throw notSupportedError("ConvolverNode channelCount must be 1 or 2") }
		this._channelCount = count
	}

	_setChannelCountMode (mode) {
		if (mode === 'max') { throw notSupportedError("ConvolverNode does not support channelCountMode 'max'") }
		this._channelCountMode = mode
	}

	_tailFrames () { return this._kernels === null ? 0 : this._kernels[0].length }

	get normalize () { return this._normalize }
	set normalize (value) { this._normalize = Boolean(value) }

	get buffer () { return this._buffer }
	set buffer (buffer) {
		if (buffer === null) {
			this._buffer = null
			this._sendKernels(null)
			return
		}
		if (!(buffer instanceof AudioBuffer)) { throw new TypeError("buffer must be an AudioBuffer or null") }
		if (buffer.sampleRate !== this._context.sampleRate) { throw notSupportedError("the buffer sampleRate must match the context sampleRate") }
		const channels = buffer.numberOfChannels
		if (channels !== 1 && channels !== 2 && channels !== 4) { throw notSupportedError("the buffer must have 1, 2 or 4 channels") }

		this._buffer = buffer
		const content = buffer._content()
		this._sendKernels(content === null ? null : buildKernelSet(content, buffer.sampleRate, this._normalize, this._context._remote !== null))
	}

	_sendKernels (parts) {
		const remote = this._context._remote
		if (remote !== null) { remote.send(this, '_useKernels', [ parts ]) }
		else { this._useKernels(parts) }
	}

	_useKernels (parts) {
		this._kernels = parts === null ? null : parts.map((part) => new Kernel(part))
		this._inputs2 = []
		this._convolutions = []
		this._jobs = null
		this._tailBlocks = 0
	}

	_process (inputs) {
		const input = inputs[0]
		const kernels = this._kernels

		if (kernels === null) {
			this._silence(0, input.length)
			return
		}

		const kernelCount = kernels.length
		const stages = kernels[0].stages
		const speakers = this._channelInterpretation === 'speakers'
		const tail = Math.ceil(kernels[0].length / this._context._quantum) + 1

		if (input.length >= this._inputs2.length) { this._tailBlocks = 0 }
		else if (++this._tailBlocks > tail) {
			this._inputs2.length = input.length
			this._convolutions = []
			this._jobs = null
		}

		while (this._inputs2.length < input.length) {
			const previous = this._inputs2[0]
			this._inputs2.push(speakers && previous !== undefined && this._inputs2.length === 1 ? previous.clone() : new Input(stages))
			this._convolutions = []
			this._jobs = null
		}

		const inputCount = this._inputs2.length
		const outputCount = kernelCount === 1 && inputCount === 1 ? 1 : 2
		const out = this._silence(0, outputCount)

		const jobs = JOBS[`${inputCount}x${kernelCount}`]
		if (this._jobs !== jobs) {
			this._jobs = jobs
			this._convolutions = jobs.map(([ inputIndex, kernelIndex ]) => {
				const convolution = new Convolution(stages)
				convolution.setKernel(kernels[kernelIndex], this._inputs2[inputIndex])
				return convolution
			})
		}

		this._speakers = speakers
		this._adapter.process(input, out, this._convolveBlock ??= (blockInputs, blockOutputs) => { this._convolve(blockInputs, blockOutputs) })
	}

	_convolve (blockInputs, blockOutputs) {
		const inputCount = this._inputs2.length
		const jobs = this._jobs
		for (let c = 0; c < inputCount; c++) {
			const block = c < blockInputs.length ? blockInputs[c] : this._speakers && blockInputs.length === 1 ? blockInputs[0] : this._silence0
			this._inputs2[c].push(block)
		}
		for (let j = 0; j < jobs.length; j++) {
			const [ inputIndex, , outputIndex ] = jobs[j]
			this._convolutions[j].process(this._inputs2[inputIndex], blockOutputs[outputIndex])
		}
	}
}

module.exports = { ConvolverNode }
