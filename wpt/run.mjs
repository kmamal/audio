import Fs from 'node:fs'
import Path from 'node:path'
import Os from 'node:os'
import Vm from 'node:vm'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

const require = createRequire(import.meta.url)
const ROOT = Path.join(import.meta.dirname, 'upstream')
const TESTS = Path.join(ROOT, 'webaudio/the-audio-api')
const EXPECTATIONS = Path.join(import.meta.dirname, 'expectations.json')
const REALTIME_EXPECTATIONS = Path.join(import.meta.dirname, 'expectations-realtime.json')
const FILE_TIMEOUT = 120e3

const TEST_STATUS = [ 'PASS', 'FAIL', 'TIMEOUT', 'NOTRUN', 'PRECONDITION_FAILED' ]
const HARNESS_STATUS = [ 'OK', 'ERROR', 'TIMEOUT', 'PRECONDITION_FAILED' ]

const runWorker = () => {
	const { file, realtime, trace } = workerData
	const audio = require('../src/index.js')
	if (realtime) {
		audio.configure({ workers: true })
		const { RealtimeOfflineAudioContext } = require('./realtime-offline.cjs')
		globalThis.OfflineAudioContext = RealtimeOfflineAudioContext
	}
	const { defaultFetch } = require('../src/config.js')
	const directory = Path.dirname(file)
	const relative = Path.relative(ROOT, file).split(Path.sep).join('/')

	const resolve = (reference) => reference.startsWith('/')
		? Path.join(ROOT, reference)
		: Path.resolve(directory, reference)

	for (const [ name, value ] of Object.entries(audio)) {
		if (!(name in globalThis)) { globalThis[name] = value }
	}
	globalThis.window = globalThis
	globalThis.self = globalThis
	const elements = []
	const document = {
		getElementsByTagName: () => [],
		querySelector: (selector) => {
			if (selector === 'canvas') {
				return {
					getContext: () => null,
					captureStream: () => new audio.MediaStream([ new audio.MediaStreamTrack({ kind: 'video' }) ]),
				}
			}
			const match = (/^script#(.+)$/u).exec(selector)
			return match && (elements.find((element) => element.id === match[1]) ?? null)
		},
		createElement: (tag) => {
			if (String(tag).toLowerCase() === 'audio') { return new audio.Audio() }
			throw new TypeError(`the WPT runner can not create <${tag}> elements`)
		},
	}
	globalThis.location = { href: pathToFileURL(file).href, pathname: `/${relative}`, search: '', hash: '' }

	globalThis.requestAnimationFrame = (callback) => setTimeout(() => { callback(performance.now()) }, 16)
	globalThis.cancelAnimationFrame = (id) => { clearTimeout(id) }
	const windowEvents = new EventTarget()
	let loadScheduled = false
	globalThis.addEventListener = (type, listener, options) => {
		windowEvents.addEventListener(type, listener, options)
		if (type !== 'load' || loadScheduled) { return }
		loadScheduled = true
		setTimeout(() => { windowEvents.dispatchEvent(new Event('load')) }, 0)
	}
	globalThis.removeEventListener = (type, listener, options) => { windowEvents.removeEventListener(type, listener, options) }
	globalThis.dispatchEvent = (event) => windowEvents.dispatchEvent(event)
	Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: audio.getMediaDevices(), configurable: true })
	const toPath = (location) => location.startsWith('/') || !(/^[a-z]+:/iu).test(location) ? resolve(location) : fileURLToPath(location)
	globalThis.XMLHttpRequest = class XMLHttpRequest extends EventTarget {
		constructor () {
			super()
			this.responseType = ''
			this.response = null
			this.responseText = ''
			this.status = 0
			this.onload = null
			this.onerror = null
			this._url = null
		}

		open (method, url) { this._url = String(url) }

		setRequestHeader () {}

		send () {
			Fs.promises.readFile(toPath(this._url)).then(
				(buffer) => {
					this.status = 200
					if (this.responseType === 'arraybuffer') { this.response = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) }
					else if (this.responseType === 'json') { this.response = JSON.parse(buffer.toString()) }
					else {
						this.response = buffer.toString()
						this.responseText = this.response
					}
					this.onload?.(new Event('load'))
					this.dispatchEvent(new Event('load'))
				},
				() => {
					this.status = 404
					this.onerror?.(new Event('error'))
					this.dispatchEvent(new Event('error'))
				},
			)
		}
	}
	const { resolveObjectURL } = require('node:buffer')
	const WORKER_PRELUDE = [
		"const { parentPort } = require('node:worker_threads')",
		'globalThis.self = globalThis',
		'globalThis.postMessage = (message, transfer) => { parentPort.postMessage(message, transfer) }',
		"parentPort.on('message', (data) => { globalThis.onmessage?.({ data }) })",
	].join('\n')
	globalThis.Worker = class WebWorker extends EventTarget {
		constructor (url) {
			super()
			this.onmessage = null
			this._worker = null
			this._pending = []
			const href = String(url)
			const blob = resolveObjectURL(href)
			const source = blob ? blob.text() : Fs.promises.readFile(resolve(href), 'utf8')
			source.then((code) => {
				const worker = new Worker(`${WORKER_PRELUDE}\n${code}`, { eval: true, execArgv: [] })
				worker.unref()
				worker.on('message', (data) => {
					const event = new MessageEvent('message', { data })
					this.onmessage?.(event)
					this.dispatchEvent(event)
				})
				this._worker = worker
				for (const { message, transfer } of this._pending) { worker.postMessage(message, transfer) }
				this._pending = []
			})
		}

		postMessage (message, transfer = []) {
			if (this._worker !== null) {
				this._worker.postMessage(message, transfer)
				return
			}
			this._pending.push(structuredClone({ message, transfer }, { transfer }))
		}

		terminate () {
			this._worker?.terminate()
			this._pending = []
		}
	}
	globalThis.fetch = (url, init) => {
		const location = String(url)
		if (location.startsWith('/') || !(/^[a-z]+:/iu).test(location)) { return defaultFetch(resolve(location), init) }
		return defaultFetch(location, init)
	}

	const { addModule: addModuleBase } = audio.AudioWorklet.prototype
	audio.AudioWorklet.prototype.addModule = function addModule (moduleURL) {
		const location = String(moduleURL)
		const resolved = location.startsWith('/') || !(/^[a-z]+:/iu).test(location) ? resolve(location) : location
		return addModuleBase.call(this, resolved)
	}

	const results = { file: relative, harness: 'TIMEOUT', message: null, tests: [] }
	let finished = false
	const finish = () => {
		if (finished) { return }
		finished = true
		parentPort.postMessage(results)
		setTimeout(() => process.exit(0), 10).unref()
	}

	const timer = setTimeout(() => {
		results.harness = 'TIMEOUT'
		results.message = `no completion after ${FILE_TIMEOUT / 1000}s`
		finish()
	}, FILE_TIMEOUT)

	const scripts = []
	if (file.endsWith('.window.js')) {
		const source = Fs.readFileSync(file, 'utf8')
		scripts.push({ path: Path.join(ROOT, 'resources/testharness.js') })
		scripts.push({ path: Path.join(ROOT, 'resources/testharnessreport.js') })
		for (const match of source.matchAll(/^\/\/ META: script=(.+)$/gmu)) { scripts.push({ path: resolve(match[1].trim()) }) }
		scripts.push({ path: file, source })
	}
	else {
		const html = Fs.readFileSync(file, 'utf8')
		const attribute = (attributes, name) => {
			const match = new RegExp(`\\b${name}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`, 'iu').exec(attributes)
			return match ? match[1] ?? match[2] : null
		}
		for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)) {
			const src = attribute(match[1], 'src')
			const id = attribute(match[1], 'id')
			const type = attribute(match[1], 'type') ?? ''
			if (id !== null) { elements.push({ id, type, innerText: match[2], textContent: match[2] }) }
			if (!(/^(?:|module|(?:text|application)\/(?:java|ecma)script)$/iu).test(type.trim())) { continue }
			if (src !== null) { scripts.push({ path: resolve(src) }) }
			else if (match[2].trim() !== '') { scripts.push({ path: file, source: match[2] }) }
		}
	}

	let hooked = false
	try {
		for (const script of scripts) {
			const source = script.source ?? Fs.readFileSync(script.path, 'utf8')
			Vm.runInThisContext(source, { filename: script.path })
			if (!hooked && typeof globalThis.add_completion_callback === 'function') {
				hooked = true
				globalThis.document = document
				if (trace) {
					globalThis.add_result_callback((test) => { console.error(`[${TEST_STATUS[test.status] ?? test.status}] ${test.name}${test.message ? `: ${test.message}` : ''}`) })
				}
				globalThis.add_completion_callback((tests, status) => {
					clearTimeout(timer)
					results.harness = HARNESS_STATUS[status.status] ?? String(status.status)
					results.message = status.message ?? null
					results.tests = tests.map((test) => ({
						name: test.name,
						status: TEST_STATUS[test.status] ?? String(test.status),
						message: test.message ?? null,
					}))
					finish()
				})
			}
		}
		if (!hooked) {
			clearTimeout(timer)
			results.harness = 'OK'
			finish()
		}
	}
	catch (error) {
		clearTimeout(timer)
		results.harness = 'ERROR'
		results.message = error?.stack ?? String(error)
		finish()
	}
}

