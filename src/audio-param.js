const { MOST_POSITIVE_FLOAT } = require('./constants')
const { checkFinite, checkFloat, invalidStateError, notSupportedError } = require('./errors')
const { mixAdd, makeChannels } = require('./mixing')

const checkTime = (time, what = 'time') => {
	const value = checkFinite(time, what)
	if (value < 0) { throw new RangeError(`${what} must be non-negative`) }
	return value
}

const targetAt = (target, time) => target.value + (target.v0 - target.value) * Math.exp(-(time - target.t0) / target.tau)

const curveEnd = (event) => event.cutoff ?? event.time + event.duration

class AudioParam {
	constructor (context, options = {}) {
		const {
			defaultValue = 0,
			minValue = -MOST_POSITIVE_FLOAT,
			maxValue = MOST_POSITIVE_FLOAT,
			automationRate = 'a-rate',
			fixedRate = false,
			name = '',
		} = options

		this._context = context
		this._name = name
		this._defaultValue = Math.fround(defaultValue)
		this._minValue = Math.fround(minValue)
		this._maxValue = Math.fround(maxValue)
		this._automationRate = automationRate
		this._fixedRate = fixedRate

		this._v0 = this._defaultValue
		this._t0 = 0
		this._anchored = false
		this._target = null
		this._events = []

		this._inputs = new Set()
		this._inputMix = makeChannels(1, context._quantum)

		this._blockId = -1
		this._values = new Float32Array(context._quantum)
		this._constant = true
		this._lastValue = this._defaultValue
	}

	get defaultValue () { return this._defaultValue }
	get minValue () { return this._minValue }
	get maxValue () { return this._maxValue }

	get automationRate () { return this._automationRate }
	set automationRate (rate) {
		if (rate !== 'a-rate' && rate !== 'k-rate') { throw new TypeError("automationRate must be 'a-rate' or 'k-rate'") }
		if (this._fixedRate && rate !== this._automationRate) { throw invalidStateError(`automationRate of ${this._name} can not be changed`) }
		this._automationRate = rate
	}

	get value () {
		if (this._blockId === this._context._blockId) { return Math.fround(this._lastValue) }
		return Math.fround(this._clamp(this._evaluate(this._context.currentTime)))
	}

	set value (value) {
		const v = checkFloat(value, 'value')
		if (this._events.length === 0 && this._target === null) {
			this._v0 = v
			this._t0 = this._context.currentTime
			this._anchored = true
		}
		else {
			this.setValueAtTime(v, this._context.currentTime)
		}
		this._lastValue = this._clamp(v)
	}

	_now (time) {
		return Math.max(time, this._context.currentTime)
	}

	_clamp (value) {
		return Math.min(Math.max(value, this._minValue), this._maxValue)
	}

	_checkCurveOverlap (time, duration = 0) {
		const end = time + duration
		for (const event of this._events) {
			if (event.type === 'curve') {
				const eventEnd = curveEnd(event)
				if (duration === 0) {
					if (time >= event.time && time < eventEnd) { throw notSupportedError("automation event overlaps a setValueCurveAtTime event") }
				}
				else if (time < eventEnd && event.time < end) {
					throw notSupportedError("setValueCurveAtTime overlaps another setValueCurveAtTime event")
				}
			}
			else if (duration > 0 && event.time > time && event.time < end) {
				throw notSupportedError("setValueCurveAtTime overlaps another event")
			}
		}
	}

	_insert (event) {
		if (this._context._remote !== null) { this._advance(this._context.currentTime) }
		const events = this._events
		let index = events.length
		while (index > 0 && events[index - 1].time > event.time) { index-- }
		events.splice(index, 0, event)
		return this
	}

	_ensureStart () {
		if (this._anchored) { return }
		this._anchored = true
		if (this._events.length === 0 && this._target === null) {
			this._t0 = this._context.currentTime
		}
	}

	setValueAtTime (value, startTime) {
		const v = checkFloat(value, 'value')
		const t = this._now(checkTime(startTime, 'startTime'))
		this._checkCurveOverlap(t)
		return this._insert({ type: 'set', value: v, time: t })
	}

