'use strict'

const { InstanceBase, Regex, runEntrypoint, InstanceStatus } = require('@companion-module/base')
const dgram = require('dgram')

// ── OSC encoding / decoding (no external deps) ───────────────────────────────

function _pad4(n) { return (n + 3) & ~3 }

function _encodeStr(s) {
	const b = Buffer.from(s + '\x00', 'utf8')
	const out = Buffer.alloc(_pad4(b.length))
	b.copy(out)
	return out
}

function buildOsc(address, ...args) {
	let tags = ','
	const parts = [_encodeStr(address)]
	for (const a of args) {
		if (a === true)               { tags += 'T' }
		else if (a === false)         { tags += 'F' }
		else if (a === null)          { tags += 'N' }
		else if (Number.isInteger(a)) { tags += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a); parts.push(b) }
		else if (typeof a === 'number') { tags += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(a); parts.push(b) }
		else                          { tags += 's'; parts.push(_encodeStr(String(a))) }
	}
	parts.splice(1, 0, _encodeStr(tags))
	return Buffer.concat(parts)
}

function parseOsc(buf) {
	if (!buf || buf.length === 0) return null
	let pos = 0
	const nul0 = buf.indexOf(0, pos)
	if (nul0 < 0) return null
	const address = buf.toString('utf8', 0, nul0)
	pos = _pad4(nul0 + 1)
	const args = []
	if (pos >= buf.length || buf[pos] !== 0x2c) return { address, args }
	const nul1 = buf.indexOf(0, pos)
	const tags = buf.toString('ascii', pos + 1, nul1)
	pos = _pad4(nul1 + 1)
	for (const tag of tags) {
		if (tag === 'i') { args.push(buf.readInt32BE(pos)); pos += 4 }
		else if (tag === 'f') { args.push(buf.readFloatBE(pos)); pos += 4 }
		else if (tag === 's') { const n = buf.indexOf(0, pos); args.push(buf.toString('utf8', pos, n)); pos = _pad4(n + 1) }
		else if (tag === 'T') { args.push(true) }
		else if (tag === 'F') { args.push(false) }
		else if (tag === 'N' || tag === 'I') { args.push(null) }
	}
	return { address, args }
}

// ── Module ────────────────────────────────────────────────────────────────────

class AutoPrompterInstance extends InstanceBase {