const listTests = (filter) => {
	const files = []
	const visit = (directory) => {
		for (const entry of Fs.readdirSync(directory, { withFileTypes: true })) {
			const full = Path.join(directory, entry.name)
			if (entry.isDirectory()) {
				if (entry.name !== 'resources') { visit(full) }
			}
			else if ((/\.(?:html|window\.js)$/u).test(entry.name)) { files.push(full) }
		}
	}
	visit(TESTS)
	files.sort()
	return files.filter((file) => filter.length === 0 || filter.some((part) => file.includes(part)))
}

const loadExpectations = (path) => {
	try { return JSON.parse(Fs.readFileSync(path, 'utf8')) }
	catch { return { skip: [], files: {} } }
}

const runFile = (file, realtime, trace) => new Promise((resolve) => {
	const worker = new Worker(new URL(import.meta.url), { workerData: { file, realtime, trace }, execArgv: [], stdout: true, stderr: true })
	if (trace) {
		worker.stdout.pipe(process.stdout)
		worker.stderr.pipe(process.stderr)
	}
	let result = null
	worker.on('message', (message) => { result = message })
	worker.on('error', (error) => {
		result ??= { file: Path.relative(ROOT, file), harness: 'ERROR', message: error.stack ?? String(error), tests: [] }
	})
	worker.on('exit', () => {
		resolve(result ?? { file: Path.relative(ROOT, file), harness: 'ERROR', message: 'worker exited without results', tests: [] })
	})
})