	linearRampToValueAtTime (value, endTime) {
		const v = checkFloat(value, 'value')
		const t = this._now(checkTime(endTime, 'endTime'))
		this._checkCurveOverlap(t)
		this._ensureStart()
		return this._insert({ type: 'linear', value: v, time: t })
	}

	exponentialRampToValueAtTime (value, endTime) {
		const v = checkFloat(value, 'value')
		if (v === 0) { throw new RangeError("exponentialRampToValueAtTime value must not be zero") }
		const t = this._now(checkTime(endTime, 'endTime'))
		this._checkCurveOverlap(t)
		this._ensureStart()
		return this._insert({ type: 'exponential', value: v, time: t })
	}

	setTargetAtTime (target, startTime, timeConstant) {
		const v = checkFloat(target, 'target')
		const t = this._now(checkTime(startTime, 'startTime'))
		const tau = checkFinite(timeConstant, 'timeConstant')
		if (tau < 0) { throw new RangeError("timeConstant must be non-negative") }
		this._checkCurveOverlap(t)
		if (tau === 0) { return this._insert({ type: 'set', value: v, time: t }) }
		return this._insert({ type: 'target', value: v, time: t, timeConstant: tau })
	}

	setValueCurveAtTime (values, startTime, duration) {
		const t = this._now(checkTime(startTime, 'startTime'))
		const d = checkFinite(duration, 'duration')
		if (d <= 0) { throw new RangeError("duration must be positive") }
		if (!values || values.length < 2) { throw invalidStateError("setValueCurveAtTime needs at least two values") }
		const curve = Float32Array.from(values, (x) => checkFloat(x, 'curve value'))
		this._checkCurveOverlap(t, d)
		return this._insert({ type: 'curve', time: t, duration: d, curve, value: curve[curve.length - 1] })
	}

	cancelScheduledValues (cancelTime) {
		const t = this._now(checkTime(cancelTime, 'cancelTime'))
		this._events = this._events.filter((event) => event.time < t && !(event.type === 'curve' && curveEnd(event) > t))
		return this
	}

	cancelAndHoldAtTime (cancelTime) {
		const t = this._now(checkTime(cancelTime, 'cancelTime'))

		const kept = []
		let spanningRamp = null
		for (const event of this._events) {
			if (event.time < t) {
				kept.push(event)
				continue
			}
			if (event.type === 'linear' || event.type === 'exponential') { spanningRamp = event }
			break
		}

		const value = Math.fround(this._evaluate(t, spanningRamp === null ? kept : [ ...kept, spanningRamp ]))

		const last = kept[kept.length - 1]
		this._events = kept
		if (last && last.type === 'curve' && curveEnd(last) > t) {
			kept[kept.length - 1] = { ...last, cutoff: t, value }
			return this
		}

		if (spanningRamp !== null) { return this._insert({ type: spanningRamp.type, value, time: t }) }
		return this._insert({ type: 'set', value, time: t })
	}

	_fold (event) {
		this._anchored = true
		if (this._target !== null) {
			this._v0 = targetAt(this._target, event.time)
			this._target = null
		}
		switch (event.type) {
			case 'target': {
				this._target = { v0: this._v0, t0: event.time, value: event.value, tau: event.timeConstant }
				this._t0 = event.time
			} break
			case 'curve': {
				this._v0 = event.value
				this._t0 = curveEnd(event)
			} break
			default: {
				this._v0 = event.value
				this._t0 = event.time
			}
		}
	}

	_advance (time) {
		const events = this._events
		while (events.length > 0) {
			const event = events[0]
			if (event.time > time) { break }
			if (event.type === 'curve' && curveEnd(event) > time) { break }
			this._fold(events.shift())
		}

		const target = this._target
		if (target !== null && (events.length === 0 || events[0].time > time)) {
			const value = targetAt(target, time)
			if (Math.abs(value - target.value) <= 1e-7 * Math.max(1, Math.abs(target.value))) {
				this._v0 = target.value
				this._t0 = time
				this._target = null
			}
		}
	}

