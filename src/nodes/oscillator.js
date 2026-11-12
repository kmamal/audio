const { AudioScheduledSourceNode } = require('./scheduled-source')
const { AudioParam, defineParamAccessors } = require('../audio-param')
const { PeriodicWave, TABLE_SIZE, NUM_TABLES } = require('../periodic-wave')
const { invalidStateError, checkEnum, isEnum } = require('../errors')
const { applyChannelOptions, applyParamOptions, checkOptions } = require('./options')
const { created } = require('../remote/client')

const TYPES = [ 'sine', 'square', 'sawtooth', 'triangle', 'custom' ]

const selectTable = (sel, tables, hz, nyquist) => {
	sel.f = hz
	const absF = Math.abs(hz)
	sel.silent = absF >= nyquist || absF === 0
	if (sel.silent) { return }
	const level = Math.min(Math.log2(nyquist / absF), NUM_TABLES - 1)
	const lower = Math.floor(level)
	sel.blend = level - lower
	sel.a = tables[lower]
	sel.b = sel.blend > 0 && lower + 1 < NUM_TABLES ? tables[lower + 1] : null
}

class OscillatorNode extends AudioScheduledSourceNode {
	constructor (context, rawOptions) {
		const options = checkOptions(rawOptions, 'OscillatorNode')
		super(context)

		const nyquist = context.sampleRate / 2
		this._frequency = new AudioParam(context, { name: 'OscillatorNode.frequency', defaultValue: 440, minValue: -nyquist, maxValue: nyquist })
		this._detune = new AudioParam(context, { name: 'OscillatorNode.detune', defaultValue: 0, minValue: -153600, maxValue: 153600 })

		this._type = 'sine'
		this._wave = null
		this._phase = 0
		this._selection = { f: 0, blend: 0, a: null, b: null, silent: false }

		applyChannelOptions(this, options)
		applyParamOptions(this, options, [ 'frequency', 'detune' ])

		if (options.periodicWave !== undefined) { this.setPeriodicWave(options.periodicWave) }
		else if (options.type !== undefined) { this.type = checkEnum(options.type, TYPES, 'type') }
		created(context, this, 'OscillatorNode', [ context, rawOptions ])
	}

	get type () { return this._type }
	set type (type) {
		if (!isEnum(type, TYPES)) { return }
		if (type === 'custom') { throw invalidStateError("type 'custom' can only be set via setPeriodicWave()") }
		this._type = type
		this._wave = type === 'sine' ? null : PeriodicWave._basic(type)
		if (this._wave !== null) { this._context._prepareWave(type, this._wave) }
	}

	setPeriodicWave (wave) {
		if (!(wave instanceof PeriodicWave)) { throw new TypeError("setPeriodicWave() needs a PeriodicWave") }
		this._type = 'custom'
		this._wave = wave
	}

	_process () {
		const context = this._context
		const N = context._quantum
		const out = this._silence(0, 1)[0]

		if (!this._started || this._ended) { return }

		const blockStart = context._frame
		const blockEnd = blockStart + N
		if (this._startFrame >= blockEnd) { return }
		if (this._stopFrame <= blockStart || this._stopFrame <= this._startFrame) {
			this._finish()
			return
		}

		const sampleRate = context.sampleRate
		const nyquist = sampleRate / 2
		const frequency = this.frequency._block()
		const detune = this.detune._block()
		const detuneConstant = this.detune._isConstant()
		const detuneScale = 2 ** (detune[0] / 1200)
		const first = Math.max(Math.ceil(this._startFrame - blockStart), 0)
		const wave = this._wave
		const tables = wave === null ? null : wave._getTables()
		const constant = detuneConstant && this.frequency._isConstant()

		let phase = this._phase
		let end = N
		if (this._stopFrame < blockEnd) {
			end = Math.max(Math.ceil(this._stopFrame - blockStart), first)
			this._finish()
		}

		if (tables === null) {
			if (constant) {
				const hz = frequency[0] * detuneScale
				const audible = Math.abs(hz) < nyquist
				const step = hz / sampleRate
				for (let i = first; i < end; i++) {
					out[i] = audible ? Math.sin(2 * Math.PI * phase) : 0
					phase += step
					phase -= Math.floor(phase)
				}
			}
			else {
				for (let i = first; i < end; i++) {
					const hz = frequency[i] * (detuneConstant ? detuneScale : 2 ** (detune[i] / 1200))
					out[i] = Math.abs(hz) < nyquist ? Math.sin(2 * Math.PI * phase) : 0
					phase += hz / sampleRate
					phase -= Math.floor(phase)
				}
			}
			this._phase = phase
			return
		}

		const sel = this._selection
		if (constant) { selectTable(sel, tables, frequency[0] * detuneScale, nyquist) }

		for (let i = first; i < end; i++) {
			if (!constant) { selectTable(sel, tables, frequency[i] * (detuneConstant ? detuneScale : 2 ** (detune[i] / 1200)), nyquist) }

			if (sel.silent) {
				out[i] = 0
			}
			else {
				const a = sel.a
				const b = sel.b
				const p = phase * TABLE_SIZE
				const p0 = Math.floor(p)
				const i0 = p0 % TABLE_SIZE
				const i1 = (i0 + 1) % TABLE_SIZE
				const frac = p - p0
				const va = a[i0] + (a[i1] - a[i0]) * frac
				if (b !== null) {
					const vb = b[i0] + (b[i1] - b[i0]) * frac
					out[i] = va + (vb - va) * sel.blend
				}
				else {
					out[i] = va
				}
			}

			phase += sel.f / sampleRate
			phase -= Math.floor(phase)
		}

		this._phase = phase
	}
}

defineParamAccessors(OscillatorNode, [ 'frequency', 'detune' ])

module.exports = { OscillatorNode }
