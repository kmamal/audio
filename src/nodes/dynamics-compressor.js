const { AudioNode } = require('../audio-node')
const { AudioParam, defineParamAccessors } = require('../audio-param')
const { notSupportedError } = require('../errors')
const { sharedFloat32 } = require('../remote/shared')
const { applyChannelOptions, applyParamOptions, checkOptions } = require('./options')
const { created } = require('../remote/client')

const LOOKAHEAD_SECONDS = 0.006
const METER_RELEASE = 0.325

const dbToLinear = (db) => 10 ** (db / 20)
const linearToDb = (x) => x <= 0 ? -1000 : 20 * Math.log10(x)

class DynamicsCompressorNode extends AudioNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'DynamicsCompressorNode')
		super(context, { channelCountMode: 'clamped-max' })

		const param = (name, defaultValue, minValue, maxValue) => new AudioParam(context, {
			name: `DynamicsCompressorNode.${name}`, defaultValue, minValue, maxValue, automationRate: 'k-rate', fixedRate: true,
		})
		this._threshold = param('threshold', -24, -100, 0)
		this._knee = param('knee', 30, 0, 40)
		this._ratio = param('ratio', 12, 1, 20)
		this._attack = param('attack', 0.003, 0, 1)
		this._release = param('release', 0.25, 0, 1)

		this._shared = sharedFloat32(1)
		this._envelopeDb = 0
		this._lookahead = Math.round(LOOKAHEAD_SECONDS * context.sampleRate)
		this._delays = []
		this._delayIndex = 0

		applyChannelOptions(this, options)
		applyParamOptions(this, options, [ 'threshold', 'knee', 'ratio', 'attack', 'release' ])
		created(context, this, 'DynamicsCompressorNode', [ context, rawOptions ])
	}

	get reduction () { return this._shared[0] }

	get _reduction () { return this._shared[0] }
	set _reduction (value) { this._shared[0] = value }

	_adoptShared (shared) { this._shared = shared }

	_setChannelCount (count) {
		if (count > 2) { throw notSupportedError("DynamicsCompressorNode channelCount must be 1 or 2") }
		this._channelCount = count
	}

	_setChannelCountMode (mode) {
		if (mode === 'max') { throw notSupportedError("DynamicsCompressorNode does not support channelCountMode 'max'") }
		this._channelCountMode = mode
	}

	_tailFrames () { return this._lookahead + this.release.value * this._context.sampleRate }

	_gainReductionDb (levelDb, threshold, knee, ratio) {
		const lower = threshold - knee / 2
		const upper = threshold + knee / 2
		if (levelDb <= lower) { return 0 }
		if (levelDb >= upper || knee === 0) { return (threshold - levelDb) * (1 - 1 / ratio) }
		const x = levelDb - lower
		return -((1 - 1 / ratio) * x * x) / (2 * knee)
	}

	_process (inputs) {
		const context = this._context
		const N = context._quantum
		const input = inputs[0]
		const count = input.length
		const out = this._setOutputChannels(0, count)
		const sampleRate = context.sampleRate

		const threshold = this.threshold._block()[0]
		const knee = this.knee._block()[0]
		const ratio = this.ratio._block()[0]
		const attack = this.attack._block()[0]
		const release = this.release._block()[0]

		const attackCoef = attack <= 0 ? 0 : Math.exp(-1 / (attack * sampleRate))
		const releaseCoef = release <= 0 ? 0 : Math.exp(-1 / (release * sampleRate))
		const meterCoef = Math.exp(-1 / (METER_RELEASE * sampleRate))

		const fullRangeReduction = this._gainReductionDb(0, threshold, knee, ratio)
		const makeup = dbToLinear(-fullRangeReduction) ** 0.6

		const lookahead = this._lookahead
		const size = lookahead + 1
		while (this._delays.length < count) { this._delays.push(new Float32Array(size)) }
		if (this._delays.length > count) { this._delays.length = count }

		let envelope = this._envelopeDb
		let meter = this._reduction
		let index = this._delayIndex

		for (let i = 0; i < N; i++) {
			let peak = 0
			for (let c = 0; c < count; c++) {
				const v = Math.abs(input[c][i])
				if (v > peak) { peak = v }
			}

			const levelDb = linearToDb(peak)
			const desired = this._gainReductionDb(levelDb, threshold, knee, ratio)
			const coef = desired < envelope ? attackCoef : releaseCoef
			envelope = desired + (envelope - desired) * coef
			if (envelope > 0) { envelope = 0 }

			meter = envelope < meter ? envelope : meter + (envelope - meter) * (1 - meterCoef)

			const gain = dbToLinear(envelope) * makeup
			const readIndex = (index + 1) % size

			for (let c = 0; c < count; c++) {
				const line = this._delays[c]
				line[index] = input[c][i]
				out[c][i] = line[readIndex] * gain
			}

			index = readIndex
		}

		this._envelopeDb = envelope
		this._reduction = meter
		this._delayIndex = index
	}
}

defineParamAccessors(DynamicsCompressorNode, [ 'threshold', 'knee', 'ratio', 'attack', 'release' ])

module.exports = { DynamicsCompressorNode }
