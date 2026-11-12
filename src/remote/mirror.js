const { currentClient } = require('./client')

let depth = 0

const forward = (object) => depth === 0 && object._ridOwner !== undefined && object._ridOwner === currentClient()

const wrapMethod = (proto, name) => {
	const original = proto[name]
	const wrapped = {
		[name] (...args) {
			if (!forward(this)) { return original.apply(this, args) }
			depth++
			let result
			try { result = original.apply(this, args) }
			finally { depth-- }
			currentClient().send(this, name, args, { copyShared: true })
			return result
		},
	}[name]
	Object.defineProperty(proto, name, { ...Object.getOwnPropertyDescriptor(proto, name), value: wrapped })
}

const wrapSetter = (proto, name) => {
	const descriptor = Object.getOwnPropertyDescriptor(proto, name)
	const { get, set } = descriptor
	Object.defineProperty(proto, name, {
		...descriptor,
		get,
		set (value) {
			if (!forward(this)) {
				set.call(this, value)
				return
			}
			depth++
			try { set.call(this, value) }
			finally { depth-- }
			currentClient().assign(this, name, value, { copyShared: true })
		},
	})
}

const installMirrors = (table) => {
	for (const [ Class, methods, setters ] of table) {
		for (const name of methods) { wrapMethod(Class.prototype, name) }
		for (const name of setters) { wrapSetter(Class.prototype, name) }
	}
}

module.exports = { installMirrors }
