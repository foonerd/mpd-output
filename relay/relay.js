#!/usr/bin/env node
'use strict';
/*
 * mpd-output relay: copies MPD's loopback httpd stream to an Icecast mount.
 *
 * MPD never opens a socket to Icecast. MPD's httpd output is non-blocking and
 * drops a slow client's queue, so nothing on this side can stall playback.
 * The relay owns every timeout: a stalled Icecast peer (frozen host, black
 * hole, half-open TCP) is detected by the userland send queue growing while
 * the kernel buffer is full, and the connection is torn down and retried
 * with backoff. Node core only, no dependencies.
 *
 *   relay.js <config.json> [--status <status.json>]
 */
const fs = require('fs');
const net = require('net');
const tls = require('tls');

const VERSION = '3.0.0';

const cfgPath = process.argv[2];
const statusIdx = process.argv.indexOf('--status');
const statusPath = statusIdx > 0 ? process.argv[statusIdx + 1] : null;
if (!cfgPath) {
    console.error('usage: relay.js <config.json> [--status <status.json>]');
    process.exit(2);
}

const cfg = Object.assign({
    source: { host: '127.0.0.1', port: 8010 },
    icecast: {
        host: 'localhost', port: 8000, mount: '/volumio.ogg', user: 'source', password: '',
        name: 'Volumio', description: '', genre: '', url: '', public: false, tls: false,
    },
    bitrate_kbps: 0,          // informational for ice-audio-info; stall threshold derives from it when > 0
    stall_seconds: 8,         // send queue above threshold for this long => peer considered dead
    backoff_max_seconds: 30,
    auth_backoff_seconds: 60, // 401/403: do not hammer the server
}, JSON.parse(fs.readFileSync(cfgPath, 'utf8')));