const main = async () => {
	const args = process.argv.slice(2)
	const update = args.includes('--update')
	const verbose = args.includes('--verbose')
	const realtime = args.includes('--realtime')
	const trace = args.includes('--trace')
	const filter = args.filter((arg) => !arg.startsWith('--'))
	const expectationsPath = realtime ? REALTIME_EXPECTATIONS : EXPECTATIONS
	const expectations = loadExpectations(expectationsPath)
	const skip = new Set([ ...loadExpectations(EXPECTATIONS).skip ?? [], ...expectations.skip ?? [] ])

	try { require('@kmamal/sdl') }
	catch {}

	const files = listTests(filter).filter((file) => !skip.has(Path.relative(ROOT, file)))
	const results = []
	let index = 0
	const workers = Array.from({ length: Math.max(1, Os.availableParallelism() - 1) }, async () => {
		while (index < files.length) {
			const file = files[index++]
			const result = await runFile(file, realtime, trace)
			results.push(result)
			report(result, expectations, verbose)
		}
	})
	await Promise.all(workers)
	results.sort((a, b) => a.file < b.file ? -1 : 1)

	let total = 0
	let passed = 0
	for (const result of results) {
		total += result.tests.length
		passed += result.tests.filter((test) => test.status === 'PASS').length
	}
	console.log(`\n${results.length} files, ${passed}/${total} tests pass`)

	if (update) {
		const out = { skip: expectations.skip ?? [], files: { ...expectations.files } }
		for (const result of results) {
			delete out.files[result.file]
			const failing = Object.fromEntries(result.tests.filter((test) => test.status !== 'PASS').map((test) => [ test.name, test.status ]))
			if (result.harness === 'OK' && Object.keys(failing).length === 0) { continue }
			out.files[result.file] = { harness: result.harness, tests: failing }
		}
		out.files = Object.fromEntries(Object.entries(out.files).sort(([ a ], [ b ]) => a < b ? -1 : 1))
		Fs.writeFileSync(expectationsPath, `${JSON.stringify(out, null, '\t')}\n`)
		console.log(`wrote ${expectationsPath}`)
		return
	}

	const unexpected = results.flatMap((result) => differences(result, expectations))
	if (unexpected.length > 0) {
		console.log(`\n${unexpected.length} unexpected results:`)
		for (const line of unexpected) { console.log(`  ${line}`) }
		process.exitCode = 1
	}
}

const differences = (result, expectations) => {
	const expected = expectations.files?.[result.file] ?? { harness: 'OK', tests: {} }
	const out = []
	if (result.harness !== expected.harness) { out.push(`${result.file}: harness ${result.harness}, expected ${expected.harness}${result.message ? ` (${firstLine(result.message)})` : ''}`) }
	const seen = new Set()
	for (const test of result.tests) {
		seen.add(test.name)
		const want = expected.tests[test.name] ?? 'PASS'
		if (test.status !== want) { out.push(`${result.file}: "${test.name}" ${test.status}, expected ${want}${test.message ? ` (${firstLine(test.message)})` : ''}`) }
	}
	for (const [ name, want ] of Object.entries(expected.tests)) {
		if (!seen.has(name)) { out.push(`${result.file}: "${firstLine(name)}" missing, expected ${want}`) }
	}
	return out
}

const firstLine = (text) => String(text).split('\n')[0].slice(0, 200)

const report = (result, expectations, verbose) => {
	const passing = result.tests.filter((test) => test.status === 'PASS').length
	const changed = differences(result, expectations)
	const mark = result.harness === 'OK' && passing === result.tests.length ? 'PASS' : 'FAIL'
	console.log(`${mark} ${String(passing).padStart(3)}/${String(result.tests.length).padEnd(3)} ${result.file}${changed.length > 0 ? ` (${changed.length} unexpected)` : ''}`)
	if (verbose || changed.length > 0) {
		if (result.harness !== 'OK' && result.message) { console.log(`       harness ${result.harness}: ${firstLine(result.message)}`) }
		for (const test of result.tests) {
			if (test.status === 'PASS') { continue }
			console.log(`       ${test.status} ${test.name}${test.message ? `: ${firstLine(test.message)}` : ''}`)
		}
	}
}

if (isMainThread) {
	main().catch((error) => {
		console.error(error)
		process.exit(1)
	})
}
else {
	runWorker()
}
