const Fs = require('node:fs/promises')
const { isMainThread } = require('node:worker_threads')
const Path = require('node:path')
const { fileURLToPath } = require('node:url')

const REMOTE = /^(?:https?|data|blob):/iu

const MIME_TYPES = {
	'.wav': 'audio/wav',
	'.mp3': 'audio/mpeg',
	'.ogg': 'audio/ogg',
	'.oga': 'audio/ogg',
	'.opus': 'audio/ogg',
	'.flac': 'audio/flac',
	'.aif': 'audio/aiff',
	'.aiff': 'audio/aiff',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
}

const nativeFetch = globalThis.fetch

const decodePath = (location) => {
	try { return decodeURIComponent(location) }
	catch { return location }
}

const defaultFetch = async (url, init) => {
	const location = String(url)
	if (REMOTE.test(location)) { return nativeFetch(location, init) }

	let filePath
	if (location.startsWith('file:')) { filePath = fileURLToPath(location) }
	else { filePath = Path.resolve(decodePath(location)) }

	try {
		const buffer = await Fs.readFile(filePath)
		const type = MIME_TYPES[Path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
		return new Response(buffer, { status: 200, headers: { 'content-type': type } })
	}
	catch (error) {
		return new Response(null, { status: error.code === 'ENOENT' ? 404 : 500, statusText: error.message })
	}
}

const config = {
	fetch: null,
	workers: isMainThread,
}

const configure = (options = {}) => {
	if (options.fetch !== undefined) {
		if (options.fetch !== null && typeof options.fetch !== 'function') { throw new TypeError("fetch must be a function or null") }
		config.fetch = options.fetch
	}
	if (options.workers !== undefined) {
		if (typeof options.workers !== 'boolean') { throw new TypeError("workers must be a boolean") }
		config.workers = options.workers
	}
}

const getFetch = () => config.fetch ?? defaultFetch

const useWorkers = () => config.workers

module.exports = { configure, getFetch, defaultFetch, useWorkers, decodePath }
