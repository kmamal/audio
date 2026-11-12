const Fs = require('node:fs')
const Path = require('node:path')
const { resampleChannel } = require('./resample')
const { sharedFloat32 } = require('../remote/shared')

const RESOURCE = Path.join(__dirname, '../../resources/hrtf-ircam-composite.s16le')
const RESPONSE_FRAMES = 256
const RESPONSE_SAMPLE_RATE = 44100
const NUM_AZIMUTHS = 24
const ELEVATIONS = [ 0, 15, 30, 45, 60, 75, 90, -45, -30, -15 ]
const ELEVATION_INDEX = new Map(ELEVATIONS.map((e, i) => [ e, i ]))
const NUM_RESPONSES = NUM_AZIMUTHS * ELEVATIONS.length

let raw = null

const loadRaw = () => {
	if (raw !== null) { return raw }
	const bytes = Fs.readFileSync(RESOURCE)
	const frames = bytes.length / 4
	const left = new Float32Array(frames)
	const right = new Float32Array(frames)
	for (let i = 0; i < frames; i++) {
		left[i] = bytes.readInt16LE(i * 4) / 32768
		right[i] = bytes.readInt16LE(i * 4 + 2) / 32768
	}
	raw = { left, right }
	return raw
}

const databases = new Map()

class HRTFDatabase {
	constructor (sampleRate, parts = null) {
		this.sampleRate = sampleRate
		this.length = parts === null ? Math.max(1, Math.round(RESPONSE_FRAMES * sampleRate / RESPONSE_SAMPLE_RATE)) : parts.length
		this._flatLeft = parts === null ? sharedFloat32(NUM_RESPONSES * this.length) : parts.left
		this._flatRight = parts === null ? sharedFloat32(NUM_RESPONSES * this.length) : parts.right
		this._left = new Array(NUM_RESPONSES)
		this._right = new Array(NUM_RESPONSES)
		for (let index = 0; index < NUM_RESPONSES; index++) {
			const start = index * this.length
			this._left[index] = this._flatLeft.subarray(start, start + this.length)
			this._right[index] = this._flatRight.subarray(start, start + this.length)
		}
		if (parts === null) { this._load() }
	}

	_load () {
		const { left, right } = loadRaw()
		for (let index = 0; index < NUM_RESPONSES; index++) {
			const start = index * RESPONSE_FRAMES
			this._convert(left.subarray(start, start + RESPONSE_FRAMES), this._left[index])
			this._convert(right.subarray(start, start + RESPONSE_FRAMES), this._right[index])
		}
	}

	_convert (response, out) {
		if (this.sampleRate === RESPONSE_SAMPLE_RATE) {
			out.set(response)
			return
		}
		const converted = resampleChannel(response, RESPONSE_SAMPLE_RATE, this.sampleRate)
		out.set(converted.length > out.length ? converted.subarray(0, out.length) : converted)
	}

	_shared () {
		return { length: this.length, left: this._flatLeft, right: this._flatRight }
	}

	_index (azimuthIndex, elevation) {
		return ((azimuthIndex % NUM_AZIMUTHS) + NUM_AZIMUTHS) % NUM_AZIMUTHS * ELEVATIONS.length + ELEVATION_INDEX.get(elevation)
	}

	static for (sampleRate) {
		let database = databases.get(sampleRate)
		if (!database) {
			database = new HRTFDatabase(sampleRate)
			databases.set(sampleRate, database)
		}
		return database
	}

	static adopt (sampleRate, parts) {
		if (databases.has(sampleRate)) { return }
		databases.set(sampleRate, new HRTFDatabase(sampleRate, parts))
	}

	kernels (azimuth, elevation, outLeft, outRight) {
		const databaseAzimuth = ((-azimuth % 360) + 360) % 360
		const azimuthPosition = databaseAzimuth / 15
		const a0 = Math.floor(azimuthPosition)
		const a1 = (a0 + 1) % NUM_AZIMUTHS
		const aBlend = azimuthPosition - a0

		const clamped = Math.min(Math.max(elevation, -45), 90)
		const e0 = Math.floor(clamped / 15) * 15
		const e1 = Math.min(e0 + 15, 90)
		const eBlend = e1 === e0 ? 0 : (clamped - e0) / 15

		const indices = [ this._index(a0, e0), this._index(a1, e0), this._index(a0, e1), this._index(a1, e1) ]
		const weights = [ (1 - aBlend) * (1 - eBlend), aBlend * (1 - eBlend), (1 - aBlend) * eBlend, aBlend * eBlend ]

		outLeft.fill(0)
		outRight.fill(0)
		for (let k = 0; k < 4; k++) {
			const w = weights[k]
			if (w === 0) { continue }
			const l = this._left[indices[k]]
			const r = this._right[indices[k]]
			for (let i = 0; i < this.length; i++) {
				outLeft[i] += l[i] * w
				outRight[i] += r[i] * w
			}
		}
	}
}

module.exports = { HRTFDatabase }
