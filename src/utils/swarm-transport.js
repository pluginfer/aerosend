/**
 * Mesh transport - the layer that makes SwarmScheduler real.
 *
 * The 1:1 manager opens one RTCPeerConnection. That means sending to N devices
 * costs the sender N uploads, because each receiver pulls independently.
 *
 * Here every peer connects to every other peer, announces the chunks it holds,
 * and serves them on request. A receiver that has a chunk is just as good a
 * source as the original sender, so the origin uploads each chunk roughly once
 * no matter how many devices are waiting.
 *
 * Protocol, per data channel (messages are ordered within a channel, so a
 * chunk header is always followed by that chunk's frames):
 *
 *   {t:'manifest', manifest}   seeder announces a file
 *   {t:'have', hashes}         peer advertises chunks it holds
 *   {t:'want', hash}           request a chunk
 *   {t:'chunk', hash, length}  header, then binary frames totalling length
 *   {t:'no', hash}             sorry, do not have it
 */
import { io } from 'socket.io-client';
import { buildManifest } from './chunker.js';
import { chunkStore } from './chunk-store.js';
import { SwarmScheduler } from './swarm-scheduler.js';
import { DiskWriter } from './disk-writer.js';

const FRAME = 192 * 1024;

export class SwarmSession {
    constructor(roomId, {
        onStatus = () => { }, onProgress = () => { },
        onPeers = () => { }, onFile = () => { }, onStats = () => { },
    } = {}) {
        this.roomId = roomId;
        this.onStatus = onStatus;
        this.onProgress = onProgress;
        this.onPeers = onPeers;
        this.onFile = onFile;
        this.onStats = onStats;

        this.socket = null;
        this.selfId = null;
        this.links = new Map();      // peerId -> { pc, dc }
        this.iceServers = null;

        this.file = null;            // set when we are the seeder
        this.manifest = null;
        this.byHash = new Map();     // hash -> {offset, length}
        this.scheduler = null;
        this.writer = null;
        this.incoming = new Map();   // peerId -> { hash, need, parts }
        this.waiters = new Map();    // hash -> [resolve]
        this.uploaded = 0;
        this.assembling = false;
    }

    async start() {
        const base = import.meta.env?.VITE_SIGNAL_URL;
        try {
            const res = await fetch(`${base || ''}/api/ice`);
            if (res.ok) this.iceServers = (await res.json()).iceServers;
        } catch { /* public STUN default below */ }

        this.socket = base ? io(base, { transports: ['websocket', 'polling'] }) : io();

        this.socket.on('connect', () => {
            this.selfId = this.socket.id;
            this.onStatus('Waiting for peers...');
            this.socket.emit('join', this.roomId);
        });

        // Full roster on join, so a third device connects to everyone rather
        // than only to whoever arrives after it.
        this.socket.on('room-peers', (ids) => ids.forEach(id => this.connectTo(id, true)));
        this.socket.on('user-connected', (id) => this.connectTo(id, false));
        this.socket.on('user-disconnected', (id) => this.dropPeer(id));

        this.socket.on('offer', async (p) => {
            if (p.target !== this.selfId) return;
            const link = this.ensureLink(p.sender);
            await link.pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
            const answer = await link.pc.createAnswer();
            await link.pc.setLocalDescription(answer);
            this.socket.emit('answer', { target: p.sender, sender: this.selfId, sdp: answer });
        });

        this.socket.on('answer', async (p) => {
            if (p.target !== this.selfId) return;
            const link = this.links.get(p.sender);
            if (link) await link.pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
        });

        this.socket.on('ice-candidate', async (p) => {
            if (p.target !== this.selfId) return;
            const link = this.links.get(p.sender);
            if (link?.pc.remoteDescription) {
                try { await link.pc.addIceCandidate(p.candidate); } catch { /* stale */ }
            }
        });
    }