const log = (level, msg, extra) => {
    const line = `${new Date().toISOString()} ${level} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
    (level === 'error' ? console.error : console.log)(line);
};

const status = { version: VERSION, mpd: 'disconnected', icecast: 'disconnected', since: null, lastError: null, bytesRelayed: 0, reconnects: 0 };
let statusTimer = null;
const publishStatus = () => {
    if (!statusPath) return;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
        try { fs.writeFileSync(statusPath, JSON.stringify(status)); } catch (e) { /* status is best effort */ }
    }, 200);
};

let mpdSock = null;
let iceSock = null;
let contentType = null;
let stopping = false;
let iceAttempt = 0;
let iceTimer = null;
let mpdTimer = null;
let mpdAttempt = 0;
let mpdWaitLogged = 0;
let stallTicker = null;

// ---------------------------------------------------------------- MPD side

function connectMpd() {
    if (stopping || mpdSock) return;
    const s = net.connect({ host: cfg.source.host, port: cfg.source.port });
    mpdSock = s;
    let headerBuf = Buffer.alloc(0);
    let inBody = false;

    s.setNoDelay(true);
    s.setKeepAlive(true, 10000);
    s.once('connect', () => {
        // Icy-MetaData deliberately absent: MPD then sends a plain stream (Ogg carries tags in-band).
        s.write(`GET / HTTP/1.1\r\nHost: ${cfg.source.host}\r\nUser-Agent: mpd-output-relay/${VERSION}\r\nConnection: close\r\n\r\n`);
    });
    s.on('data', (chunk) => {
        if (inBody) { onAudio(chunk); return; }
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const end = headerBuf.indexOf('\r\n\r\n');
        if (end < 0) {
            if (headerBuf.length > 16384) { log('error', 'mpd: header too large'); s.destroy(); }
            return;
        }
        const head = headerBuf.subarray(0, end).toString('latin1');
        const statusLine = head.split('\r\n')[0];
        if (!/^HTTP\/1\.[01] 200 /.test(statusLine)) {
            log('error', 'mpd: unexpected response', { statusLine });
            s.destroy();
            return;
        }
        const m = /^content-type:\s*(.+)$/im.exec(head);
        contentType = m ? m[1].trim() : 'application/octet-stream';
        inBody = true;
        mpdAttempt = 0;
        mpdWaitLogged = 0;
        status.mpd = 'connected';
        publishStatus();
        log('info', 'mpd: stream open', { contentType });
        connectIcecast();
        const rest = headerBuf.subarray(end + 4);
        headerBuf = Buffer.alloc(0);
        if (rest.length) onAudio(rest);
    });
    const gone = (why) => {
        if (mpdSock !== s) return;
        mpdSock = null;
        const wasOpen = inBody;
        publishStatus();
        // MPD binds the httpd listener only once the output is opened, i.e. at the first playback
        // after an MPD start. Until then ECONNREFUSED is the idle state, not a fault.
        if (why === 'ECONNREFUSED' && !wasOpen) {
            status.mpd = 'waiting';
            mpdAttempt += 1;
            if (Date.now() - mpdWaitLogged > 60000) {
                mpdWaitLogged = Date.now();
                log('info', 'mpd: feed not open yet (MPD idle or starting), waiting', { port: cfg.source.port });
            }
        } else {
            status.mpd = 'disconnected';
            log('warn', `mpd: ${why}`);
        }
        // Without a source there is nothing to send; drop Icecast cleanly and rebuild both.
        dropIcecast('source gone');
        clearTimeout(mpdTimer);
        if (!stopping) mpdTimer = setTimeout(connectMpd, Math.min(5000, 1000 * Math.max(1, mpdAttempt)));
    };
    s.once('error', (e) => { status.lastError = `mpd: ${e.code || e.message}`; gone(e.code || e.message); });
    s.once('close', () => gone('closed'));
}

function onAudio(chunk) {
    if (!iceSock || !iceSock.ready) return; // no peer: MPD's bytes are dropped here, never queued
    iceSock.write(chunk);
    status.bytesRelayed += chunk.length;
}

// ------------------------------------------------------------ Icecast side

function basicAuth() {
    return Buffer.from(`${cfg.icecast.user}:${cfg.icecast.password}`).toString('base64');
}

function iceHeaders() {
    const ic = cfg.icecast;
    const h = [
        `SOURCE ${ic.mount} HTTP/1.0`,
        `Host: ${ic.host}:${ic.port}`,
        `Authorization: Basic ${basicAuth()}`,
        `User-Agent: mpd-output-relay/${VERSION}`,
        `Content-Type: ${contentType}`,
        `ice-public: ${ic.public ? 1 : 0}`,
        `ice-name: ${clean(ic.name)}`,
    ];
    if (ic.description) h.push(`ice-description: ${clean(ic.description)}`);
    if (ic.genre) h.push(`ice-genre: ${clean(ic.genre)}`);
    if (ic.url) h.push(`ice-url: ${clean(ic.url)}`);
    if (cfg.bitrate_kbps > 0) h.push(`ice-audio-info: bitrate=${cfg.bitrate_kbps}`);
    return h.join('\r\n') + '\r\n\r\n';
}

// Header values must not carry CR/LF (request splitting).
function clean(v) { return String(v).replace(/[\r\n]+/g, ' '); }

function connectIcecast() {
    if (stopping || iceSock || !mpdSock) return;
    const ic = cfg.icecast;
    iceAttempt += 1;
    const opts = { host: ic.host, port: ic.port };
    const s = ic.tls ? tls.connect(Object.assign({ servername: ic.host }, opts)) : net.connect(opts);
    s.ready = false;
    iceSock = s;
    let respBuf = Buffer.alloc(0);
    let maxQueue = stallThreshold();
    let stalledSince = 0;

    s.setNoDelay(true);
    s.setKeepAlive(true, 10000);
    // Connect phase only: Node's timeout is inactivity based and our own writes reset it.
    s.setTimeout(15000, () => { if (!s.ready) { status.lastError = 'icecast: connect timeout'; s.destroy(new Error('connect timeout')); } });
    s.once(ic.tls ? 'secureConnect' : 'connect', () => {
        s.write(iceHeaders());
    });
    s.on('data', (chunk) => {
        if (s.ready) return; // Icecast sends nothing after 200 OK; anything else is noise
        respBuf = Buffer.concat([respBuf, chunk]);
        const end = respBuf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const statusLine = respBuf.subarray(0, end).toString('latin1').split('\r\n')[0];
        const code = parseInt((statusLine.split(' ')[1] || '0'), 10);
        // Icecast puts the reason ("Mountpoint in use", "Content-type not supported") in an HTML body after the headers.
        const reason = respBuf.subarray(end + 4).toString('latin1').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (code === 200) {
            s.ready = true;
            s.setTimeout(0);
            iceAttempt = 0;
            status.icecast = 'connected';
            status.since = new Date().toISOString();
            status.lastError = null;
            publishStatus();
            log('info', 'icecast: source accepted', { mount: ic.mount, host: ic.host, port: ic.port });
            startStallTicker();
        } else {
            status.lastError = `icecast: ${statusLine}${reason ? ' - ' + reason : ''}`;
            log('error', 'icecast: rejected', { statusLine, reason });
            // 403 covers "Mountpoint in use" (the previous source not yet reaped): plain backoff, not the auth hold-off.
            s.authFailure = code === 401;
            s.destroy();
        }
    });
    const gone = (why) => {
        if (iceSock !== s) return;
        iceSock = null;
        stopStallTicker();
        const wasReady = s.ready;
        status.icecast = 'disconnected';
        publishStatus();
        log('warn', `icecast: ${why}`, { wasReady });
        scheduleIcecast(s.authFailure);
    };
    s.once('error', (e) => { status.lastError = `icecast: ${e.code || e.message}`; gone(e.code || e.message); });
    s.once('close', () => gone('closed'));

    // Stall detector: kernel send buffer full => bytes pile up in Node's writable queue.
    function startStallTicker() {
        stopStallTicker();
        stallTicker = setInterval(() => {
            if (iceSock !== s) { stopStallTicker(); return; }
            if (s.writableLength > maxQueue) {
                if (!stalledSince) { stalledSince = Date.now(); log('warn', 'icecast: send queue not draining', { queued: s.writableLength }); }
                else if (Date.now() - stalledSince >= cfg.stall_seconds * 1000) {
                    status.lastError = 'icecast: peer stalled';
                    log('error', 'icecast: peer stalled, dropping connection', { queued: s.writableLength, seconds: cfg.stall_seconds });
                    s.destroy(new Error('stalled'));
                }
            } else if (stalledSince) {
                stalledSince = 0;
                log('info', 'icecast: send queue drained');
            }
        }, 1000);
    }
}

function stallThreshold() {
    // Roughly stall_seconds worth of audio at the configured bitrate; 64 KiB floor, 1 MiB ceiling.
    const perSec = cfg.bitrate_kbps > 0 ? cfg.bitrate_kbps * 125 : 40000;
    return Math.min(1024 * 1024, Math.max(64 * 1024, perSec * cfg.stall_seconds));
}

function stopStallTicker() { clearInterval(stallTicker); stallTicker = null; }

function dropIcecast(why) {
    clearTimeout(iceTimer);
    if (!iceSock) return;
    const s = iceSock;
    iceSock = null;
    stopStallTicker();
    status.icecast = 'disconnected';
    publishStatus();
    log('info', `icecast: closing (${why})`);
    s.destroy();
}

function scheduleIcecast(authFailure) {
    clearTimeout(iceTimer);
    if (stopping || !mpdSock) return;
    const delay = authFailure
        ? cfg.auth_backoff_seconds
        : Math.min(cfg.backoff_max_seconds, Math.pow(2, Math.min(iceAttempt, 6)));
    status.reconnects += 1;
    publishStatus();
    log('info', 'icecast: retry scheduled', { inSeconds: delay, attempt: iceAttempt });
    iceTimer = setTimeout(connectIcecast, delay * 1000);
}

// ------------------------------------------------------------------ lifecycle

function shutdown(sig) {
    stopping = true;
    log('info', `relay: ${sig}, shutting down`);
    clearTimeout(iceTimer); clearTimeout(mpdTimer); stopStallTicker();
    if (iceSock) iceSock.destroy();
    if (mpdSock) mpdSock.destroy();
    setTimeout(() => process.exit(0), 200).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => { log('error', 'relay: uncaught', { message: e.message }); process.exit(1); });

log('info', 'relay: starting', { version: VERSION, source: cfg.source, icecast: { host: cfg.icecast.host, port: cfg.icecast.port, mount: cfg.icecast.mount, tls: !!cfg.icecast.tls } });
publishStatus();
connectMpd();
