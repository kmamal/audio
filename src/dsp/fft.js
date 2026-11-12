
const tables = new Map()

const getTables = (n) => {
	let entry = tables.get(n)
	if (entry) { return entry }

	const cos = new Float64Array(n / 2)
	const sin = new Float64Array(n / 2)
	for (let i = 0; i < n / 2; i++) {
		const angle = -2 * Math.PI * i / n
		cos[i] = Math.cos(angle)
		sin[i] = Math.sin(angle)
	}

	const bits = Math.log2(n)
	const reverse = new Uint32Array(n)
	for (let i = 0; i < n; i++) {
		let r = 0
		for (let b = 0; b < bits; b++) { r |= ((i >> b) & 1) << (bits - 1 - b) }
		reverse[i] = r
	}

	entry = { cos, sin, reverse }
	tables.set(n, entry)
	return entry
}

const isPowerOfTwo = (n) => n > 0 && (n & (n - 1)) === 0

const fft = (re, im) => {
	const n = re.length
	if (!isPowerOfTwo(n)) { throw new Error("fft size must be a power of two") }

	const { cos, sin, reverse } = getTables(n)

	for (let i = 0; i < n; i++) {
		const j = reverse[i]
		if (j > i) {
			let t = re[i]
			re[i] = re[j]
			re[j] = t
			t = im[i]
			im[i] = im[j]
			im[j] = t
		}
	}

	for (let size = 2; size <= n; size <<= 1) {
		const half = size >> 1
		const step = n / size
		for (let start = 0; start < n; start += size) {
			for (let k = 0, t = 0; k < half; k++, t += step) {
				const a = start + k
				const b = a + half
				const wr = cos[t]
				const wi = sin[t]
				const tr = re[b] * wr - im[b] * wi
				const ti = re[b] * wi + im[b] * wr
				re[b] = re[a] - tr
				im[b] = im[a] - ti
				re[a] += tr
				im[a] += ti
			}
		}
	}
}

const ifft = (re, im) => {
	const n = re.length
	for (let i = 0; i < n; i++) { im[i] = -im[i] }
	fft(re, im)
	for (let i = 0; i < n; i++) {
		re[i] /= n
		im[i] = -im[i] / n
	}
}

const realTables = new Map()

const getRealTables = (n) => {
	let entry = realTables.get(n)
	if (entry) { return entry }
	const m = n / 2
	const cos = new Float64Array(m + 1)
	const sin = new Float64Array(m + 1)
	for (let k = 0; k <= m; k++) {
		const angle = -2 * Math.PI * k / n
		cos[k] = Math.cos(angle)
		sin[k] = Math.sin(angle)
	}
	entry = { cos, sin, re: new Float64Array(m), im: new Float64Array(m) }
	realTables.set(n, entry)
	return entry
}

const rfft = (input, outRe, outIm) => {
	const n = input.length
	if (!isPowerOfTwo(n) || n < 4) { throw new Error("rfft size must be a power of two of at least 4") }
	const m = n / 2
	const { cos, sin, re, im } = getRealTables(n)

	for (let k = 0; k < m; k++) {
		re[k] = input[2 * k]
		im[k] = input[2 * k + 1]
	}
	fft(re, im)

	for (let k = 0; k <= m; k++) {
		const a = k === m ? 0 : k
		const b = (m - k) % m
		const zr = re[a]
		const zi = im[a]
		const cr = re[b]
		const ci = -im[b]
		const er = (zr + cr) / 2
		const ei = (zi + ci) / 2
		const or = (zi - ci) / 2
		const oi = (cr - zr) / 2
		const wr = cos[k]
		const wi = sin[k]
		outRe[k] = er + wr * or - wi * oi
		outIm[k] = ei + wr * oi + wi * or
	}
}

const irfft = (inRe, inIm, output) => {
	const n = output.length
	if (!isPowerOfTwo(n) || n < 4) { throw new Error("irfft size must be a power of two of at least 4") }
	const m = n / 2
	const { cos, sin, re, im } = getRealTables(n)

	for (let k = 0; k < m; k++) {
		const j = m - k
		const xr = inRe[k]
		const xi = inIm[k]
		const cr = inRe[j]
		const ci = -inIm[j]
		const er = (xr + cr) / 2
		const ei = (xi + ci) / 2
		const dr = (xr - cr) / 2
		const di = (xi - ci) / 2
		const wr = cos[k]
		const wi = -sin[k]
		const or = dr * wr - di * wi
		const oi = dr * wi + di * wr
		re[k] = er - oi
		im[k] = ei + or
	}
	ifft(re, im)

	for (let k = 0; k < m; k++) {
		output[2 * k] = re[k]
		output[2 * k + 1] = im[k]
	}
}

module.exports = { fft, ifft, rfft, irfft, isPowerOfTwo }
