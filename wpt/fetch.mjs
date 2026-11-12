import Fs from 'node:fs/promises'
import Path from 'node:path'

export const COMMIT = 'ffe56d4420d270941329689aff42d925f615d0b4'

const ROOT = Path.join(import.meta.dirname, 'upstream')
const BASE = `https://raw.githubusercontent.com/web-platform-tests/wpt/${COMMIT}/`
const API = `https://api.github.com/repos/web-platform-tests/wpt/contents/`

export const DIRECTORIES = [
	'webaudio/resources',
	'webaudio/the-audio-api/processing-model',
	'webaudio/the-audio-api/the-analysernode-interface',
	'webaudio/the-audio-api/the-audiocontext-interface',
	'webaudio/the-audio-api/the-audioparam-interface',
	'webaudio/the-audio-api/the-audioworklet-interface',
	'webaudio/the-audio-api/the-audionode-interface',
	'webaudio/the-audio-api/the-audiobuffer-interface',
	'webaudio/the-audio-api/the-audiobuffersourcenode-interface',
	'webaudio/the-audio-api/the-biquadfilternode-interface',
	'webaudio/the-audio-api/the-channelmergernode-interface',
	'webaudio/the-audio-api/the-channelsplitternode-interface',
	'webaudio/the-audio-api/the-constantsourcenode-interface',
	'webaudio/the-audio-api/the-convolvernode-interface',
	'webaudio/the-audio-api/the-delaynode-interface',
	'webaudio/the-audio-api/the-destinationnode-interface',
	'webaudio/the-audio-api/the-dynamicscompressornode-interface',
	'webaudio/the-audio-api/the-gainnode-interface',
	'webaudio/the-audio-api/the-iirfilternode-interface',
	'webaudio/the-audio-api/the-mediastreamaudiodestinationnode-interface',
	'webaudio/the-audio-api/the-mediastreamaudiosourcenode-interface',
	'webaudio/the-audio-api/the-offlineaudiocontext-interface',
	'webaudio/the-audio-api/the-oscillatornode-interface',
	'webaudio/the-audio-api/the-pannernode-interface',
	'webaudio/the-audio-api/the-periodicwave-interface',
	'webaudio/the-audio-api/the-scriptprocessornode-interface',
	'webaudio/the-audio-api/the-stereopanner-interface',
	'webaudio/the-audio-api/the-waveshapernode-interface',
]

const FILES = [
	'LICENSE.md',
	'webaudio/js/helpers.js',
	'webaudio/the-audio-api/rendersizehint-smoke-tests.https.html',
	'resources/testharness.js',
	'resources/testharnessreport.js',
	'resources/testdriver.js',
	'resources/testdriver-vendor.js',
]

const listDirectory = async (directory) => {
	const response = await fetch(`${API}${directory}?ref=${COMMIT}`, { headers: { accept: 'application/vnd.github+json' } })
	if (!response.ok) { throw new Error(`listing ${directory}: ${response.status}`) }
	const entries = await response.json()
	const files = []
	for (const entry of entries) {
		if (entry.type === 'file') { files.push(`${directory}/${entry.name}`) }
		else if (entry.type === 'dir') { files.push(...await listDirectory(`${directory}/${entry.name}`)) }
	}
	return files
}

const download = async (file) => {
	const target = Path.join(ROOT, file)
	try {
		await Fs.access(target)
		return
	}
	catch {}
	const response = await fetch(BASE + file)
	if (!response.ok) { throw new Error(`fetching ${file}: ${response.status}`) }
	await Fs.mkdir(Path.dirname(target), { recursive: true })
	await Fs.writeFile(target, Buffer.from(await response.arrayBuffer()))
}

const main = async () => {
	const files = [ ...FILES ]
	for (const directory of DIRECTORIES) { files.push(...await listDirectory(directory)) }
	let index = 0
	const workers = Array.from({ length: 8 }, async () => {
		while (index < files.length) { await download(files[index++]) }
	})
	await Promise.all(workers)
	await Fs.writeFile(Path.join(ROOT, 'COMMIT'), `${COMMIT}\n`)
	console.log(`${files.length} files in ${ROOT}`)
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