	_evaluate (t, events = this._events) {
		let value = this._v0
		let time = this._t0
		let target = this._target

		for (const event of events) {
			if (event.time > t) {
				if (event.type === 'linear' || event.type === 'exponential') {
					const start = target !== null ? targetAt(target, time) : value
					const span = event.time - time
					const x = span > 0 ? Math.min(Math.max((t - time) / span, 0), 1) : 1
					if (event.type === 'linear') {
						const k = Math.fround(1 / span)
						const xf = span > 0 && k < Infinity ? Math.min(Math.max(Math.fround((t - time) * k), 0), 1) : x
						return Math.fround(start + Math.fround(xf * Math.fround(event.value - start)))
					}
					if (start === 0 || (start < 0) !== (event.value < 0)) { return start }
					return start * ((event.value / start) ** x)
				}
				break
			}

			if (target !== null) {
				value = targetAt(target, event.time)
				target = null
			}

			switch (event.type) {
				case 'target': {
					target = { v0: value, t0: event.time, value: event.value, tau: event.timeConstant }
					time = event.time
				} break
				case 'curve': {
					if (t < curveEnd(event)) {
						const curve = event.curve
						const position = (curve.length - 1) * (t - event.time) / event.duration
						const k = Math.floor(position)
						const frac = position - k
						const a = curve[k]
						const b = curve[Math.min(k + 1, curve.length - 1)]
						return a + (b - a) * frac
					}
					value = event.value
					time = curveEnd(event)
				} break
				default: {
					value = event.value
					time = event.time
				}
			}
		}

		if (target !== null) { return targetAt(target, t) }
		return value
	}

	_hasAutomationIn (startTime, endTime) {
		if (this._target !== null) { return true }
		for (const event of this._events) {
			if (event.type === 'curve') {
				if (event.time < endTime && curveEnd(event) > startTime) { return true }
			}
			if (event.time < endTime && event.time >= startTime) { return true }
			if (event.time >= endTime) {
				if (event.type === 'linear' || event.type === 'exponential') { return true }
				break
			}
		}
		return false
	}

	_block () {
		const context = this._context
		if (this._blockId === context._blockId) { return this._values }
		this._blockId = context._blockId

		const sampleRate = context.sampleRate
		const frame = context._frame
		const values = this._values
		const N = values.length
		const startTime = frame / sampleRate
		const endTime = (frame + N) / sampleRate

		this._advance(startTime)

		const automated = this._hasAutomationIn(startTime, endTime)
		const hasInputs = this._inputs.size > 0

		if (!automated) {
			const v = this._target !== null ? targetAt(this._target, startTime) : this._v0
			values.fill(v)
		}
		else if (this._automationRate === 'k-rate') {
			values.fill(this._evaluate(startTime))
		}
		else {
			for (let i = 0; i < N; i++) { values[i] = this._evaluate((frame + i) / sampleRate) }
		}

		const min = this._minValue
		const max = this._maxValue
		const fallback = this._defaultValue
		const first = values[0]
		this._lastValue = Number.isNaN(first) ? fallback : first < min ? min : first > max ? max : first

		if (hasInputs) {
			const mix = this._inputMix
			mix[0].fill(0)
			for (const { node, output } of this._inputs) {
				mixAdd(mix, node._pull(output), 'speakers')
			}
			const input = mix[0]
			if (this._automationRate === 'k-rate') {
				const v = input[0]
				for (let i = 0; i < N; i++) { values[i] += v }
			}
			else {
				for (let i = 0; i < N; i++) { values[i] += input[i] }
			}
		}

		for (let i = 0; i < N; i++) {
			const v = values[i]
			values[i] = Number.isNaN(v) ? fallback : v < min ? min : v > max ? max : v
		}

		this._constant = !automated && !hasInputs
		return values
	}

	_isConstant () {
		return this._constant
	}
}

const defineParamAccessors = (Class, names) => {
	for (const name of names) {
		Object.defineProperty(Class.prototype, name, {
			configurable: true,
			enumerable: true,
			get () { return this[`_${name}`] },
		})
	}
}

module.exports = { AudioParam, defineParamAccessors }
