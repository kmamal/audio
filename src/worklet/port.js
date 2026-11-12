const { MessagePort: NodeMessagePort } = require('node:worker_threads')

const wrappers = new WeakMap()

const reportException = (error) => { console.error(error) }

const wrapListener = (listener) => {
	const cached = wrappers.get(listener)
	if (cached !== undefined) { return cached }
	const wrapped = function wrapped (event) {
		try {
			if (typeof listener === 'function') { listener.call(this, event) }
			else { listener.handleEvent(event) }
		}
		catch (error) {
			reportException(error)
		}
	}
	wrappers.set(listener, wrapped)
	return wrapped
}

const HANDLED = [ 'message', 'messageerror' ]

class WorkletMessagePort extends EventTarget {
	constructor (port) {
		super()
		this._port = port
		this._counts = { message: 0, messageerror: 0 }
		this._forwarders = {
			message: (event) => { this.dispatchEvent(new MessageEvent('message', { data: event.data, ports: event.ports })) },
			messageerror: (event) => { this.dispatchEvent(new MessageEvent('messageerror', { data: event.data })) },
		}
		this._handlers = { message: null, messageerror: null }
	}

	static [Symbol.hasInstance] (value) {
		return value instanceof NodeMessagePort || Object.prototype.isPrototypeOf.call(WorkletMessagePort.prototype, value)
	}

	addEventListener (type, listener, options) {
		if (listener === null || listener === undefined) { return }
		const kind = String(type)
		if (!HANDLED.includes(kind)) {
			super.addEventListener(kind, listener, options)
			return
		}
		const before = this._counts[kind]
		super.addEventListener(kind, wrapListener(listener), options)
		this._counts[kind] = before + 1
		if (before === 0) { this._port.addEventListener(kind, this._forwarders[kind]) }
	}

	removeEventListener (type, listener, options) {
		if (listener === null || listener === undefined) { return }
		const kind = String(type)
		if (!HANDLED.includes(kind)) {
			super.removeEventListener(kind, listener, options)
			return
		}
		const wrapped = wrappers.get(listener)
		if (wrapped === undefined) { return }
		super.removeEventListener(kind, wrapped, options)
		if (--this._counts[kind] === 0) { this._port.removeEventListener(kind, this._forwarders[kind]) }
	}

	postMessage (message, transfer) {
		const list = Array.isArray(transfer) ? transfer : transfer?.transfer
		this._port.postMessage(message, list)
	}

	start () { this._port.start() }
	close () { this._port.close() }
}

for (const type of HANDLED) {
	Object.defineProperty(WorkletMessagePort.prototype, `on${type}`, {
		configurable: true,
		enumerable: true,
		get () { return this._handlers[type] },
		set (handler) {
			const current = this._handlers[type]
			if (current !== null) { this.removeEventListener(type, current) }
			this._handlers[type] = typeof handler === 'function' ? handler : null
			if (this._handlers[type] !== null) { this.addEventListener(type, handler) }
		},
	})
}

const wrapPort = (port) => port instanceof NodeMessagePort ? new WorkletMessagePort(port) : port

const guarded = (callback) => () => {
	try { callback() }
	catch (error) { reportException(error) }
}

module.exports = { WorkletMessagePort, wrapPort, reportException, guarded }
