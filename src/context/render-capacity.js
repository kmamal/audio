const { CLOCK } = require('./clock')
const { defineEventHandlers } = require('../events')
const { checkFinite } = require('../errors')
const Timers = require('node:timers')

class AudioRenderCapacityEvent extends Event {
	constructor (type, init = {}) {
		super(type)
		this.timestamp = init.timestamp ?? 0
		this.averageLoad = init.averageLoad ?? 0
		this.peakLoad = init.peakLoad ?? 0
		this.underrunRatio = init.underrunRatio ?? 0
	}
}

class AudioRenderCapacity extends EventTarget {
	constructor (context) {
		super()
		this._context = context
		this._timer = null
		this._last = null
	}

	start (options = {}) {
		if (typeof options !== 'object' || options === null) { throw new TypeError("options must be an object") }
		const updateInterval = options.updateInterval === undefined ? 1 : checkFinite(options.updateInterval, 'updateInterval')
		if (updateInterval <= 0) { throw new RangeError("updateInterval must be positive") }
		this.stop()
		this._last = this._sample()
		this._context._clock[CLOCK.PEAK] = 0
		this._timer = Timers.setInterval(() => { this._update() }, updateInterval * 1000)
		this._timer.unref()
	}

	stop () {
		if (this._timer === null) { return }
		Timers.clearInterval(this._timer)
		this._timer = null
	}

	_sample () {
		const clock = this._context._clock
		return { busy: clock[CLOCK.BUSY], rendered: clock[CLOCK.RENDERED], underruns: clock[CLOCK.UNDERRUNS] }
	}

	_update () {
		const context = this._context
		if (context.state === 'closed') {
			this.stop()
			return
		}
		const now = this._sample()
		const last = this._last
		this._last = now
		const clock = context._clock
		const peakLoad = clock[CLOCK.PEAK]
		clock[CLOCK.PEAK] = 0
		const frames = now.rendered - last.rendered
		const seconds = frames / context.sampleRate
		const quanta = frames / context.renderQuantumSize
		const averageLoad = seconds > 0 ? (now.busy - last.busy) / seconds : 0
		const underrunRatio = quanta > 0 ? Math.min((now.underruns - last.underruns) / quanta, 1) : 0
		this.dispatchEvent(new AudioRenderCapacityEvent('update', {
			timestamp: context.currentTime,
			averageLoad: Math.round(averageLoad * 100) / 100,
			peakLoad: Math.round(peakLoad * 100) / 100,
			underrunRatio: Math.round(underrunRatio * 100) / 100,
		}))
	}
}

defineEventHandlers(AudioRenderCapacity.prototype, [ 'update' ])

module.exports = { AudioRenderCapacity, AudioRenderCapacityEvent }
