const Fs = require('node:fs/promises')
const Path = require('node:path')
const Vm = require('node:vm')
const { pathToFileURL, fileURLToPath } = require('node:url')
const { resolveObjectURL } = require('node:buffer')
const { notSupportedError, abortError, dataCloneError } = require('../errors')
const { getFetch, decodePath } = require('../config')
const { detachPort } = require('../port')
const { WorkletMessagePort, wrapPort, guarded } = require('./port')
const { notify } = require('../remote/notify')

const PROCESSOR_PORT = Symbol('processorPort')

const MODULE_SYNTAX = /^\s*(?:import\s*[\w{*'"]|export\s+(?:default|const|let|var|function|class|async|\{|\*))/mu

const registry = new Map()
const scope = {
	current: null,
	last: null,
	construction: null,
	get context () { return this.current ?? this.last },
	set context (context) {
		this.current = context
		if (context !== null) { this.last = context }
	},
}

class AudioWorkletProcessor {
	constructor () {
		if (scope.construction === null) {
			const Ctor = scope.context?._workletScope?.TypeError ?? TypeError
			throw new Ctor("AudioWorkletProcessor can only be constructed by the audio engine")
		}
		this.port = wrapPort(scope.construction.port)
		scope.construction = null
	}
}

const parseDescriptors = (descriptors) => {
	const out = []
	if (descriptors === undefined || descriptors === null) { return out }
	const names = new Set()
	for (const descriptor of descriptors) {
		const name = String(descriptor.name)
		if (names.has(name)) { throw notSupportedError(`duplicate parameter descriptor '${name}'`) }
		names.add(name)
		const defaultValue = descriptor.defaultValue === undefined ? 0 : Number(descriptor.defaultValue)
		const minValue = descriptor.minValue === undefined ? -3.4028234663852886e38 : Number(descriptor.minValue)
		const maxValue = descriptor.maxValue === undefined ? 3.4028234663852886e38 : Number(descriptor.maxValue)
		if (minValue > maxValue) { throw new DOMException(`minValue of '${name}' is greater than maxValue`, 'InvalidStateError') }
		if (defaultValue < minValue || defaultValue > maxValue) { throw new DOMException(`defaultValue of '${name}' is out of range`, 'InvalidStateError') }
		const automationRate = descriptor.automationRate === undefined ? 'a-rate' : descriptor.automationRate
		if (automationRate !== 'a-rate' && automationRate !== 'k-rate') { throw new TypeError("automationRate must be 'a-rate' or 'k-rate'") }
		out.push({ name, defaultValue, minValue, maxValue, automationRate })
	}
	return out
}

const register = (processors, processorName, processorCtor, href = null, realm = globalThis) => {
	const name = String(processorName)
	if (name === '') { throw notSupportedError("processor name must not be empty") }
	if (processors.has(name)) { throw notSupportedError(`processor '${name}' is already registered`) }
	if (typeof processorCtor !== 'function') { throw new TypeError("processor must be a class") }
	const { prototype } = processorCtor
	if (typeof prototype !== 'object' || prototype === null) { throw new TypeError("processor prototype must be an object") }
	const descriptors = parseDescriptors(processorCtor.parameterDescriptors)
	processors.set(name, { Ctor: processorCtor, descriptors, href, realm })
}

const registerProcessor = (processorName, processorCtor) => { register(registry, processorName, processorCtor) }

let globalsInstalled = false

const installGlobals = () => {
	if (globalsInstalled) { return }
	globalsInstalled = true
	const define = (name, descriptor) => {
		if (name in globalThis) { return }
		Object.defineProperty(globalThis, name, { configurable: true, enumerable: false, ...descriptor })
	}
	define('registerProcessor', { value: registerProcessor, writable: true })
	define('AudioWorkletProcessor', { value: AudioWorkletProcessor, writable: true })
	define('sampleRate', { get: () => scope.context?.sampleRate ?? 0 })
	define('currentTime', { get: () => scope.context?.currentTime ?? 0 })
	define('currentFrame', { get: () => scope.context?._frame ?? 0 })
}

const SHARED_GLOBALS = [
	'console',
	'URL',
	'URLSearchParams',
	'TextEncoder',
	'TextDecoder',
	'atob',
	'btoa',
	'queueMicrotask',
	'structuredClone',
	'performance',
	'MessageChannel',
	'DOMException',
]

const BINARY_GLOBALS = [
	'ArrayBuffer',
	'SharedArrayBuffer',
	'DataView',
	'Int8Array',
	'Uint8Array',
	'Uint8ClampedArray',
	'Int16Array',
	'Uint16Array',
	'Int32Array',
	'Uint32Array',
	'Float32Array',
	'Float64Array',
	'BigInt64Array',
	'BigUint64Array',
	'WebAssembly',
]

const makeScope = (context, port) => {
	const processors = new Map()
	const scope = { processors, vmContext: null, modules: new Map(), evaluating: null, port }
	const globals = {
		registerProcessor: (name, Ctor) => {
			register(processors, name, Ctor, scope.evaluating, scope.realm)
			if (scope.evaluating === null) {
				const key = String(name)
				notify(context, 'processorRegistered', { name: key, descriptors: processors.get(key).descriptors }, undefined, true)
			}
		},
		AudioWorkletProcessor,
		MessagePort: WorkletMessagePort,
		port: wrapPort(port),
	}
	for (const name of [ ...SHARED_GLOBALS, ...BINARY_GLOBALS ]) {
		if (name in globalThis) { globals[name] = globalThis[name] }
	}
	globals.queueMicrotask = (callback) => { queueMicrotask(guarded(callback)) }
	Object.defineProperty(globals, 'sampleRate', { enumerable: true, get: () => context.sampleRate })
	Object.defineProperty(globals, 'currentTime', { enumerable: true, get: () => context.currentTime })
	Object.defineProperty(globals, 'currentFrame', { enumerable: true, get: () => context._frame })
	Object.defineProperty(globals, 'renderQuantumSize', { enumerable: true, get: () => context._quantum })
	scope.vmContext = Vm.createContext(globals, { name: 'AudioWorkletGlobalScope' })
	globals.self = Vm.runInContext('globalThis', scope.vmContext)
	scope.TypeError = Vm.runInContext('TypeError', scope.vmContext)
	scope.realm = globals.self
	return scope
}

const getScope = (context, port = null) => {
	if (context._workletScope === undefined) {
		if (port === null) {
			const channel = new MessageChannel()
			context._workletPort = detachPort(channel.port1, context)
			port = detachPort(channel.port2, context)
		}
		context._workletScope = makeScope(context, port)
	}
	return context._workletScope
}

const decodeDataUrl = (location) => {
	const comma = location.indexOf(',')
	if (comma === -1) { throw abortError(`invalid data URL`) }
	const meta = location.slice(5, comma)
	const body = location.slice(comma + 1)
	return meta.endsWith(';base64') ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body)
}

let remoteFetch = null

const setRemoteFetch = (fn) => { remoteFetch = fn }

const fetchSource = async (href) => {
	if (href.startsWith('blob:')) {
		const blob = resolveObjectURL(href)
		if (blob === undefined) { throw abortError(`worklet module '${href}' was not found`) }
		return blob.text()
	}
	if (href.startsWith('data:')) { return decodeDataUrl(href) }
	if ((/^https?:/iu).test(href)) {
		if (remoteFetch !== null) { return remoteFetch(href) }
		const response = await getFetch()(href)
		if (!response.ok) { throw abortError(`failed to load worklet module '${href}' (${response.status})`) }
		return response.text()
	}
	if (href.startsWith('file:')) {
		try { return await Fs.readFile(fileURLToPath(href), 'utf8') }
		catch { throw abortError(`worklet module '${href}' was not found`) }
	}
	throw abortError(`unsupported worklet module URL '${href}'`)
}

const resolveModule = async (url) => {
	const location = String(url)
	let href
	if ((/^(?:blob|data|https?):/iu).test(location)) { href = location }
	else if (location.startsWith('file:')) { href = location }
	else { href = pathToFileURL(Path.resolve(decodePath(location))).href }
	const code = await fetchSource(href)
	return { href, code }
}

const evaluateModule = async (context, { href, code }, port) => {
	const scope = getScope(context, port)
	const { vmContext, modules } = scope

	const load = async (identifier, source) => {
		let module = modules.get(identifier)
		if (module) { return module }
		module = new Vm.SourceTextModule(source, { context: vmContext, identifier, importModuleDynamically })
		modules.set(identifier, module)
		await module.link(linker)
		return module
	}

	const linker = async (specifier, referencing) => {
		let target
		try { target = new URL(specifier, referencing.identifier).href }
		catch { throw abortError(`can not resolve '${specifier}' from '${referencing.identifier}'`) }
		return load(target, await fetchSource(target))
	}

	const importModuleDynamically = async (specifier, referencing) => {
		const module = await linker(specifier, referencing)
		if (module.status === 'linked') { await module.evaluate() }
		return module
	}

	const module = await load(href, code)
	scope.evaluating = href
	try {
		if (module.status === 'linked') { await module.evaluate() }
	}
	finally {
		scope.evaluating = null
	}
}

const evaluateScript = (context, { href, code }, port) => {
	const scope = getScope(context, port)
	const script = new Vm.Script(`(() => {\n${code}\n})()`, { filename: href, lineOffset: -1 })
	scope.evaluating = href
	try {
		script.runInContext(scope.vmContext)
	}
	finally {
		scope.evaluating = null
	}
}

const loadModule = async (context, resolved, port = null) => {
	try {
		if (Vm.SourceTextModule !== undefined) {
			await evaluateModule(context, resolved, port)
		}
		else if (!MODULE_SYNTAX.test(resolved.code)) {
			evaluateScript(context, resolved, port)
		}
		else {
			installGlobals()
			const previous = scope.context
			scope.context = context
			try {
				const { href, code } = resolved
				await import(href.startsWith('blob:') ? `data:text/javascript;base64,${Buffer.from(code).toString('base64')}` : href)
			}
			finally {
				scope.context = previous
			}
		}
	}
	catch (error) {
		if (error instanceof DOMException) { throw error }
		throw abortError(`failed to load worklet module: ${error.message}`)
	}
}

const snapshotRegistry = (context) => {
	const processors = context._workletScope?.processors ?? new Map()
	const entries = Array.from(processors, ([ name, { descriptors } ]) => ({ name, descriptors }))
	for (const [ name, { descriptors } ] of registry) {
		if (!processors.has(name)) { entries.push({ name, descriptors }) }
	}
	return entries
}

class AudioWorklet {
	constructor (context) {
		this._context = context
		this._loaded = new Set()
		this._port = null
		this._scopePort = null
	}

	get port () {
		if (this._port === null) {
			const channel = new MessageChannel()
			this._port = detachPort(channel.port1, this._context)
			this._scopePort = detachPort(channel.port2, this._context)
		}
		return this._port
	}

	_takeScopePort () {
		this.port
		const port = this._scopePort
		this._scopePort = null
		return port
	}

	async addModule (moduleURL) {
		const resolved = await resolveModule(moduleURL)
		if (this._loaded.has(resolved.href)) { return }
		const remote = this._context._remote
		if (remote === null) {
			if (this._context._workletScope === undefined) {
				const port = this._takeScopePort()
				this._context._workletPort = this._port
				await loadModule(this._context, resolved, port)
			}
			else {
				await loadModule(this._context, resolved)
			}
		}
		else {
			let processors
			try {
				const payload = { context: this._context, source: resolved }
				if (!this._sentPort) {
					this._sentPort = true
					payload.port = this._takeScopePort()
				}
				processors = await remote.request('addModule', payload)
			}
			catch (error) {
				throw abortError(error.message)
			}
			const known = getRemoteProcessors(this._context)
			for (const { name, descriptors } of processors) { known.set(name, { descriptors }) }
		}
		this._loaded.add(resolved.href)
	}
}

const getRemoteProcessors = (context) => {
	if (context._remoteProcessors === undefined) { context._remoteProcessors = new Map() }
	return context._remoteProcessors
}

const getProcessor = (name, context = null) => {
	if (context !== null && context._remote !== null) { return getRemoteProcessors(context).get(name) ?? null }
	return context?._workletScope?.processors.get(name) ?? registry.get(name) ?? null
}

const withScope = (context, callback) => {
	const previous = scope.context
	scope.context = context
	try { return callback() }
	finally { scope.context = previous }
}

const UNEXPOSED = [ 'Blob', 'CryptoKey' ].map((name) => globalThis[name]).filter((Ctor) => typeof Ctor === 'function')

const checkDeserializable = (value, seen = new Set()) => {
	if (typeof value !== 'object' || value === null || seen.has(value)) { return }
	seen.add(value)
	for (const Ctor of UNEXPOSED) {
		if (value instanceof Ctor) { throw dataCloneError(`a ${Ctor.name} can not be deserialized in an AudioWorkletGlobalScope`) }
	}
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) { return }
	if (value instanceof Map) {
		for (const [ key, item ] of value) {
			checkDeserializable(key, seen)
			checkDeserializable(item, seen)
		}
	}
	else if (value instanceof Set) {
		for (const item of value) { checkDeserializable(item, seen) }
	}
	else {
		for (const key of Object.keys(value)) { checkDeserializable(value[key], seen) }
	}
}

const construct = (context, entry, options, port) => withScope(context, () => {
	checkDeserializable(options.processorOptions)
	scope.construction = { port }
	let processor
	try { processor = new entry.Ctor(options) }
	finally { scope.construction = null }
	if (typeof processor !== 'object' || processor === null) { throw new TypeError("the processor constructor did not return an object") }
	return processor
})

const LOCATION = /(?:\(|at )((?:file|https?|blob|data):[^\s()]+?):(\d+):(\d+)\)?\s*$/mu

const describeError = (error, entry) => {
	const out = { name: null, message: null, stack: null, filename: entry?.href ?? '', lineno: 0, colno: 0 }
	if (error instanceof Error || (typeof error === 'object' && error !== null && typeof error.message === 'string')) {
		out.name = error.name
		out.message = error.message
		out.stack = error.stack
		const match = typeof error.stack === 'string' ? LOCATION.exec(error.stack) : null
		if (match) {
			out.filename = match[1]
			out.lineno = Number(match[2])
			out.colno = Number(match[3])
		}
	}
	else {
		out.message = String(error)
	}
	return out
}

module.exports = {
	PROCESSOR_PORT,
	getRemoteProcessors,
	fetchSource,
	setRemoteFetch,
	loadModule,
	snapshotRegistry,
	AudioWorklet,
	AudioWorkletProcessor,
	registerProcessor,
	getProcessor,
	withScope,
	construct,
	describeError,
	installGlobals,
}
