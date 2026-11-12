
let sink = null

const setSink = (fn) => { sink = fn }

const forwarding = (object) => sink !== null && object._rid !== undefined

const remoteSide = () => sink !== null

const notify = (object, type, data, transfer, urgent = false) => {
	if (forwarding(object)) { sink(object._rid, type, data, transfer, urgent) }
}

module.exports = { setSink, forwarding, remoteSide, notify }
