const { CLOCK } = require('./clock')

class AudioPlaybackStats {
	constructor (context) {
		this._context = context
		this._latency = null
		this._snapshot = null
	}

	_current () {
		if (this._snapshot !== null) { return this._snapshot }
		const context = this._context
		if (context._remote === null) { context._catchUp() }
		const clock = context._clock
		const sampleRate = context._sampleRate
		const rendered = clock[CLOCK.RENDERED]
		if (rendered > 0) {
			const latency = context.outputLatency
			const stats = this._latency
			if (stats === null) { this._latency = { min: latency, max: latency, sum: latency, count: 1 } }
			else {
				stats.min = Math.min(stats.min, latency)
				stats.max = Math.max(stats.max, latency)
				stats.sum += latency
				stats.count++
			}
		}
		const stats = this._latency
		const totalDuration = rendered / sampleRate
		const underrunEvents = clock[CLOCK.UNDERRUNS]
		this._snapshot = {
			totalDuration,
			underrunDuration: Math.min(underrunEvents * context._buffered / sampleRate, totalDuration),
			underrunEvents,
			minimumLatency: stats === null ? 0 : stats.min,
			maximumLatency: stats === null ? 0 : stats.max,
			averageLatency: stats === null ? 0 : stats.sum / stats.count,
		}
		queueMicrotask(() => { this._snapshot = null })
		return this._snapshot
	}

	get totalDuration () { return this._current().totalDuration }
	get underrunDuration () { return this._current().underrunDuration }
	get underrunEvents () { return this._current().underrunEvents }
	get minimumLatency () { return this._current().minimumLatency }
	get maximumLatency () { return this._current().maximumLatency }
	get averageLatency () { return this._current().averageLatency }

	resetLatency () {
		this._latency = null
		this._snapshot = null
	}

	toJSON () { return { ...this._current() } }
}

module.exports = { AudioPlaybackStats }
