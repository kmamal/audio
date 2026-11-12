import { createRequire } from 'node:module'
import Path from 'node:path'
import assert from 'node:assert/strict'

export const require = createRequire(import.meta.url)

export const audio = require('../src/index.js')

export const assets = Path.join(import.meta.dirname, 'assets')

export const fixtures = Path.join(import.meta.dirname, 'fixtures')

export const RATE = 48000

export const render = async (seconds, build, { channels = 2, sampleRate = RATE } = {}) => {
	const length = Math.round(seconds * sampleRate)
	const context = new audio.OfflineAudioContext({ numberOfChannels: channels, length, sampleRate })
	await build(context)
	return context.startRendering()
}

export const rms = (array, start = 0, end = array.length) => {
	let sum = 0
	for (let i = start; i < end; i++) { sum += array[i] * array[i] }
	return Math.sqrt(sum / Math.max(end - start, 1))
}

export const peak = (array, start = 0, end = array.length) => {
	let max = 0
	for (let i = start; i < end; i++) { max = Math.max(max, Math.abs(array[i])) }
	return max
}

export const dominantFrequency = (array, sampleRate, { start = 0, size = 8192 } = {}) => {
	const { fft } = require('../src/dsp/fft.js')
	const re = new Float64Array(size)
	const im = new Float64Array(size)
	for (let i = 0; i < size; i++) {
		const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size)
		re[i] = (array[start + i] ?? 0) * w
	}
	fft(re, im)
	let best = 0
	let bestIndex = 0
	for (let k = 1; k < size / 2; k++) {
		const m = re[k] * re[k] + im[k] * im[k]
		if (m > best) {
			best = m
			bestIndex = k
		}
	}
	return bestIndex * sampleRate / size
}

export const near = (actual, expected, tolerance, message) => {
	assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? 'value'}: expected ${expected} ± ${tolerance}, got ${actual}`)
}

export const throwsName = (fn, name) => {
	let thrown = null
	try { fn() }
	catch (error) { thrown = error }
	assert.ok(thrown !== null, `expected ${name} to be thrown`)
	assert.equal(thrown.name, name)
}

export const rejectsName = async (promise, name) => {
	let thrown = null
	try { await promise }
	catch (error) { thrown = error }
	assert.ok(thrown !== null, `expected ${name} to be thrown`)
	assert.equal(thrown.name, name)
}

export const tick = () => new Promise((resolve) => { setImmediate(resolve) })

export const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

export { assert }
