const { RENDER_QUANTUM: N } = require('./constants')

const SQRT1_2 = Math.SQRT1_2

const add = (dst, src, gain = 1) => {
	const n = src.length
	if (gain === 1) {
		for (let i = 0; i < n; i++) { dst[i] += src[i] }
	}
	else {
		for (let i = 0; i < n; i++) { dst[i] += src[i] * gain }
	}
}

const isSpeakerLayout = (count) => count === 1 || count === 2 || count === 4 || count === 6

const mixSpeakers = (dst, src) => {
	const d = dst.length
	const s = src.length

	if (s === 1) {
		if (d === 2 || d === 4) {
			add(dst[0], src[0])
			add(dst[1], src[0])
		}
		else { add(dst[2], src[0]) }
		return
	}

	if (s === 2) {
		if (d === 1) {
			add(dst[0], src[0], 0.5)
			add(dst[0], src[1], 0.5)
		}
		else {
			add(dst[0], src[0])
			add(dst[1], src[1])
		}
		return
	}

	if (s === 4) {
		if (d === 1) {
			for (let c = 0; c < 4; c++) { add(dst[0], src[c], 0.25) }
		}
		else if (d === 2) {
			add(dst[0], src[0], 0.5)
			add(dst[0], src[2], 0.5)
			add(dst[1], src[1], 0.5)
			add(dst[1], src[3], 0.5)
		}
		else {
			add(dst[0], src[0])
			add(dst[1], src[1])
			add(dst[4], src[2])
			add(dst[5], src[3])
		}
		return
	}

	if (d === 1) {
		add(dst[0], src[0], SQRT1_2)
		add(dst[0], src[1], SQRT1_2)
		add(dst[0], src[2])
		add(dst[0], src[4], 0.5)
		add(dst[0], src[5], 0.5)
	}
	else if (d === 2) {
		add(dst[0], src[0])
		add(dst[0], src[2], SQRT1_2)
		add(dst[0], src[4], SQRT1_2)
		add(dst[1], src[1])
		add(dst[1], src[2], SQRT1_2)
		add(dst[1], src[5], SQRT1_2)
	}
	else {
		add(dst[0], src[0])
		add(dst[0], src[2], SQRT1_2)
		add(dst[1], src[1])
		add(dst[1], src[2], SQRT1_2)
		add(dst[2], src[4])
		add(dst[3], src[5])
	}
}

const mixAdd = (dst, src, interpretation) => {
	const d = dst.length
	const s = src.length

	if (d === s) {
		for (let c = 0; c < d; c++) { add(dst[c], src[c]) }
		return
	}

	if (interpretation === 'speakers' && isSpeakerLayout(d) && isSpeakerLayout(s)) {
		mixSpeakers(dst, src)
		return
	}

	const count = Math.min(d, s)
	for (let c = 0; c < count; c++) { add(dst[c], src[c]) }
}

const makeChannels = (count, size = N) => {
	const channels = new Array(count)
	for (let c = 0; c < count; c++) { channels[c] = new Float32Array(size) }
	return channels
}

const resizeChannels = (channels, count, size = channels.length > 0 ? channels[0].length : N) => {
	if (channels.length > 0 && channels[0].length !== size) { channels.length = 0 }
	if (channels.length === count) { return channels }
	if (channels.length > count) {
		channels.length = count
		return channels
	}
	while (channels.length < count) { channels.push(new Float32Array(size)) }
	return channels
}

const zeroChannels = (channels) => {
	for (const channel of channels) { channel.fill(0) }
}

const copyChannel = (dst, src) => {
	if (src.length >= dst.length) {
		dst.set(src.length === dst.length ? src : src.subarray(0, dst.length))
		return
	}
	dst.set(src)
	dst.fill(0, src.length)
}

const isSilent = (channels) => {
	for (const channel of channels) {
		const n = channel.length
		for (let i = 0; i < n; i++) {
			if (channel[i] !== 0) { return false }
		}
	}
	return true
}

module.exports = {
	add,
	mixAdd,
	makeChannels,
	resizeChannels,
	zeroChannels,
	copyChannel,
	isSilent,
	isSpeakerLayout,
}
