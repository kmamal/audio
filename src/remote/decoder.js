const Path = require('node:path')
const { Worker } = require('node:worker_threads')
const { useWorkers } = require('../config')
const { decodeAudio } = require('../decode')
const { resample } = require('../dsp/resample')
const { ownChannels } = require('./shared')

let worker = null
let nextId = 1
const pending = new Map()

const fail = (error) => {
	for (const { reject } of pending.values()) { reject(error) }
	pending.clear()
	worker = null
}

const getWorker = () => {
	if (worker !== null) { return worker }
	worker = new Worker(Path.join(__dirname, 'decode-worker.js'), { execArgv: [] })
	worker.unref()
	worker.on('message', ({ id, result, error }) => {
		const request = pending.get(id)
		if (!request) { return }
		pending.delete(id)
		if (pending.size === 0) { worker.unref() }
		if (error !== undefined) { request.reject(new Error(error)) }
		else { request.resolve(result) }
	})
	worker.on('error', (error) => { fail(error) })
	worker.on('exit', (code) => { fail(new Error(`the decode worker exited with code ${code}`)) })
	return worker
}

const request = (type, payload, transfer = []) => {
	const target = getWorker()
	const id = nextId++
	let settle = null
	const promise = new Promise((resolve, reject) => {
		settle = { resolve, reject }
		pending.set(id, settle)
	})
	if (pending.size === 1) { target.ref() }
	try {
		target.postMessage({ id, type, ...payload }, transfer)
	}
	catch (error) {
		pending.delete(id)
		if (pending.size === 0) { target.unref() }
		settle.reject(error)
	}
	return promise
}

const ownsBuffer = (view) => view.byteOffset === 0 && view.byteLength === view.buffer.byteLength && !(view.buffer instanceof SharedArrayBuffer)

const detachBuffer = (buffer) => {
	try { structuredClone(buffer, { transfer: [ buffer ] }) }
	catch {}
}

const decode = async (bytes, sampleRate = null, { transfer = false, detach = false, shared = false } = {}) => {
	const view = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes)

	if (!useWorkers()) {
		let input = view
		if (detach) {
			input = view.slice()
			detachBuffer(view.buffer)
		}
		const decoded = await decodeAudio(input)
		const rate = sampleRate ?? decoded.sampleRate
		return { channels: ownChannels(resample(decoded.channelData, decoded.sampleRate, rate)), sampleRate: rate }
	}

	const payload = (transfer || detach) && ownsBuffer(view) ? view : view.slice()
	try {
		return await request('decode', { bytes: payload, sampleRate, shared }, [ payload.buffer ])
	}
	catch (error) {
		if (payload !== view || error?.name !== 'DataCloneError') { throw error }
		return request('decode', { bytes: view.slice(), sampleRate, shared })
	}
}

module.exports = { decode }
