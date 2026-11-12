const { decodeWav } = require('./wav')
const { decodeAiff } = require('./aiff')

const ascii = (bytes, start, length) => String.fromCharCode(...bytes.subarray(start, start + length))

const decoders = new Map()

const serialized = (key, create, run) => {
	let entry = decoders.get(key)
	if (!entry) {
		entry = { instance: null, chain: Promise.resolve() }
		decoders.set(key, entry)
	}
	const task = entry.chain.then(async () => {
		if (entry.instance === null) {
			entry.instance = create()
			await entry.instance.ready
		}
		else {
			await entry.instance.reset()
		}
		return run(entry.instance)
	})
	entry.chain = task.catch(() => {})
	return task
}

const checkErrors = (result, what) => {
	if (result.errors && result.errors.length > 0 && (!result.channelData || result.channelData.length === 0 || result.channelData[0].length === 0)) {
		throw new Error(`${what}: ${result.errors[0].message ?? 'decoding failed'}`)
	}
	if (!result.channelData || result.channelData.length === 0 || result.channelData[0].length === 0) {
		throw new Error(`${what}: no audio data`)
	}
	return { channelData: result.channelData.map((c) => c instanceof Float32Array ? c : Float32Array.from(c)), sampleRate: result.sampleRate }
}

const decodeMp3 = (bytes) => serialized('mp3', () => {
	const { MPEGDecoder } = require('mpg123-decoder')
	return new MPEGDecoder()
}, (decoder) => checkErrors(decoder.decode(bytes), 'mp3'))

const decodeVorbis = (bytes) => serialized('vorbis', () => {
	const { OggVorbisDecoder } = require('@wasm-audio-decoders/ogg-vorbis')
	return new OggVorbisDecoder()
}, async (decoder) => checkErrors(await decoder.decodeFile(bytes), 'ogg vorbis'))

const decodeOpus = (bytes) => serialized('opus', () => {
	const { OggOpusDecoder } = require('ogg-opus-decoder')
	return new OggOpusDecoder()
}, async (decoder) => checkErrors(await decoder.decodeFile(bytes), 'ogg opus'))

const decodeFlac = (bytes) => serialized('flac', () => {
	const { FLACDecoder } = require('@wasm-audio-decoders/flac')
	return new FLACDecoder()
}, async (decoder) => checkErrors(await decoder.decodeFile(bytes), 'flac'))

const oggCodec = (bytes) => {
	if (bytes.length < 28) { return null }
	const segments = bytes[26]
	const start = 27 + segments
	const head = ascii(bytes, start, 8)
	if (head.startsWith('\x01vorbis')) { return 'vorbis' }
	if (head === 'OpusHead') { return 'opus' }
	if (head.startsWith('\x7fFLAC')) { return 'oggflac' }
	return null
}

const isMp3 = (bytes) => {
	if (ascii(bytes, 0, 3) === 'ID3') { return true }
	if (bytes.length < 4 || bytes[0] !== 0xFF) { return false }
	const b1 = bytes[1]
	return (b1 & 0xE0) === 0xE0 && (b1 & 0x18) !== 0x08 && (b1 & 0x06) !== 0x00
}

const toBytes = (data) => {
	if (data instanceof Uint8Array) { return data }
	if (ArrayBuffer.isView(data)) { return new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
	if (data instanceof ArrayBuffer) { return new Uint8Array(data) }
	throw new TypeError("audio data must be an ArrayBuffer or a typed array")
}

const decodeAudio = async (data) => {
	const bytes = toBytes(data)
	const magic = ascii(bytes, 0, 4)

	let decoded
	if (magic === 'RIFF' || magic === 'RIFX') { decoded = decodeWav(bytes) }
	else if (magic === 'FORM') { decoded = decodeAiff(bytes) }
	else if (magic === 'fLaC') { decoded = await decodeFlac(bytes) }
	else if (magic === 'OggS') {
		const codec = oggCodec(bytes)
		if (codec === 'vorbis') { decoded = await decodeVorbis(bytes) }
		else if (codec === 'opus') { decoded = await decodeOpus(bytes) }
		else { throw new Error(`unsupported ogg stream${codec ? ` (${codec})` : ''}`) }
	}
	else if (isMp3(bytes)) { decoded = await decodeMp3(bytes) }
	else { throw new Error("unable to detect the audio format") }

	if (!decoded.channelData || decoded.channelData.length === 0 || decoded.channelData[0].length === 0) {
		throw new Error("the file contains no audio data")
	}
	if (!(decoded.sampleRate > 0)) { throw new Error("the file has an invalid sample rate") }

	return decoded
}

module.exports = { decodeAudio }
