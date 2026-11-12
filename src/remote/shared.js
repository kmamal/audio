
const sharedFloat32 = (length) => new Float32Array(new SharedArrayBuffer(length * 4))

const sharedFloat64 = (length) => new Float64Array(new SharedArrayBuffer(length * 8))

const isShared = (view) => view.buffer instanceof SharedArrayBuffer

const toShared = (view) => {
	if (isShared(view)) { return view }
	const copy = sharedFloat32(view.length)
	copy.set(view)
	return copy
}

const ownChannels = (channels) => {
	const seen = new Set()
	return channels.map((channel) => {
		const { buffer } = channel
		const owned = !(buffer instanceof SharedArrayBuffer) && channel.byteOffset === 0 && channel.byteLength === buffer.byteLength && !seen.has(buffer)
		const out = owned ? channel : channel.slice()
		seen.add(out.buffer)
		return out
	})
}

module.exports = { sharedFloat32, sharedFloat64, isShared, toShared, ownChannels }
