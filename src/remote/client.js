const Path = require('node:path')
const { Worker } = require('node:worker_threads')
const { useWorkers, getFetch } = require('../config')
const { REF, walk } = require('./tree')

const PASS_THROUGH = [ Date, RegExp, Map, Set, Error, Blob ]

const WORKER_ARGV = [ '--experimental-vm-modules', '--disable-warning=ExperimentalWarning' ]

let nextId = 1

const HOST_REQUESTS = {
	async fetchText ({ href }) {
		const response = await getFetch()(href)
		if (!response.ok) { throw new DOMException(`failed to load worklet module '${href}' (${response.status})`, 'AbortError') }
		return response.text()
	},
}

const copyView = (view) => {
	if (view instanceof DataView) {
		return new DataView(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
	}
	const Ctor = view instanceof Buffer ? Uint8Array : view.constructor
	return new Ctor(view)
}

class Client {
	constructor () {
		this._worker = new Worker(Path.join(__dirname, 'render-worker.js'), { execArgv: WORKER_ARGV })
		this._worker.unref()
		this._referenced = false
		this._failed = false
		this._worker.on('message', (messages) => {
			for (const message of messages) { this._receive(message) }
		})
		this._worker.on('error', (error) => { this._fail(error) })
		this._worker.on('exit', (code) => { this._fail(new Error(`exited with code ${code}`)) })

		this._queue = []
		this._transfer = []
		this._scheduled = false
		this._objects = new Map()
		this._finalizer = new FinalizationRegistry((id) => {
			this._objects.delete(id)
			this._push({ t: 'release', id })
		})
		this._requests = new Map()
		this._nextRequest = 1
		this._alive = new Set()
		this._refs = new Set()
	}

	_fail (error) {
		if (this._failed) { return }
		this._failed = true
		process.emitWarning(`@kmamal/audio render thread failed: ${error.message}`)
		for (const { reject } of this._requests.values()) { reject(error) }
		this._requests.clear()
		this._alive.clear()
		this._refs.clear()
		this._updateRef()
		for (const ref of this._objects.values()) { ref.deref()?._remoteFailed?.(error) }
	}

	owns (object) { return object._rid !== undefined && object._ridOwner === this }

	_register (object) {
		const id = nextId++
		object._rid = id
		object._ridOwner = this
		this._objects.set(id, new WeakRef(object))
		this._finalizer.register(object, id)
		return id
	}

	created (object, cls, args, extra = null, { copyShared = true } = {}) {
		const transfer = []
		const encoded = this._encode(args, transfer, copyShared)
		const nodes = walk(object)
		const ids = nodes.map((node) => this._register(node))
		const shared = nodes.map((node) => node._shared ?? null)
		if (extra?.port) { transfer.push(extra.port) }
		this._push({ t: 'new', cls, args: encoded, ids, shared, extra }, transfer)
	}

	ref (object) {
		if (this.owns(object)) { return object._rid }
		if (typeof object._snapshot !== 'function') { return null }
		const { cls, args } = object._snapshot()
		const transfer = []
		const encoded = this._encode(args, transfer)
		const id = this._register(object)
		this._push({ t: 'new', cls, args: encoded, ids: [ id ], shared: [ null ], extra: null }, transfer)
		return id
	}

	send (object, name, args = [], { copyShared = false } = {}) {
		const transfer = []
		const encoded = this._encode(args, transfer, copyShared)
		this._push({ t: 'call', id: object._rid, name, args: encoded }, transfer)
	}

	assign (object, name, value, { copyShared = false } = {}) {
		const transfer = []
		const encoded = this._encode(value, transfer, copyShared)
		this._push({ t: 'set', id: object._rid, name, value: encoded }, transfer)
	}

	request (type, payload, transfer = []) {
		if (this._failed) { return Promise.reject(new Error("the render thread has failed")) }
		const id = this._nextRequest++
		const promise = new Promise((resolve, reject) => { this._requests.set(id, { resolve, reject }) })
		this._push({ t: 'request', id, type, payload: this._encode(payload, transfer) }, transfer)
		this._updateRef()
		return promise
	}

	setAlive (object, alive, ref = alive) {
		if (alive) { this._alive.add(object) }
		else { this._alive.delete(object) }
		if (ref) { this._refs.add(object) }
		else { this._refs.delete(object) }
		this._updateRef()
	}

	_updateRef () {
		const wanted = !this._failed && (this._refs.size > 0 || this._requests.size > 0 || (this._hostRequests ?? 0) > 0)
		if (wanted === this._referenced) { return }
		this._referenced = wanted
		if (wanted) { this._worker.ref() }
		else { this._worker.unref() }
	}

	_push (op, transfer = []) {
		if (this._failed) { return }
		this._queue.push(op)
		for (const item of transfer) { this._transfer.push(item) }
		if (this._scheduled) { return }
		this._scheduled = true
		queueMicrotask(() => { this._flush() })
	}

	_flush () {
		this._scheduled = false
		if (this._failed || this._queue.length === 0) { return }
		const queue = this._queue
		const transfer = this._transfer
		this._queue = []
		this._transfer = []
		this._worker.postMessage(queue, transfer)
	}

	_receive (message) {
		if (message.reply !== undefined) {
			const request = this._requests.get(message.reply)
			if (!request) { return }
			this._requests.delete(message.reply)
			this._updateRef()
			if (message.error) { request.reject(Object.assign(new Error(message.error.message), { name: message.error.name })) }
			else { request.resolve(message.result) }
			return
		}
		if (message.hostRequest !== undefined) {
			this._answer(message)
			return
		}
		if (message.warning !== undefined) {
			process.emitWarning(`@kmamal/audio render thread: ${message.warning}`)
			return
		}
		const object = this._objects.get(message.id)?.deref()
		object?._onRemote(message.type, message.data)
	}

	_answer ({ hostRequest: id, type, payload }) {
		const handler = HOST_REQUESTS[type]
		this._updateHostRequests(1)
		Promise.resolve()
			.then(() => {
				if (handler === undefined) { throw new Error(`unknown host request '${type}'`) }
				return handler(payload)
			})
			.then(
				(result) => { this._push({ t: 'hostReply', id, result }) },
				(error) => { this._push({ t: 'hostReply', id, error: { name: error?.name ?? 'Error', message: error?.message ?? String(error) } }) },
			)
			.finally(() => { this._updateHostRequests(-1) })
	}

	_updateHostRequests (delta) {
		this._hostRequests = (this._hostRequests ?? 0) + delta
		this._updateRef()
	}

	_encode (value, transfer, copyShared = false) {
		if (value === null) { return null }
		if (typeof value === 'function' || typeof value === 'symbol') { return undefined }
		if (typeof value !== 'object') { return value }
		if (ArrayBuffer.isView(value)) {
			if (value.buffer instanceof SharedArrayBuffer && !copyShared) { return value }
			const copy = copyView(value)
			transfer.push(copy.buffer)
			return copy
		}
		if (value instanceof ArrayBuffer) { return value.slice(0) }
		if (value instanceof SharedArrayBuffer) { return value }
		if (value instanceof MessagePort) {
			transfer.push(value)
			return value
		}
		if (Array.isArray(value)) { return value.map((item) => this._encode(item, transfer, copyShared)) }
		const proto = Object.getPrototypeOf(value)
		if (proto === Object.prototype || proto === null) {
			const out = {}
			for (const key of Object.keys(value)) { out[key] = this._encode(value[key], transfer, copyShared) }
			return out
		}
		if (this.owns(value) || typeof value._snapshot === 'function') {
			const id = this.ref(value)
			return id === null ? null : { [REF]: id }
		}
		if (PASS_THROUGH.some((Ctor) => value instanceof Ctor)) { return value }
		return null
	}
}

let client = null

const getClient = () => {
	if (!useWorkers()) { return null }
	if (client === null || client._failed) { client = new Client() }
	return client
}

const currentClient = () => client

const created = (context, object, cls, args, extra, options) => {
	const remote = context._remote
	if (remote) { remote.created(object, cls, args, extra, options) }
}

module.exports = { getClient, currentClient, created }
