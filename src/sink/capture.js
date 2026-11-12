class CaptureSink {
	constructor ({ capture, onFull, onSuspend }) {
		this.sinkId = { type: 'none' }
		this.channels = capture.channels
		this._segments = []
		this._offset = 0
		this._written = 0
		this._onFull = onFull
		this._onSuspend = onSuspend
		this._suspensions = []
		this._held = null
	}

	addSegment (segment) { this._segments.push(segment) }

	suspendAt (frame) {
		if (this._suspensions.includes(frame)) { return }
		this._suspensions.push(frame)
		this._suspensions.sort((a, b) => a - b)
	}

	release (frame) {
		const index = this._suspensions.indexOf(frame)
		if (index !== -1) { this._suspensions.splice(index, 1) }
		if (this._held === frame) { this._held = null }
	}

	get drivesPump () { return false }
	get bufferedFrames () { return 0 }
	get queuedFrames () {
		if (this._segments.length === 0) { return Infinity }
		const next = this._suspensions[0]
		if (next !== undefined && this._written >= next) {
			if (this._held !== next) {
				this._held = next
				this._onSuspend(next)
			}
			return Infinity
		}
		return 0
	}

	get closed () { return false }

	writeBlock (block) {
		const segment = this._segments[0]
		if (segment === undefined) { return }
		const { channels, length } = segment
		const start = this._offset
		const count = Math.min(block[0]?.length ?? 0, length - start)
		if (count <= 0) { return }
		for (let c = 0; c < channels.length; c++) {
			const src = block[c]
			if (src === undefined) { continue }
			channels[c].set(count === src.length ? src : src.subarray(0, count), start)
		}
		this._offset += count
		this._written += count
		if (this._offset >= length) {
			this._segments.shift()
			this._offset = 0
			this._onFull(segment.id)
		}
	}

	write () {}
	play () {}
	pause () {}
	close () {}
}

module.exports = { CaptureSink }
