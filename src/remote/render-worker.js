const { parentPort } = require('node:worker_threads')
const { configure } = require('../config')

configure({ workers: false })

const api = require('../api')
const { SINK_DEVICE, CAPTURE, TWIN } = require('../context/audio-context')
const { PROCESSOR_PORT, loadModule, snapshotRegistry, setRemoteFetch } = require('../worklet')
const { RecordingSource } = require('../media/devices')
const { setSink } = require('./notify')
const { REF, walk } = require('./tree')

const registry = new Map()

let outbox = []
let outTransfer = []
let scheduled = false

const flush = () => {
	scheduled = false
	if (outbox.length === 0) { return }
	const messages = outbox
	const transfer = outTransfer
	outbox = []
	outTransfer = []
	parentPort.postMessage(messages, transfer)
}

const post = (message, transfer) => {
	outbox.push(message)
	if (transfer) { outTransfer.push(...transfer) }
	if (scheduled) { return }
	scheduled = true
	queueMicrotask(flush)
}

setSink((id, type, data, transfer, urgent) => {
	post({ id, type, data }, transfer)
	if (urgent) { flush() }
})

const hostRequests = new Map()
let nextHostRequest = 1

const hostRequest = (type, payload) => new Promise((resolve, reject) => {
	const id = nextHostRequest++
	hostRequests.set(id, { resolve, reject })
	post({ hostRequest: id, type, payload })
})

const hostReply = ({ id, result, error }) => {
	const pending = hostRequests.get(id)
	if (!pending) { return }
	hostRequests.delete(id)
	if (error) { pending.reject(Object.assign(new Error(error.message), { name: error.name })) }
	else { pending.resolve(result) }
}

setRemoteFetch((href) => hostRequest('fetchText', { href }))

const decode = (value) => {
	if (value === null || typeof value !== 'object') { return value }
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof SharedArrayBuffer || value instanceof MessagePort) { return value }
	if (Array.isArray(value)) { return value.map(decode) }
	const proto = Object.getPrototypeOf(value)
	if (proto !== Object.prototype && proto !== null) { return value }
	if (REF in value) { return registry.get(value[REF]) ?? null }
	const out = {}
	for (const key of Object.keys(value)) { out[key] = decode(value[key]) }
	return out
}

const factories = {
	AudioContext: ([ options, device, capture ]) => new api.AudioContext({ ...options, [SINK_DEVICE]: device, [CAPTURE]: capture ?? undefined, [TWIN]: true }),
	AudioWorkletNode: ([ context, name, options ], { port }) => new api.AudioWorkletNode(context, name, { ...options, [PROCESSOR_PORT]: port }),
	AudioBuffer: ([ { sampleRate, channels } ]) => api.AudioBuffer._fromChannels(channels, sampleRate),
	MediaStream: ([ tracks ]) => new api.MediaStream(tracks.filter((track) => track !== null)),
	MediaStreamTrack: ([ init, state ]) => {
		const track = new api.MediaStreamTrack(init)
		track._enabled = state.enabled
		track._readyState = state.readyState
		return track
	},
	RecordingSource: ([ options ]) => new RecordingSource(options),
	HTMLMediaElement: ([ state ]) => api.HTMLMediaElement._twin(state),
}

const create = (op) => {
	const args = decode(op.args)
	const factory = factories[op.cls]
	const object = factory ? factory(args, op.extra) : new api[op.cls](...args)
	const nodes = walk(object)
	for (let i = 0; i < nodes.length; i++) {
		const id = op.ids[i]
		if (id === undefined) { break }
		const node = nodes[i]
		node._rid = id
		registry.set(id, node)
		if (op.shared[i] !== null) { node._adoptShared(op.shared[i]) }
	}
	object._twinReady?.()
}

const requests = {
	invoke ({ target, method, args = [] }) {
		return target[method](...args)
	},

	stats () {
		return { objects: registry.size }
	},

	async addModule ({ context, source, port }) {
		await loadModule(context, source, port ?? null)
		return snapshotRegistry(context)
	},
}

const settle = (result) => {
	if (result instanceof Promise) { result.catch(() => {}) }
}

const apply = (op) => {
	switch (op.t) {
		case 'new': { create(op) } break
		case 'set': {
			const target = registry.get(op.id)
			if (target) { target[op.name] = decode(op.value) }
		} break
		case 'call': {
			const target = registry.get(op.id)
			if (target) { settle(target[op.name](...decode(op.args))) }
		} break
		case 'release': {
			const target = registry.get(op.id)
			registry.delete(op.id)
			if (target instanceof api.AudioContext && target._target !== 'closed') { settle(target.close()) }
		} break
		case 'hostReply': { hostReply(op) } break
		case 'request': {
			Promise.resolve()
				.then(() => requests[op.type](decode(op.payload)))
				.then(
					(result) => { post({ reply: op.id, result }) },
					(error) => { post({ reply: op.id, error: { name: error?.name, message: error?.message ?? String(error) } }) },
				)
		} break
		default: break
	}
}

const describe = (op) => {
	if (op.t === 'new') { return `new ${op.cls}` }
	const target = registry.get(op.id)
	return `${target?.constructor.name ?? 'object'}.${op.name}`
}

parentPort.on('message', (batch) => {
	for (const op of batch) {
		try { apply(op) }
		catch (error) { post({ warning: `${describe(op)}: ${error.message}` }) }
	}
})
