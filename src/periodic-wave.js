const { irfft } = require('./dsp/fft')
const { indexSizeError, checkFloat } = require('./errors')
const { created } = require('./remote/client')
const { sharedFloat32 } = require('./remote/shared')

const TABLE_SIZE = 4096
const MAX_PARTIALS = TABLE_SIZE / 2
const NUM_TABLES = Math.log2(MAX_PARTIALS) + 1

const basicCoefficients = (type, count) => {
	const real = new Float32Array(count)
	const imag = new Float32Array(count)
	for (let n = 1; n < count; n++) {
		switch (type) {
			case 'square': { imag[n] = (2 / (n * Math.PI)) * (1 - ((-1) ** n)) } break
			case 'sawtooth': { imag[n] = ((-1) ** (n + 1)) * 2 / (n * Math.PI) } break
			case 'triangle': { imag[n] = 8 * Math.sin(n * Math.PI / 2) / ((Math.PI * n) ** 2) } break
			default: { if (n === 1) { imag[n] = 1 } }
		}
	}
	return { real, imag }
}

const generateTables = (real, imag, normalize) => {
	const tables = new Array(NUM_TABLES)
	const re = new Float64Array(MAX_PARTIALS + 1)
	const im = new Float64Array(MAX_PARTIALS + 1)
	const out = new Float64Array(TABLE_SIZE)
	const available = Math.min(real.length, imag.length) - 1

	for (let t = 0; t < NUM_TABLES; t++) {
		const limit = Math.min(2 ** t, available)
		re.fill(0)
		im.fill(0)
		for (let k = 1; k <= limit; k++) {
			re[k] = real[k] * TABLE_SIZE / 2
			im[k] = -imag[k] * TABLE_SIZE / 2
		}
		irfft(re, im, out)
		tables[t] = sharedFloat32(TABLE_SIZE)
		tables[t].set(out)
	}

	if (normalize) {
		const full = tables[NUM_TABLES - 1]
		let max = 0
		for (let i = 0; i < TABLE_SIZE; i++) { max = Math.max(max, Math.abs(full[i])) }
		if (max > 0) {
			const scale = 1 / max
			for (const table of tables) {
				for (let i = 0; i < TABLE_SIZE; i++) { table[i] *= scale }
			}
		}
	}

	return tables
}

const basicWaves = new Map()

class PeriodicWave {
	constructor (context, options = {}, tables = null) {
		if (!context || typeof context.sampleRate !== 'number') { throw new TypeError("PeriodicWave needs a BaseAudioContext") }
		let { real, imag } = options
		const { disableNormalization = false } = options

		if (real === undefined && imag === undefined) {
			real = [ 0, 0 ]
			imag = [ 0, 1 ]
		}
		else if (real !== undefined && imag !== undefined) {
			if (real.length !== imag.length) { throw indexSizeError("real and imag must have the same length") }
		}
		else if (real === undefined) {
			real = new Float32Array(imag.length)
		}
		else {
			imag = new Float32Array(real.length)
		}

		if (real.length < 2) { throw indexSizeError("real and imag must have at least two elements") }

		this._real = Float32Array.from(real, (x) => checkFloat(x, 'real'))
		this._imag = Float32Array.from(imag, (x) => checkFloat(x, 'imag'))
		this._real[0] = 0
		this._imag[0] = 0
		this._normalize = !disableNormalization
		this._tables = tables
		this._getTables()
		created(context, this, 'PeriodicWave', [ context, options, this._tables ])
	}

	static _basic (type) {
		let wave = basicWaves.get(type)
		if (!wave) {
			const { real, imag } = basicCoefficients(type, MAX_PARTIALS + 1)
			wave = Object.create(PeriodicWave.prototype)
			wave._real = real
			wave._imag = imag
			wave._normalize = true
			wave._tables = null
			basicWaves.set(type, wave)
		}
		return wave
	}

	static _adoptBasic (type, tables) {
		const wave = PeriodicWave._basic(type)
		if (wave._tables === null) { wave._tables = tables }
	}

	_getTables () {
		if (this._tables === null) { this._tables = generateTables(this._real, this._imag, this._normalize) }
		return this._tables
	}
}

module.exports = { PeriodicWave, TABLE_SIZE, NUM_TABLES }
