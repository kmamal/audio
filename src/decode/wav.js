
const FORMAT_PCM = 1
const FORMAT_FLOAT = 3
const FORMAT_ALAW = 6
const FORMAT_MULAW = 7
const FORMAT_EXTENSIBLE = 0xFFFE

const decodeMulaw = (byte) => {
	const u = ~byte & 0xFF
	const sign = u & 0x80
	const exponent = (u >> 4) & 0x07
	const mantissa = u & 0x0F
	let sample = ((mantissa << 3) + 0x84) << exponent
	sample -= 0x84
	return (sign ? -sample : sample) / 32768
}

const decodeAlaw = (byte) => {
	let a = byte ^ 0x55
	const sign = a & 0x80
	a &= 0x7F
	const exponent = a >> 4
	let mantissa = a & 0x0F
	if (exponent > 0) { mantissa += 16 }
	mantissa = (mantissa << 4) + 8
	if (exponent > 1) { mantissa <<= exponent - 1 }
	return (sign ? mantissa : -mantissa) / 32768
}

const decodeWav = (bytes) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	if (bytes.length < 12 || view.getUint32(8, false) !== 0x57415645) { throw new Error("not a WAVE file") }

	let format = null
	let channels = 0
	let sampleRate = 0
	let bits = 0
	let blockAlign = 0
	let offset = 12

	while (offset + 8 <= bytes.length) {
		const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
		let size = view.getUint32(offset + 4, true)
		const body = offset + 8

		if (id === 'fmt ') {
			format = view.getUint16(body, true)
			channels = view.getUint16(body + 2, true)
			sampleRate = view.getUint32(body + 4, true)
			blockAlign = view.getUint16(body + 12, true)
			bits = view.getUint16(body + 14, true)
			if (format === FORMAT_EXTENSIBLE && size >= 26) { format = view.getUint16(body + 24, true) }
		}
		else if (id === 'data') {
			if (format === null) { throw new Error("WAVE data chunk before fmt chunk") }
			if (channels < 1) { throw new Error("WAVE file has no channels") }
			if (size === 0xFFFFFFFF || body + size > bytes.length) { size = bytes.length - body }

			const bytesPerSample = bits / 8
			const frameSize = blockAlign || bytesPerSample * channels
			const length = Math.floor(size / frameSize)
			const data = Array.from({ length: channels }, () => new Float32Array(length))

			for (let i = 0; i < length; i++) {
				const frame = body + i * frameSize
				for (let c = 0; c < channels; c++) {
					const at = frame + c * bytesPerSample
					let value
					if (format === FORMAT_FLOAT) {
						value = bits === 64 ? view.getFloat64(at, true) : view.getFloat32(at, true)
					}
					else if (format === FORMAT_MULAW) {
						value = decodeMulaw(bytes[at])
					}
					else if (format === FORMAT_ALAW) {
						value = decodeAlaw(bytes[at])
					}
					else if (format === FORMAT_PCM) {
						if (bits === 8) { value = (bytes[at] - 128) / 128 }
						else if (bits === 16) { value = view.getInt16(at, true) / 32768 }
						else if (bits === 24) { value = ((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) << 8 >> 8) / 8388608 }
						else if (bits === 32) { value = view.getInt32(at, true) / 2147483648 }
						else { throw new Error(`unsupported WAVE bit depth ${bits}`) }
					}
					else {
						throw new Error(`unsupported WAVE format ${format}`)
					}
					data[c][i] = value
				}
			}

			return { channelData: data, sampleRate }
		}

		offset = body + size + (size & 1)
	}

	throw new Error("WAVE file has no data chunk")
}

module.exports = { decodeWav }
