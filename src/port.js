const detachPort = (port, context) => {
	port.unref()
	context._ports.add(new WeakRef(port))
	return port
}

const releasePorts = (context) => {
	for (const ref of context._ports) {
		const port = ref.deref()
		if (port === undefined) { continue }
		port.unref()
		port.ref = () => {}
	}
	context._ports.clear()
}

module.exports = { detachPort, releasePorts }
