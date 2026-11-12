
const queueTask = (callback) => { setImmediate(callback) }

const defineEventHandler = (prototype, type) => {
	const key = Symbol(`on${type}`)
	Object.defineProperty(prototype, `on${type}`, {
		configurable: true,
		enumerable: true,
		get () { return this[key]?.handler ?? null },
		set (handler) {
			const current = this[key]
			if (current) {
				this.removeEventListener(type, current.listener)
				this[key] = null
			}
			if (typeof handler !== 'function') { return }
			const listener = (event) => { handler.call(this, event) }
			this[key] = { handler, listener }
			this.addEventListener(type, listener)
		},
	})
}

const defineEventHandlers = (prototype, types) => {
	for (const type of types) { defineEventHandler(prototype, type) }
}

module.exports = {
	queueTask,
	defineEventHandler,
	defineEventHandlers,
}
