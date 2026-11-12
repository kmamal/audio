
const readExtended = (view, offset) => {
	const exponent = view.getUint16(offset, false)
	const hi = view.getUint32(offset + 2, false)
	const lo = view.getUint32(offset + 6, false)
	const sign = exponent & 0x8000 ? -1 : 1
	const e = exponent & 0x7FFF
	if (e === 0 && hi === 0 && lo === 0) { return 0 }
	const mantissa = hi * (2 ** 32) + lo
	return sign * mantissa * (2 ** (e - 16383 - 63))
}

const decodeAiff = (bytes) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const type = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
	if (type !== 'AIFF' && type !== 'AIFC') { throw new Error("not an AIFF file") }

	let channels = 0
	let frames = 0
	let bits = 0
	let sampleRate = 0
	let littleEndian = false
	let isFloat = false
	let offset = 12

	while (offset + 8 <= bytes.length) {
		const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
		const size = view.getUint32(offset + 4, false)
		const body = offset + 8

		if (id === 'COMM') {
			channels = view.getUint16(body, false)
			frames = view.getUint32(body + 2, false)
			bits = view.getUint16(body + 6, false)
			sampleRate = readExtended(view, body + 8)
			if (type === 'AIFC' && size >= 22) {
				const compression = String.fromCharCode(bytes[body + 18], bytes[body + 19], bytes[body + 20], bytes[body + 21])
				if (compression === 'sowt') { littleEndian = true }
				else if (compression === 'fl32' || compression === 'FL32') { isFloat = true }
				else if (compression === 'fl64' || compression === 'FL64') { isFloat = true }
				else if (compression !== 'NONE') { throw new Error(`unsupported AIFF compression ${compression}`) }
			}
		}
		else if (id === 'SSND') {
			if (channels < 1) { throw new Error("AIFF SSND chunk before COMM chunk") }
			const dataOffset = view.getUint32(body, false)
			const start = body + 8 + dataOffset
			const bytesPerSample = bits / 8
			const available = Math.floor((Math.min(body + size, bytes.length) - start) / (bytesPerSample * channels))
			const length = Math.min(frames || available, available)
			const data = Array.from({ length: channels }, () => new Float32Array(length))

			for (let i = 0; i < length; i++) {
				for (let c = 0; c < channels; c++) {
					const at = start + (i * channels + c) * bytesPerSample
					let value
					if (isFloat) {
						value = bits === 64 ? view.getFloat64(at, littleEndian) : view.getFloat32(at, littleEndian)
					}
					else if (bits === 8) { value = view.getInt8(at) / 128 }
					else if (bits === 16) { value = view.getInt16(at, littleEndian) / 32768 }
					else if (bits === 24) {
						const b0 = bytes[at]
						const b1 = bytes[at + 1]
						const b2 = bytes[at + 2]
						const raw = littleEndian ? b0 | (b1 << 8) | (b2 << 16) : b2 | (b1 << 8) | (b0 << 16)
						value = (raw << 8 >> 8) / 8388608
					}
					else if (bits === 32) { value = view.getInt32(at, littleEndian) / 2147483648 }
					else { throw new Error(`unsupported AIFF bit depth ${bits}`) }
					data[c][i] = value
				}
			}

			return { channelData: data, sampleRate }
		}

		offset = body + size + (size & 1)
	}

	throw new Error("AIFF file has no SSND chunk")
}

module.exports = { decodeAiff }