    ensureLink(peerId) {
        let link = this.links.get(peerId);
        if (link) return link;

        const pc = new RTCPeerConnection({
            iceServers: this.iceServers || [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
            ],
        });
        link = { pc, dc: null };
        this.links.set(peerId, link);

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this.socket.emit('ice-candidate', {
                    target: peerId, sender: this.selfId, candidate: e.candidate,
                });
            }
        };
        pc.ondatachannel = (e) => this.bindChannel(peerId, e.channel);
        pc.onconnectionstatechange = () => {
            if (['failed', 'closed'].includes(pc.connectionState)) this.dropPeer(peerId);
        };
        return link;
    }

    /**
     * Both sides learn about each other, so without a rule both would offer at
     * once and the connections would collide. Lower id offers.
     */
    async connectTo(peerId, _known) {
        if (peerId === this.selfId || this.links.has(peerId)) return;
        const link = this.ensureLink(peerId);
        if (this.selfId < peerId) {
            const dc = link.pc.createDataChannel('swarm', { ordered: true });
            this.bindChannel(peerId, dc);
            const offer = await link.pc.createOffer();
            await link.pc.setLocalDescription(offer);
            this.socket.emit('offer', { target: peerId, sender: this.selfId, sdp: offer });
        }
    }

    bindChannel(peerId, dc) {
        dc.binaryType = 'arraybuffer';
        const link = this.ensureLink(peerId);
        link.dc = dc;

        dc.onopen = () => {
            this.onPeers(this.peerCount());
            this.onStatus(`${this.peerCount()} peer${this.peerCount() === 1 ? '' : 's'} connected`);
            // Tell the newcomer what we have, so it can pull from us instead of
            // the origin - that is the whole point of the swarm.
            if (this.manifest) this.send(peerId, { t: 'manifest', manifest: this.manifest });
            this.announceHave(peerId);
        };
        dc.onmessage = (e) => this.onMessage(peerId, e.data);
        dc.onclose = () => this.dropPeer(peerId);
    }

    peerCount() {
        return [...this.links.values()].filter(l => l.dc?.readyState === 'open').length;
    }

    dropPeer(peerId) {
        const link = this.links.get(peerId);
        if (!link) return;
        try { link.dc?.close(); link.pc?.close(); } catch { /* already gone */ }
        this.links.delete(peerId);
        this.scheduler?.dropPeer(peerId);
        this.onPeers(this.peerCount());
        this.pump();
    }

    send(peerId, obj) {
        const dc = this.links.get(peerId)?.dc;
        if (dc?.readyState === 'open') dc.send(JSON.stringify(obj));
    }

    broadcast(obj) {
        for (const id of this.links.keys()) this.send(id, obj);
    }

    async announceHave(peerId = null) {
        if (!this.manifest) return;
        const held = this.file
            ? this.manifest.chunks.map(c => c.hash)          // seeder holds everything
            : [...(await chunkStore.have(this.manifest.chunks.map(c => c.hash)))];
        const msg = { t: 'have', hashes: held };
        peerId ? this.send(peerId, msg) : this.broadcast(msg);
    }

    // ---- Sending -----------------------------------------------------------

    async seed(file) {
        this.file = file;
        this.onStatus(`Analysing ${file.name}...`);
        this.manifest = await buildManifest(file, p => this.onProgress(p * 0.2));
        this.indexManifest();

        this.broadcast({ t: 'manifest', manifest: this.manifest });
        await this.announceHave();
        this.onStatus(`Seeding ${file.name} to ${this.peerCount()} peer(s)`);
    }

    indexManifest() {
        this.byHash.clear();
        for (const c of this.manifest.chunks) {
            if (!this.byHash.has(c.hash)) this.byHash.set(c.hash, c);
        }
    }

    /** Serve a chunk from our own file, or from the local chunk cache. */
    async serve(peerId, hash) {
        let bytes = null;
        const meta = this.byHash.get(hash);
        if (this.file && meta) {
            bytes = new Uint8Array(await this.file.slice(meta.offset, meta.offset + meta.length).arrayBuffer());
        } else {
            bytes = await chunkStore.get(hash);
        }
        if (!bytes) return this.send(peerId, { t: 'no', hash });

        this.send(peerId, { t: 'chunk', hash, length: bytes.byteLength });
        const dc = this.links.get(peerId)?.dc;
        if (!dc) return;

        for (let o = 0; o < bytes.byteLength; o += FRAME) {
            if (dc.bufferedAmount > 8 * 1024 * 1024) {
                await new Promise(r => {
                    dc.bufferedAmountLowThreshold = 2 * 1024 * 1024;
                    const h = () => { dc.removeEventListener('bufferedamountlow', h); r(); };
                    dc.addEventListener('bufferedamountlow', h);
                });
            }
            if (dc.readyState !== 'open') return;
            dc.send(bytes.subarray(o, Math.min(o + FRAME, bytes.byteLength)));
        }
        this.uploaded += bytes.byteLength;
    }

    // ---- Receiving ---------------------------------------------------------

    async onMessage(peerId, data) {
        if (typeof data !== 'string') return this.onBinary(peerId, new Uint8Array(data));

        const m = JSON.parse(data);
        switch (m.t) {
            case 'manifest':
                if (!this.manifest) await this.adoptManifest(m.manifest);
                break;
            case 'have':
                this.scheduler?.announce(peerId, m.hashes, this.file ? false : m.hashes.length === this.manifest?.chunks.length);
                this.pump();
                break;
            case 'want':
                await this.serve(peerId, m.hash);
                break;
            case 'chunk':
                this.incoming.set(peerId, { hash: m.hash, need: m.length, parts: [], got: 0 });
                break;
            case 'no':
                this.scheduler?.markFailed(peerId, m.hash);
                this.pump();
                break;
        }
    }

    async adoptManifest(manifest) {
        this.manifest = manifest;
        this.indexManifest();

        const held = await chunkStore.have(manifest.chunks.map(c => c.hash));
        this.scheduler = new SwarmScheduler(manifest.chunks, held);

        const haveBytes = manifest.chunks
            .filter(c => held.has(c.hash))
            .reduce((s, c) => s + c.length, 0);
        this.onStats({
            name: manifest.name, direction: 'receive',
            wire: manifest.size - haveBytes, total: manifest.size,
            savedPct: manifest.size ? (haveBytes / manifest.size) * 100 : 0,
        });

        this.writer = new DiskWriter();
        await this.writer.open(manifest.name, manifest.size);

        await this.announceHave();
        this.onStatus(`Receiving ${manifest.name}...`);
        this.assemble().catch(err => {
            console.error('Assembly failed:', err);
            this.onStatus('Transfer failed');
            this.writer?.abort();
        });
        this.pump();
    }

    onBinary(peerId, bytes) {
        const slot = this.incoming.get(peerId);
        if (!slot) return;           // frame outside a chunk - ignore

        slot.parts.push(bytes);
        slot.got += bytes.byteLength;
        if (slot.got < slot.need) return;

        const full = new Uint8Array(slot.need);
        let o = 0;
        for (const p of slot.parts) {
            const take = Math.min(p.byteLength, slot.need - o);
            full.set(p.subarray(0, take), o);
            o += take;
        }
        this.incoming.delete(peerId);

        chunkStore.put(slot.hash, full).catch(() => { });
        this.scheduler?.markComplete(slot.hash);

        // Immediately advertise it: this peer is now a source for everyone
        // else, which is what keeps the seeder's cost flat.
        this.broadcast({ t: 'have', hashes: [slot.hash] });

        const waiting = this.waiters.get(slot.hash);
        if (waiting) { this.waiters.delete(slot.hash); waiting.forEach(fn => fn(full)); }

        this.pump();
    }

    /** Ask the scheduler what to fetch, and fetch it. */
    pump() {
        if (!this.scheduler || this.scheduler.complete) return;
        for (const { peerId, hash } of this.scheduler.schedule(4, 16)) {
            this.scheduler.markInflight(peerId, hash);
            this.send(peerId, { t: 'want', hash });
        }
    }

    awaitChunk(hash) {
        return new Promise(resolve => {
            const list = this.waiters.get(hash) ?? [];
            list.push(resolve);
            this.waiters.set(hash, list);
        });
    }

    async assemble() {
        if (this.assembling) return;
        this.assembling = true;

        let written = 0;
        for (const c of this.manifest.chunks) {
            let bytes = await chunkStore.get(c.hash);
            if (!bytes) bytes = await this.awaitChunk(c.hash);
            await this.writer.write(bytes);
            written += c.length;
            this.onProgress(Math.min(written / this.manifest.size, 1));
        }

        const blob = await this.writer.close();
        this.writer = null;
        if (blob) this.onFile(blob, this.manifest.name);
        this.onStatus(`${this.manifest.name} complete ✅`);
        this.onProgress(1);
        chunkStore.prune().catch(() => { });
    }

    disconnect() {
        for (const id of [...this.links.keys()]) this.dropPeer(id);
        this.socket?.disconnect();
    }
}
