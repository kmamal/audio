
class NullSink {
	constructor ({ sampleRate, channels, buffered }) {
		this.sampleRate = sampleRate
		this.channels = channels
		this.sinkId = { type: 'none' }
		this._buffered = buffered
		this._written = 0
		this._start = null
		this._paused = true
		this._pausedAt = 0
		this._closed = false
	}

	get bufferedFrames () { return this._buffered }

	_elapsedFrames () {
		if (this._start === null) { return 0 }
		const now = this._paused ? this._pausedAt : Number(process.hrtime.bigint()) / 1e9
		return (now - this._start) * this.sampleRate
	}

	get queuedFrames () {
		return Math.max(this._written - this._elapsedFrames(), 0)
	}

	get closed () { return this._closed }

	write (interleaved) {
		this._written += interleaved.length / this.channels
	}

	play () {
		if (!this._paused) { return }
		const now = Number(process.hrtime.bigint()) / 1e9
		if (this._start === null) { this._start = now }
		else { this._start += now - this._pausedAt }
		this._paused = false
	}

	pause () {
		if (this._paused) { return }
		this._pausedAt = Number(process.hrtime.bigint()) / 1e9
		this._paused = true
	}

	clear () {
		this._written = this._elapsedFrames()
	}

	close () { this._closed = true }
}

module.exports = { NullSink }