	constructor(internal) {
		super(internal)
		this._sock         = null
		this._playing      = false
		this._blackout     = false
		this._testpattern  = false
		this._logo         = false
		this._semaforo     = 'none'
		this._fontsize     = 35
		this._viewers      = 0
		this._timerVis          = false
		this._clockVis          = false
		this._countdownVis      = false
		this._timerRunning      = false
		this._timerValue        = '--:--:--'
		this._countdownValue    = '--:--:--'
		this._countdownSetting  = '--:--:--'
		this._countdownMode     = 'down'
		this._imsgActive   = false
		this._markerCount  = 0
		this._markerLabels = []
		// Setlist and current song
		this._songCurrent  = ''
		this._songIndex    = 0
		this._setlistCount = 0
		this._setlistName  = ''
		this._portalOpen   = false
		this._markerCurrent = 0
		// ShuttleXpress
		this._shuttleConnected = false
		this._cruiseActive     = false
		this._cruisePaused     = false
		// Appearance
		this._pointerHidden = false
		this._daylight      = false
		this._fontFamily    = 'arial-narrow'
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	async init(config) {
		this.config = config
		this._startUdp()
		this._setupActions()
		this._setupFeedbacks()
		this._setupVariables()
		this._setupPresets()
		this.checkFeedbacks()
	}

	async configUpdated(config) {
		this.config = config
		this._stopUdp()
		this._startUdp()
	}

	async destroy() {
		this._stopUdp()
	}

	// ── Config fields ──────────────────────────────────────────────────────────

	getConfigFields() {
		return [
			{
				type: 'textinput',
				id: 'host',
				label: 'AutoPrompter Server IP',
				width: 6,
				default: '127.0.0.1',
				regex: Regex.IP,
			},
			{
				type: 'textinput',
				id: 'tx_port',
				label: 'TX Port (server RX, default 9000)',
				width: 3,
				default: '9000',
				regex: Regex.PORT,
			},
			{
				type: 'textinput',
				id: 'rx_port',
				label: 'RX Port (feedback, default 9001)',
				width: 3,
				default: '9001',
				regex: Regex.PORT,
			},
		]
	}

	// ── UDP socket ─────────────────────────────────────────────────────────────

	_startUdp() {
		this._sock = dgram.createSocket('udp4')

		this._sock.on('error', (err) => {
			this.log('error', `UDP error: ${err.message}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
			this._stopUdp()
		})

		this._sock.on('message', (msg) => {
			const pkt = parseOsc(msg)
			if (pkt) this._onFeedback(pkt.address, pkt.args)
		})

		const rxPort = parseInt(this.config.rx_port) || 9001
		this._sock.bind(rxPort, () => {
			this.log('info', `Listening for feedback on UDP :${rxPort}`)
			this.updateStatus(InstanceStatus.Ok)
		})
	}

	_stopUdp() {
		if (this._sock) {
			try { this._sock.close() } catch (_) {}
			this._sock = null
		}
	}

	_send(address, ...args) {
		if (!this._sock) return
		const host = this.config.host || '127.0.0.1'
		const port = parseInt(this.config.tx_port) || 9000
		const pkt  = buildOsc(address, ...args)
		this._sock.send(pkt, 0, pkt.length, port, host)
	}

	// ── Feedback from AutoPrompter ─────────────────────────────────────────────

	_onFeedback(address, args) {
		const a   = address.toLowerCase()
		const val = args[0]
		if      (a === '/ap/fb/playing')       this._playing      = val === 1 || val === true
		else if (a === '/ap/fb/blackout')      this._blackout     = val === 1 || val === true
		else if (a === '/ap/fb/testpattern')   this._testpattern  = val === 1 || val === true
		else if (a === '/ap/fb/logo')          this._logo         = val === 1 || val === true
		else if (a === '/ap/fb/semaforo')      this._semaforo     = String(val)
		else if (a === '/ap/fb/fontsize')      this._fontsize     = parseInt(val) || 35
		else if (a === '/ap/fb/viewers')       this._viewers      = parseInt(val) || 0
		else if (a === '/ap/fb/timer_vis')     this._timerVis     = val === 1 || val === true
		else if (a === '/ap/fb/clock_vis')     this._clockVis     = val === 1 || val === true
		else if (a === '/ap/fb/countdown_vis') this._countdownVis = val === 1 || val === true
		else if (a === '/ap/fb/timer_running')     this._timerRunning     = val === 1 || val === true
		else if (a === '/ap/fb/timer_value')       this._timerValue       = String(val ?? '--:--:--')
		else if (a === '/ap/fb/countdown_value')   this._countdownValue   = String(val ?? '--:--:--')
		else if (a === '/ap/fb/countdown_setting') this._countdownSetting = String(val ?? '--:--:--')
		else if (a === '/ap/fb/countdown_mode')    this._countdownMode    = String(val) === 'up' ? 'up' : 'down'
		else if (a === '/ap/fb/imsg_active')       this._imsgActive       = val === 1 || val === true
		else if (a === '/ap/fb/marker_count') {
			const newCount = parseInt(val) || 0
			if (newCount !== this._markerCount) {
				this._markerCount = newCount
				// Ridimensiona l'array: tronca o estendi con stringhe vuote
				this._markerLabels.length = newCount
				for (let i = 0; i < newCount; i++) {
					if (this._markerLabels[i] === undefined) this._markerLabels[i] = ''
				}
				this._rebuildVariableDefinitions()
			}
		}
		// Setlist and current song
		else if (a === '/ap/fb/song_current')  this._songCurrent  = String(val ?? '')
		else if (a === '/ap/fb/song_index')    this._songIndex    = parseInt(val) || 0
		else if (a === '/ap/fb/setlist_count') this._setlistCount = parseInt(val) || 0
		else if (a === '/ap/fb/setlist_name')  this._setlistName  = String(val ?? '')
		else if (a === '/ap/fb/portal_open')   this._portalOpen   = val === 1 || val === true
		else if (a === '/ap/fb/marker_current') this._markerCurrent = parseInt(val) || 0
		// ShuttleXpress
		else if (a === '/ap/fb/shuttle_connected') this._shuttleConnected = val === 1 || val === true
		else if (a === '/ap/fb/cruise_active')     this._cruiseActive     = val === 1 || val === true
		else if (a === '/ap/fb/cruise_paused')     this._cruisePaused     = val === 1 || val === true
		// Appearance
		else if (a === '/ap/fb/pointer_hidden') this._pointerHidden = val === 1 || val === true
		else if (a === '/ap/fb/daylight')       this._daylight      = val === 1 || val === true
		else if (a === '/ap/fb/font_family')    this._fontFamily    = String(val ?? '')
		// NB: marker_<n> va tenuto DOPO marker_count e marker_current, o il
		// prefisso li intercetterebbe entrambi.
		else if (a.startsWith('/ap/fb/marker_')) {
			const idx = parseInt(a.slice('/ap/fb/marker_'.length))
			if (!isNaN(idx) && idx >= 0 && idx < this._markerCount) this._markerLabels[idx] = String(val ?? '')
		}
		else return
		this.checkFeedbacks()
		this._updateVariables()
	}

	// ── Actions ────────────────────────────────────────────────────────────────

	_setupActions() {
		this.setActionDefinitions({
			// ── Transport ──
			play:         { name: 'Play',             options: [], callback: () => this._send('/ap/play') },
			stop:         { name: 'Stop',             options: [], callback: () => this._send('/ap/stop') },
			toggle_play:  { name: 'Play / Stop (toggle)', options: [], callback: () => this._send('/ap/toggle') },
			scroll_top:   { name: 'Rewind to start',  options: [], callback: () => this._send('/ap/scroll/top') },

			// ── Speed ──
			speed_up:     { name: 'Speed +1',  options: [], callback: () => this._send('/ap/speed/up') },
			speed_down:   { name: 'Speed \u22121',  options: [], callback: () => this._send('/ap/speed/down') },
			speed_set: {
				name: 'Set speed',
				options: [{ type: 'number', id: 'value', label: 'Speed (25\u2013120)', default: 40, min: 25, max: 120 }],
				callback: (action) => this._send('/ap/speed/set', parseInt(action.options.value)),
			},

			// ── Text size: the prompter works in VISIBLE LINES, not points ──
			font_up:      { name: 'Text bigger (fewer lines)',  options: [], callback: () => this._send('/ap/font/up') },
			font_down:    { name: 'Text smaller (more lines)',  options: [], callback: () => this._send('/ap/font/down') },
			font_set: {
				name: 'Set visible lines',
				options: [{ type: 'number', id: 'value', label: 'Visible lines (3\u201315)', default: 7, min: 3, max: 15 }],
				callback: (action) => this._send('/ap/font/set', parseInt(action.options.value)),
			},

			// ── Setlist, songs and speeches ──
			setlist_goto: {
				name: 'Setlist \u2014 Go to row',
				options: [{ type: 'number', id: 'value', label: 'Row (1 = first). Song or speech: the server decides', default: 1, min: 1, max: 200 }],
				callback: (action) => this._send('/ap/setlist/goto', parseInt(action.options.value)),
			},
			setlist_next: { name: 'Setlist \u2014 Next row',     options: [], callback: () => this._send('/ap/setlist/next') },
			setlist_prev: { name: 'Setlist \u2014 Previous row', options: [], callback: () => this._send('/ap/setlist/prev') },
			song_load: {
				name: 'Song \u2014 Load by name',
				options: [{ type: 'textinput', id: 'name', label: 'File name (with or without .docx)', default: '' }],
				callback: (action) => this._send('/ap/song/load', String(action.options.name || '')),
			},
			song_clear:   { name: 'Song \u2014 Clear text (show logo)', options: [], callback: () => this._send('/ap/song/clear') },
			speech_load: {
				name: 'Speech \u2014 Open',
				options: [{ type: 'textinput', id: 'name', label: 'Speech file name', default: '' }],
				callback: (action) => this._send('/ap/speech/load', String(action.options.name || '')),
			},
			speech_close: { name: 'Speech \u2014 Close',            options: [], callback: () => this._send('/ap/speech/close') },
			banner_next:  { name: 'Show next song title',          options: [], callback: () => this._send('/ap/banner/next') },

			// ── Overlays ──
			blackout:     { name: 'Blackout (toggle)',      options: [], callback: () => this._send('/ap/blackout') },
			testpattern:  { name: 'Test pattern (toggle)',  options: [], callback: () => this._send('/ap/testpattern') },
			logo:         { name: 'Logo (toggle)',          options: [], callback: () => this._send('/ap/logo') },

			// ── Ready light (called "Semaforo" in the app) ──
			semaforo_ok:   { name: 'Ready light \u2014 Green',  options: [], callback: () => this._send('/ap/semaforo/ok') },
			semaforo_ko:   { name: 'Ready light \u2014 Red',    options: [], callback: () => this._send('/ap/semaforo/ko') },
			semaforo_none: { name: 'Ready light \u2014 Off',    options: [], callback: () => this._send('/ap/semaforo/none') },

			// ── Markers ──
			marker_next:   { name: 'Marker \u2014 Next',     options: [], callback: () => this._send('/ap/marker/next') },
			marker_prev:   { name: 'Marker \u2014 Previous', options: [], callback: () => this._send('/ap/marker/prev') },
			marker_goto: {
				name: 'Marker \u2014 Go to (by index)',
				options: [{ type: 'number', id: 'value', label: 'Marker index (0 = first)', default: 0, min: 0, max: 99 }],
				callback: (action) => this._send('/ap/marker/goto', parseInt(action.options.value)),
			},
			marker_goto_name: {
				name: 'Marker \u2014 Go to (by name)',
				options: [{ type: 'textinput', id: 'value', label: 'Marker name (case-insensitive, first match)', default: '' }],
				callback: (action) => this._send('/ap/marker/goto_name', String(action.options.value)),
			},

			// ── Notes and instant messages ──
			note_send: {
				name: 'Note \u2014 Show',
				options: [{ type: 'textinput', id: 'text', label: 'Note text (empty closes it)', default: '' }],
				callback: (action) => this._send('/ap/note', String(action.options.text || '')),
			},
			note_clear: { name: 'Note \u2014 Close', options: [], callback: () => this._send('/ap/note/clear') },
			imsg_send: {
				name: 'Instant message \u2014 Send',
				options: [{ type: 'textinput', id: 'text', label: 'Message text', default: '' }],
				callback: (action) => this._send('/ap/imsg/send', String(action.options.text || '')),
			},
			imsg_clear: { name: 'Instant message \u2014 Clear', options: [], callback: () => this._send('/ap/imsg/clear') },

			// ── Stopwatch ──
			timer_show:      { name: 'Stopwatch \u2014 Show / hide',  options: [], callback: () => this._send('/ap/timer/show') },
			timer_startstop: { name: 'Stopwatch \u2014 Start / pause', options: [], callback: () => this._send('/ap/timer/startstop') },
			timer_reset:     { name: 'Stopwatch \u2014 Reset',        options: [], callback: () => this._send('/ap/timer/reset') },

			// ── Clock ──
			clock_show:      { name: 'Clock \u2014 Show / hide', options: [], callback: () => this._send('/ap/clock/show') },

			// ── Countdown ──
			countdown_show:  { name: 'Countdown \u2014 Show / hide', options: [], callback: () => this._send('/ap/countdown/show') },
			countdown_mode_down:   { name: 'Countdown \u2014 Count down',       options: [], callback: () => this._send('/ap/countdown/mode/down') },
			countdown_mode_up:     { name: 'Countdown \u2014 Count up',         options: [], callback: () => this._send('/ap/countdown/mode/up') },
			countdown_mode_toggle: { name: 'Countdown \u2014 Toggle direction', options: [], callback: () => this._send('/ap/countdown/mode/toggle') },
			countdown_set: {
				name: 'Countdown \u2014 Set duration',
				options: [{ type: 'number', id: 'value', label: 'Duration (seconds)', default: 300, min: 0, max: 86400 }],
				callback: (action) => this._send('/ap/countdown/set', parseInt(action.options.value)),
			},
			countdown_add: {
				name: 'Countdown \u2014 Add seconds',
				options: [{ type: 'number', id: 'value', label: 'Seconds to add', default: 60, min: 1, max: 3600 }],
				callback: (action) => this._send('/ap/countdown/add', parseInt(action.options.value)),
			},
			countdown_sub: {
				name: 'Countdown \u2014 Subtract seconds',
				options: [{ type: 'number', id: 'value', label: 'Seconds to subtract', default: 60, min: 1, max: 3600 }],
				callback: (action) => this._send('/ap/countdown/sub', parseInt(action.options.value)),
			},
		})
	}

	// ── Feedbacks ──────────────────────────────────────────────────────────────

	_setupFeedbacks() {
		this.setFeedbackDefinitions({
			playing: {
				name: 'Playing',
				type: 'boolean',
				defaultStyle: { bgcolor: 0x00aa00, color: 0xffffff },
				options: [],
				callback: () => this._playing,
			},
			stopped: {
				name: 'Stopped',
				type: 'boolean',
				defaultStyle: { bgcolor: 0xaa0000, color: 0xffffff },
				options: [],
				callback: () => !this._playing,
			},
			blackout: {
				name: 'Blackout active',
				type: 'boolean',
				defaultStyle: { bgcolor: 0x000000, color: 0xffffff },
				options: [],
				callback: () => this._blackout,
			},
			testpattern: {
				name: 'Test pattern active',
				type: 'boolean',
				defaultStyle: { bgcolor: 0xaa6600, color: 0xffffff },
				options: [],
				callback: () => this._testpattern,
			},
			logo: {
				name: 'Logo active',
				type: 'boolean',
				defaultStyle: { bgcolor: 0x005599, color: 0xffffff },
				options: [],
				callback: () => this._logo,
			},
			semaforo_ok: {
				name: 'Ready light — Green',
				type: 'boolean',
				defaultStyle: { bgcolor: 0x00cc44, color: 0xffffff },
				options: [],
				callback: () => this._semaforo === 'ok',
			},
			semaforo_ko: {
				name: 'Ready light — Red',
				type: 'boolean',
				defaultStyle: { bgcolor: 0xdd2222, color: 0xffffff },
				options: [],
				callback: () => this._semaforo === 'ko',
			},
			has_viewers: {
				name: 'Screens connected',
				type: 'boolean',
				defaultStyle: { bgcolor: 0x0055ff, color: 0xffffff },
				options: [],
				callback: () => this._viewers > 0,
			},
			timer_vis: {
				name: 'Stopwatch visible',
				type: 'boolean',
				defaultStyle: { bgcolor: 0x005577, color: 0xffffff },
				options: [],
				callback: () => this._timerVis,
			},
			clock_vis: {
				name: 'Clock visible',
				type: 'boolean',
				defaultStyle: { bgcolor: 0x224400, color: 0xffffff },
				options: [],
				callback: () => this._clockVis,
			},
			countdown_vis: {
				name: 'Countdown visible',
				type: 'boolean',
				defaultStyle: { bgcolor: 0x440044, color: 0xffffff },
				options: [],
				callback: () => this._countdownVis,
			},
			timer_running: {
				name: 'Stopwatch running',
				type: 'boolean',
				defaultStyle: { bgcolor: 0x007799, color: 0xffffff },
				options: [],
				callback: () => this._timerRunning,
			},
			countdown_mode_is_up: {
				name: 'Countdown counting up',
				type: 'boolean',
				defaultStyle: { bgcolor: 0x005588, color: 0xffffff },
				options: [],
				callback: () => this._countdownMode === 'up',
			},
			countdown_mode_is_down: {
				name: 'Countdown counting down',
				type: 'boolean',
				defaultStyle: { bgcolor: 0x440066, color: 0xffffff },
				options: [],
				callback: () => this._countdownMode === 'down',
			},
			imsg_active: {
				name: 'Instant message active',
				type: 'boolean',
				defaultStyle: { bgcolor: 0x7a3f00, color: 0xffffff },
				options: [],
				callback: () => this._imsgActive,
			},
			// ── Setlist and current song ──
			song_is: {
				name: 'Current song is…',
				type: 'boolean',
				defaultStyle: { bgcolor: 0x00aa00, color: 0xffffff },
				options: [{ type: 'textinput', id: 'name', label: 'Song name (without extension)', default: '' }],
				callback: (fb) => {
					const want = String(fb.options.name || '').trim().toLowerCase()
					return !!want && this._songCurrent.trim().toLowerCase() === want
				},
			},
			setlist_row_is: {
				name: 'Current song is setlist row…',
				type: 'boolean',
				defaultStyle: { bgcolor: 0x00aa00, color: 0xffffff },
				options: [{ type: 'number', id: 'row', label: 'Row (1 = first)', default: 1, min: 1, max: 200 }],
				callback: (fb) => this._songIndex === parseInt(fb.options.row),
			},
			portal_open: {
				name: 'Speech open',
				type: 'boolean',
				defaultStyle: { bgcolor: 0x0066cc, color: 0xffffff },
				options: [],
				callback: () => this._portalOpen,
			},
			// ── ShuttleXpress ──
			shuttle_connected: {
				name: 'ShuttleXpress connected',
				type: 'boolean',
				defaultStyle: { bgcolor: 0x006600, color: 0xffffff },
				options: [],
				callback: () => this._shuttleConnected,
			},
			cruise_active: {
				name: 'Cruise engaged',
				type: 'boolean',
				defaultStyle: { bgcolor: 0xcc6600, color: 0xffffff },
				options: [],
				callback: () => this._cruiseActive,
			},
			cruise_paused: {
				name: 'Cruise paused',
				type: 'boolean',
				defaultStyle: { bgcolor: 0x665500, color: 0xffffff },
				options: [],
				callback: () => this._cruisePaused,
			},
			// ── Appearance ──
			pointer_hidden: {
				name: 'Pointer hidden',
				type: 'boolean',
				defaultStyle: { bgcolor: 0x444444, color: 0xffffff },
				options: [],
				callback: () => this._pointerHidden,
			},
			daylight: {
				name: 'Daylight (inverted colours)',
				type: 'boolean',
				defaultStyle: { bgcolor: 0xffffff, color: 0x000000 },
				options: [],
				callback: () => this._daylight,
			},
		})
	}

	// ── Variables ──────────────────────────────────────────────────────────────

	_rebuildVariableDefinitions() {
		this.setVariableDefinitions([
			{ variableId: 'playing',       name: 'Playing (0/1)' },
			{ variableId: 'blackout',      name: 'Blackout (0/1)' },
			{ variableId: 'testpattern',   name: 'Test Pattern (0/1)' },
			{ variableId: 'logo',          name: 'Logo (0/1)' },
			{ variableId: 'semaforo',      name: 'Ready light (none/ok/ko)' },
			{ variableId: 'fontsize',      name: 'Visible lines' },
			{ variableId: 'viewers',       name: 'Screens connected' },
			{ variableId: 'timer_vis',     name: 'Stopwatch visible (0/1)' },
			{ variableId: 'clock_vis',     name: 'Clock visible (0/1)' },
			{ variableId: 'countdown_vis', name: 'Countdown visible (0/1)' },
			{ variableId: 'timer_running',      name: 'Stopwatch running (0/1)' },
			{ variableId: 'timer_value',        name: 'Stopwatch — current value (HH:MM:SS)' },
			{ variableId: 'countdown_value',    name: 'Countdown — current value (HH:MM:SS)' },
			{ variableId: 'countdown_setting',  name: 'Countdown — duration set (HH:MM:SS)' },
			{ variableId: 'countdown_mode',     name: 'Countdown — direction (up/down)' },
			{ variableId: 'imsg_active',        name: 'Instant message active (0/1)' },
			{ variableId: 'marker_count',       name: 'Marker count' },
			{ variableId: 'marker_current',     name: 'Current marker (1 = first, 0 = none)' },
			{ variableId: 'song_current',       name: 'Current song' },
			{ variableId: 'song_index',         name: 'Current song — setlist row (0 = not in setlist)' },
			{ variableId: 'setlist_count',      name: 'Setlist rows' },
			{ variableId: 'setlist_name',       name: 'Setlist in use' },
			{ variableId: 'portal_open',        name: 'Speech open (0/1)' },
			{ variableId: 'shuttle_connected',  name: 'ShuttleXpress connected (0/1)' },
			{ variableId: 'cruise_active',      name: 'Cruise engaged (0/1)' },
			{ variableId: 'cruise_paused',      name: 'Cruise paused (0/1)' },
			{ variableId: 'pointer_hidden',     name: 'Pointer hidden (0/1)' },
			{ variableId: 'daylight',           name: 'Daylight (0/1)' },
			{ variableId: 'font_family',        name: 'Font in use' },
			...Array.from({ length: this._markerCount }, (_, i) => ({ variableId: `marker_${i}`, name: `Marker ${i + 1} — Label` })),
		])
	}

	_setupVariables() {
		this._rebuildVariableDefinitions()
		this._updateVariables()
	}

	_updateVariables() {
		this.setVariableValues({
			playing:       this._playing      ? 1 : 0,
			blackout:      this._blackout     ? 1 : 0,
			testpattern:   this._testpattern  ? 1 : 0,
			logo:          this._logo         ? 1 : 0,
			semaforo:      this._semaforo,
			fontsize:      this._fontsize,
			viewers:       this._viewers,
			timer_vis:     this._timerVis     ? 1 : 0,
			clock_vis:     this._clockVis     ? 1 : 0,
			countdown_vis: this._countdownVis ? 1 : 0,
			timer_running:     this._timerRunning ? 1 : 0,
			timer_value:       this._timerValue,
			countdown_value:   this._countdownValue,
			countdown_setting: this._countdownSetting,
			countdown_mode:    this._countdownMode,
			imsg_active:       this._imsgActive ? 1 : 0,
			marker_count:      this._markerCount,
			marker_current:    this._markerCurrent,
			song_current:      this._songCurrent,
			song_index:        this._songIndex,
			setlist_count:     this._setlistCount,
			setlist_name:      this._setlistName,
			portal_open:       this._portalOpen ? 1 : 0,
			shuttle_connected: this._shuttleConnected ? 1 : 0,
			cruise_active:     this._cruiseActive ? 1 : 0,
			cruise_paused:     this._cruisePaused ? 1 : 0,
			pointer_hidden:    this._pointerHidden ? 1 : 0,
			daylight:          this._daylight ? 1 : 0,
			font_family:       this._fontFamily,
			...Object.fromEntries(Array.from({ length: this._markerCount }, (_, i) => [`marker_${i}`, this._markerLabels[i] || ''])),
		})
	}

	// ── Presets ────────────────────────────────────────────────────────────────

	_setupPresets() {
		// Helper shorthand
		const btn = (category, name, text, bgcolor, actionId, actionOptions, feedbackId, feedbackBg) => ({
			type: 'button',
			category,
			name,
			style: { text, size: '18', color: 0xffffff, bgcolor },
			feedbacks: feedbackId ? [{
				feedbackId,
				options: {},
				style: { bgcolor: feedbackBg, color: 0xffffff },
			}] : [],
			steps: [{ down: [{ actionId, options: actionOptions ?? {} }], up: [] }],
		})

		this.setPresetDefinitions({

			// ── Playback ────────────────────────────────────────────────────────
			play: btn(
				'Playback', 'Play', 'PLAY', 0x005500,
				'play', {}, 'playing', 0x00cc00
			),
			stop: btn(
				'Playback', 'Stop', 'STOP', 0x550000,
				'stop', {}, 'stopped', 0xcc0000
			),
			toggle_play: btn(
				'Playback', 'Play / Stop', 'PLAY\nSTOP', 0x333333,
				'toggle_play', {}, 'playing', 0x00cc00
			),

			// ── Velocità ────────────────────────────────────────────────────────
			speed_up:   btn('Velocità', 'Speed +1', 'VEL +1', 0x003366, 'speed_up'),
			speed_down: btn('Velocità', 'Speed −1', 'VEL −1', 0x003366, 'speed_down'),
			speed_25:   btn('Velocità', 'Speed 25',  'VEL\n25',  0x003366, 'speed_set', { value: 25 }),
			speed_50:   btn('Velocità', 'Speed 50',  'VEL\n50',  0x003366, 'speed_set', { value: 50 }),
			speed_75:   btn('Velocità', 'Speed 75',  'VEL\n75',  0x003366, 'speed_set', { value: 75 }),

			// ── Testo ───────────────────────────────────────────────────────────
			font_up:   btn('Testo', 'Font +1', 'FONT +1', 0x444400, 'font_up'),
			font_down: btn('Testo', 'Font −1', 'FONT −1', 0x444400, 'font_down'),

			// ── Overlay ─────────────────────────────────────────────────────────
			blackout: btn(
				'Overlay', 'Blackout', 'BLACK\nOUT', 0x111111,
				'blackout', {}, 'blackout', 0x000000
			),
			testpattern: btn(
				'Overlay', 'Test Pattern', 'TEST\nPATT', 0x553300,
				'testpattern', {}, 'testpattern', 0xff8800
			),
			logo: btn(
				'Overlay', 'Logo', 'LOGO', 0x003366,
				'logo', {}, 'logo', 0x0077cc
			),

			// ── Semaforo ────────────────────────────────────────────────────────
			semaforo_ok: btn(
				'Semaforo', 'Verde', 'VIA', 0x004422,
				'semaforo_ok', {}, 'semaforo_ok', 0x00cc44
			),
			semaforo_ko: btn(
				'Semaforo', 'Rosso', 'STOP', 0x440000,
				'semaforo_ko', {}, 'semaforo_ko', 0xdd2222
			),
			semaforo_none: btn(
				'Semaforo', 'Spento', 'SEM\nOFF', 0x222222,
				'semaforo_none'
			),

			// ── Navigazione ─────────────────────────────────────────────────────
			marker_next: btn('Navigazione', 'Marker ▶', 'MARK ▶', 0x222233, 'marker_next'),
			marker_prev: btn('Navigazione', '◀ Marker', '◀ MARK', 0x222233, 'marker_prev'),
			scroll_top:  btn('Navigazione', "Top", 'TOP', 0x222222, 'scroll_top'),

			// ── Marker (goto per indice) — preset generico, clonare e impostare l'indice ──
			marker_goto_generic: btn('Marker', 'Vai al Marker', 'MARKER\n$(autoprompter:marker_0)', 0x1a1a33, 'marker_goto', { value: 0 }),

			// ── Timer ───────────────────────────────────────────────────────────
			timer_show: btn(
				'Timer', 'Mostra Timer', 'TIMER\nON/OFF', 0x003344,
				'timer_show', {}, 'timer_vis', 0x007799
			),
			timer_startstop: btn(
				'Timer', 'Avvia/Pausa Timer', 'TIMER\nSTART', 0x004455,
				'timer_startstop', {}, 'timer_running', 0x00aacc
			),
			timer_reset: btn(
				'Timer', 'Reset Timer', 'TIMER\nRESET', 0x221100,
				'timer_reset'
			),
			// Display live — click = avvia/pausa
			timer_display: {
				type: 'button', category: 'Stopwatch', name: 'Stopwatch display (live)',
				style: { text: 'TIMER\n$(autoprompter:timer_value)', size: '14', color: 0xffffff, bgcolor: 0x002233 },
				feedbacks: [{ feedbackId: 'timer_running', options: {}, style: { bgcolor: 0x007799, color: 0xffffff } }],
				steps: [{ down: [{ actionId: 'timer_startstop', options: {} }], up: [] }],
			},

			// ── Orologio ────────────────────────────────────────────────────────
			clock_show: btn(
				'Orologio', 'Mostra Orologio', 'CLOCK\nON/OFF', 0x112200,
				'clock_show', {}, 'clock_vis', 0x33aa00
			),

			// ── Countdown ───────────────────────────────────────────────────────
			countdown_show: btn(
				'Countdown', 'Mostra Countdown', 'CNTDWN\nON/OFF', 0x330033,
				'countdown_show', {}, 'countdown_vis', 0x880088
			),
			// Display live — click = mostra/nascondi
			countdown_display: {
				type: 'button', category: 'Countdown', name: 'Countdown display (live)',
				style: { text: 'CNTDWN\n$(autoprompter:countdown_value)', size: '14', color: 0xffffff, bgcolor: 0x220033 },
				feedbacks: [{ feedbackId: 'countdown_vis', options: {}, style: { bgcolor: 0x880088, color: 0xffffff } }],
				steps: [{ down: [{ actionId: 'countdown_show', options: {} }], up: [] }],
			},
			// Display durata impostata — click = mostra/nascondi
			countdown_setting_display: {
				type: 'button', category: 'Countdown', name: 'Duration set display',
				style: { text: 'SET\n$(autoprompter:countdown_setting)', size: '14', color: 0xaaaaaa, bgcolor: 0x1a0022 },
				feedbacks: [],
				steps: [{ down: [{ actionId: 'countdown_show', options: {} }], up: [] }],
			},
			// Modalità DOWN — si illumina quando attiva
			countdown_mode_down_btn: {
				type: 'button', category: 'Countdown', name: 'Count down',
				style: { text: 'CD\nDOWN', size: '18', color: 0xffffff, bgcolor: 0x330022 },
				feedbacks: [{ feedbackId: 'countdown_mode_is_down', options: {}, style: { bgcolor: 0x880055, color: 0xffffff } }],
				steps: [{ down: [{ actionId: 'countdown_mode_down', options: {} }], up: [] }],
			},
			// Modalità UP — si illumina quando attiva
			countdown_mode_up_btn: {
				type: 'button', category: 'Countdown', name: 'Count up',
				style: { text: 'CD\nUP', size: '18', color: 0xffffff, bgcolor: 0x001133 },
				feedbacks: [{ feedbackId: 'countdown_mode_is_up', options: {}, style: { bgcolor: 0x0077cc, color: 0xffffff } }],
				steps: [{ down: [{ actionId: 'countdown_mode_up', options: {} }], up: [] }],
			},
			// Toggle UP/DOWN — mostra la modalità corrente nel testo
			countdown_mode_toggle_btn: {
				type: 'button', category: 'Countdown', name: 'Toggle direction',
				style: { text: 'CD MODE\n$(autoprompter:countdown_mode)', size: '14', color: 0xffffff, bgcolor: 0x221133 },
				feedbacks: [
					{ feedbackId: 'countdown_mode_is_up',   options: {}, style: { bgcolor: 0x0077cc, color: 0xffffff } },
					{ feedbackId: 'countdown_mode_is_down', options: {}, style: { bgcolor: 0x880055, color: 0xffffff } },
				],
				steps: [{ down: [{ actionId: 'countdown_mode_toggle', options: {} }], up: [] }],
			},
			countdown_5m: btn(
				'Countdown', 'Countdown 5 min', 'CD\n5:00', 0x220022,
				'countdown_set', { value: 300 }
			),
			countdown_10m: btn(
				'Countdown', 'Countdown 10 min', 'CD\n10:00', 0x220022,
				'countdown_set', { value: 600 }
			),
			countdown_15m: btn(
				'Countdown', 'Countdown 15 min', 'CD\n15:00', 0x220022,
				'countdown_set', { value: 900 }
			),
			countdown_30m: btn(
				'Countdown', 'Countdown 30 min', 'CD\n30:00', 0x220022,
				'countdown_set', { value: 1800 }
			),
			countdown_add60: btn(
				'Countdown', '+1 minuto', 'CD\n+1\'', 0x112222,
				'countdown_add', { value: 60 }
			),
			countdown_sub60: btn(
				'Countdown', '−1 minuto', 'CD\n−1\'', 0x221111,
				'countdown_sub', { value: 60 }
			),

			// ── Messaggio Istantaneo ────────────────────────────────────────────────────────
			imsg_clear_btn: {
				type: 'button', category: 'Instant message', name: 'Clear message',
				style: { text: 'MSG\nCLEAR', size: '14', color: 0xffffff, bgcolor: 0x333333 },
				feedbacks: [{ feedbackId: 'imsg_active', options: {}, style: { bgcolor: 0x7a3f00, color: 0xffffff } }],
				steps: [{ down: [{ actionId: 'imsg_clear', options: {} }], up: [] }],
			},
			imsg_piu_veloce: {
				type: 'button', category: 'Instant message', name: 'Message: Faster',
				style: { text: 'MSG\nPIÙ VELOCE', size: '14', color: 0xffffff, bgcolor: 0x003366 },
				feedbacks: [],
				steps: [{ down: [{ actionId: 'imsg_send', options: { text: 'Più veloce' } }], up: [] }],
			},
			imsg_piu_lento: {
				type: 'button', category: 'Instant message', name: 'Message: Slower',
				style: { text: 'MSG\nPIÙ LENTO', size: '14', color: 0xffffff, bgcolor: 0x003366 },
				feedbacks: [],
				steps: [{ down: [{ actionId: 'imsg_send', options: { text: 'Più lento' } }], up: [] }],
			},
			imsg_stop: {
				type: 'button', category: 'Instant message', name: 'Message: STOP',
				style: { text: 'MSG\nSTOP!', size: '14', color: 0xffffff, bgcolor: 0x660000 },
				feedbacks: [],
				steps: [{ down: [{ actionId: 'imsg_send', options: { text: 'STOP!' } }], up: [] }],
			},
			imsg_ok: {
				type: 'button', category: 'Instant message', name: 'Message: OK',
				style: { text: 'MSG\nOK', size: '14', color: 0xffffff, bgcolor: 0x004400 },
				feedbacks: [],
				steps: [{ down: [{ actionId: 'imsg_send', options: { text: 'OK!' } }], up: [] }],
			},
		})
	}
}

runEntrypoint(AutoPrompterInstance, [])
