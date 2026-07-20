/**
 * Enhanced WebRTC Manager with multi-file support, encryption, and transfer resume
 * Maintains simplicity while adding powerful features
 */

import { io } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import { EncryptionManager } from './encryption.js';
import { transferStorage } from './transfer-storage.js';
import { DiskWriter } from './disk-writer.js';
import { buildManifest } from './chunker.js';
import { chunkStore } from './chunk-store.js';

export class EnhancedWebRTCManager {
    constructor(roomId, onStatusChange, onProgress, onFileReceived, onEncryptionStatus) {
        this.socket = null;
        this.peerConnection = null;
        this.dataChannel = null;
        this.roomId = roomId;
        this.targetId = null;
        this.isInitiator = false;

        // Callbacks
        this.onStatusChange = onStatusChange || (() => { });
        this.onProgress = onProgress || (() => { });
        this.onFileReceived = onFileReceived || (() => { });
        this.onEncryptionStatus = onEncryptionStatus || (() => { });

        // File queue for multi-file transfers
        this.fileQueue = [];
        this.currentFileIndex = 0;
        this.isTransferring = false;

        // Receiving state
        // (chunks now stream to disk via DiskWriter - nothing buffered here)
        this.receivedSize = 0;
        this.expectedSize = 0;
        this.receivingFileName = '';
        this.receivingFileId = null;

        // Transfer resume
        this.transferId = null;
        this.completedChunks = new Set();
        this.totalChunks = 0;

        // Encryption
        this.encryption = new EncryptionManager();

        this.CHUNK_SIZE = 64 * 1024; // 64KB chunks
        this.HIGH_WATER_MARK = 16 * 1024 * 1024; // 16MB buffer threshold
    }

    async initialize() {
        console.log('🚀 EnhancedWebRTCManager: Starting initialization...');

        // Initialize encryption keys
        await this.encryption.generateKeyPair();
        await this.encryption.generateSessionKey();
        console.log('🔐 Encryption keys generated');

        // Initialize storage and cleanup
        await transferStorage.init();
        await transferStorage.cleanupOldTransfers();
        console.log('💾 Storage initialized');

        console.log('📡 Connecting to Socket.io server...');
        this.socket = io();

        this.socket.on('connect', () => {
            console.log('✅ Connected to signaling server, ID:', this.socket.id);
            console.log('📡 Joining room:', this.roomId);
            this.onStatusChange('Waiting for peer...');
            this.socket.emit('join', this.roomId);
        });

        this.socket.on('user-connected', async (userId) => {
            console.log('👤 User connected:', userId);
            if (!this.targetId && userId !== this.socket.id) {
                this.targetId = userId;
                this.onStatusChange('Peer Found! Connecting...');
                await this.startConnection(userId);
            }
        });

        this.socket.on('offer', async (payload) => {
            if (payload.target === this.socket.id) {
                this.targetId = payload.sender;
                await this.handleOffer(payload);
            }
        });

        this.socket.on('answer', async (payload) => {
            if (payload.target === this.socket.id) {
                await this.handleAnswer(payload);
            }
        });

        this.socket.on('ice-candidate', async (payload) => {
            if (payload.target === this.socket.id) {
                await this.handleNewICECandidate(payload);
            }
        });

        // Encryption key exchange
        this.socket.on('public-key', async (payload) => {
            if (payload.target === this.socket.id) {
                await this.handlePublicKeyExchange(payload);
            }
        });

        this.socket.on('session-key', async (payload) => {
            if (payload.target === this.socket.id) {
                await this.handleSessionKeyExchange(payload);
            }
        });
    }

    async startConnection(targetId) {
        this.targetId = targetId || this.targetId;
        if (!this.targetId) {
            console.error("❌ No target to connect to");
            return;
        }

        this.isInitiator = true;
        this.createPeerConnection();

        this.dataChannel = this.peerConnection.createDataChannel("file-transfer", {
            ordered: true
        });
        this.setupDataChannel();

        const offer = await this.peerConnection.createOffer();
        await this.peerConnection.setLocalDescription(offer);

        this.socket.emit('offer', {
            target: this.targetId,
            sender: this.socket.id,
            sdp: this.peerConnection.localDescription
        });

        this.onStatusChange('Connecting...');
    }

    createPeerConnection() {
        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        };
        this.peerConnection = new RTCPeerConnection(configuration);

        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate && this.targetId) {
                this.socket.emit('ice-candidate', {
                    target: this.targetId,
                    sender: this.socket.id,
                    candidate: event.candidate
                });
            }
        };

        this.peerConnection.onconnectionstatechange = () => {
            console.log('🔌 Connection state:', this.peerConnection.connectionState);
            if (this.peerConnection.connectionState === 'connected') {
                this.onStatusChange('Connected to Peer');
                this.initiateEncryption();
            } else if (this.peerConnection.connectionState === 'disconnected') {
                this.onStatusChange('Connection lost. Attempting to reconnect...');
                this.handleDisconnection();
            }
        };

        if (!this.isInitiator) {
            this.peerConnection.ondatachannel = (event) => {
                this.dataChannel = event.channel;
                this.setupDataChannel();
            };
        }
    }

    setupDataChannel() {
        this.dataChannel.binaryType = 'arraybuffer';

        this.dataChannel.onopen = () => {
            console.log('📡 Data Channel Open');
            this.onStatusChange('Ready to Transfer');
        };

        this.dataChannel.onmessage = async (event) => {
            await this.handleDataMessage(event.data);
        };

        this.dataChannel.onerror = (error) => {
            console.error('❌ Data channel error:', error);
            this.handleDisconnection();
        };
    }

    async handleOffer(payload) {
        this.createPeerConnection();
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);

        this.socket.emit('answer', {
            target: payload.sender,
            sender: this.socket.id,
            sdp: this.peerConnection.localDescription
        });
    }

    async handleAnswer(payload) {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    }

    async handleNewICECandidate(payload) {
        try {
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } catch (e) {
            console.error('❌ Error adding ICE candidate', e);
        }
    }

    // ==================== ENCRYPTION ====================

    async initiateEncryption() {
        // Exchange public keys
        const publicKey = await this.encryption.exportPublicKey();
        this.socket.emit('public-key', {
            target: this.targetId,
            sender: this.socket.id,
            publicKey: publicKey
        });
    }

    async handlePublicKeyExchange(payload) {
        await this.encryption.importPeerPublicKey(payload.publicKey);

        // If initiator, send encrypted session key
        if (this.isInitiator) {
            const encryptedSessionKey = await this.encryption.exportEncryptedSessionKey();
            this.socket.emit('session-key', {
                target: payload.sender,
                sender: this.socket.id,
                sessionKey: encryptedSessionKey
            });
            this.onEncryptionStatus(true);
            console.log('🔒 Encryption active');
        } else {
            // Send public key back
            const publicKey = await this.encryption.exportPublicKey();
            this.socket.emit('public-key', {
                target: payload.sender,
                sender: this.socket.id,
                publicKey: publicKey
            });
        }
    }

    async handleSessionKeyExchange(payload) {
        await this.encryption.importEncryptedSessionKey(payload.sessionKey);
        this.onEncryptionStatus(true);
        console.log('🔒 Encryption active');
    }

    // ==================== MULTI-FILE TRANSFER ====================

    async sendFiles(files) {
        this.fileQueue = Array.from(files);
        this.currentFileIndex = 0;
        this.isTransferring = true;

        // The session key is exchanged asynchronously over the signalling
        // socket. Starting mid-exchange means the sender may encrypt while the
        // receiver is still expecting plaintext (or the reverse) - which
        // corrupts data rather than failing loudly. Settle it first.
        await this.waitForEncryption();

        await this.sendNextFile();
    }

    /**
     * Resolve once encryption is agreed, or after a timeout - in which case we
     * proceed unencrypted, which both sides will do consistently because the
     * flag is read per message on each side.
     */
    waitForEncryption(timeoutMs = 5000) {
        if (this.encryption.isEncrypted) return Promise.resolve(true);
        return new Promise(resolve => {
            const started = Date.now();
            const tick = () => {
                if (this.encryption.isEncrypted) return resolve(true);
                if (Date.now() - started > timeoutMs) {
                    console.warn('⚠️ Encryption not established; sending unencrypted');
                    return resolve(false);
                }
                setTimeout(tick, 100);
            };
            tick();
        });
    }

    async sendNextFile() {
        if (this.currentFileIndex >= this.fileQueue.length) {
            this.isTransferring = false;
            this.onStatusChange('All files sent successfully! 🎉');
            return;
        }

        const file = this.fileQueue[this.currentFileIndex];
        this.transferId = uuidv4();
        this.totalChunks = Math.ceil(file.size / this.CHUNK_SIZE);
        this.completedChunks = new Set();

        await this.sendFile(file);
    }

    async sendFile(file) {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            console.error('❌ Data channel not open');
            return;
        }

        // --- Phase 1: fingerprint the file -------------------------------
        // Content-defined chunking gives every chunk an address derived from
        // its bytes, so the peer can tell us what it already holds.
        this.onStatusChange(`Analysing ${file.name}...`);
        const manifest = await buildManifest(file, p => this.onProgress(p * 0.15));

        this.sendControl({
            type: 'manifest',
            id: this.transferId,
            fileIndex: this.currentFileIndex,
            totalFiles: this.fileQueue.length,
            name: manifest.name,
            size: manifest.size,
            mime: manifest.mime,
            chunks: manifest.chunks,
        });

        // --- Phase 2: ask what they're missing ---------------------------
        const needed = new Set(await new Promise(resolve => { this.needResolver = resolve; }));

        const toSend = manifest.chunks.filter(c => needed.has(c.hash));
        // A hash can repeat inside one file; send those bytes only once.
        const unique = [];
        const seen = new Set();
        for (const c of toSend) {
            if (seen.has(c.hash)) continue;
            seen.add(c.hash);
            unique.push(c);
        }

        const sendBytes = unique.reduce((s, c) => s + c.length, 0);
        const savedPct = file.size > 0 ? (1 - sendBytes / file.size) * 100 : 0;

        if (savedPct > 0.5) {
            console.log(
                `🎯 Dedup: sending ${(sendBytes / 1048576).toFixed(1)}MB of ` +
                `${(file.size / 1048576).toFixed(1)}MB — ${savedPct.toFixed(1)}% already on the peer`
            );
            this.onStatusChange(
                `Sending ${file.name} — ${savedPct.toFixed(0)}% skipped (already there)`
            );
        } else {
            this.onStatusChange(`Sending ${file.name} (${this.currentFileIndex + 1}/${this.fileQueue.length})...`);
        }

        // --- Phase 3: ship only the gaps ---------------------------------
        // Chunks can exceed the SCTP message limit, so each is split into
        // negotiated-size frames. The receiver reassembles using the lengths
        // it already has from the manifest.
        const frameSize = this.negotiateChunkSize();
        let sent = 0;
        let lastCheckpoint = 0;

        for (const chunk of unique) {
            let off = 0;
            while (off < chunk.length) {
                if (this.dataChannel.bufferedAmount > this.HIGH_WATER_MARK) {
                    await this.waitForDrain();
                }
                if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
                    console.warn('⚠️ Channel closed mid-transfer; checkpoint retained for resume');
                    return;
                }

                const end = Math.min(off + frameSize, chunk.length);
                const slice = file.slice(chunk.offset + off, chunk.offset + end);
                let data = await slice.arrayBuffer();
                const plain = data.byteLength;

                if (this.encryption.isEncrypted) {
                    data = await this.encryption.encryptChunk(data);
                }
                this.dataChannel.send(data);

                off += plain;
                sent += plain;

                const now = Date.now();
                if (now - lastCheckpoint > 2000) {
                    lastCheckpoint = now;
                    transferStorage.saveCheckpoint(this.transferId, {
                        fileName: file.name,
                        fileSize: file.size,
                        sentBytes: sent,
                        totalBytes: sendBytes,
                    }).catch(() => { /* best-effort */ });
                }

                const frac = sendBytes > 0 ? sent / sendBytes : 1;
                this.onProgress((this.currentFileIndex + 0.15 + 0.85 * frac) / this.fileQueue.length);
            }
        }

        this.sendControl({ type: 'eof', id: this.transferId });

        console.log(`✅ Sent ${file.name} (${(sendBytes / 1048576).toFixed(1)}MB on the wire)`);
        await transferStorage.deleteCheckpoint(this.transferId);
        this.currentFileIndex++;
        this.sendNextFile();
    }

    /** Send a JSON control message, encrypted when a session key is up. */
    async sendControl(obj) {
        const json = JSON.stringify(obj);
        if (this.encryption.isEncrypted) {
            const enc = await this.encryption.encryptChunk(new TextEncoder().encode(json));
            this.dataChannel.send(JSON.stringify({
                type: 'encrypted-control',
                data: this.encryption.arrayBufferToBase64(enc),
            }));
        } else {
            this.dataChannel.send(json);
        }
    }

    /**
     * Largest chunk this connection can actually carry.
     * Chrome/Firefox negotiate 256KB; older stacks may offer less. Guessing a
     * fixed 64KB left ~4x of throughput unused.
     */
    negotiateChunkSize() {
        const GCM_OVERHEAD = 32;             // 12-byte IV + 16-byte tag + slack
        const negotiated = this.peerConnection?.sctp?.maxMessageSize ?? 65536;
        const cap = Math.min(negotiated, 262144);
        const size = Math.max(16384, cap - GCM_OVERHEAD);
        if (size !== this.CHUNK_SIZE) {
            console.log(`📦 Chunk size: ${(size / 1024).toFixed(0)}KB (SCTP max ${negotiated})`);
        }
        return size;
    }

    /**
     * Resolve as soon as the send buffer drains below the low-water mark.
     */
    waitForDrain() {
        return new Promise((resolve) => {
            const ch = this.dataChannel;
            ch.bufferedAmountLowThreshold = this.LOW_WATER_MARK ?? this.HIGH_WATER_MARK / 2;
            const onLow = () => {
                ch.removeEventListener('bufferedamountlow', onLow);
                resolve();
            };
            ch.addEventListener('bufferedamountlow', onLow);
        });
    }

    async handleDataMessage(data) {
        if (typeof data === 'string') {
            const msg = JSON.parse(data);

            if (msg.type === 'encrypted-control') {
                const buf = this.encryption.base64ToArrayBuffer(msg.data);
                const dec = await this.encryption.decryptChunk(buf);
                msg = JSON.parse(new TextDecoder().decode(dec));
            }

            if (msg.type === 'manifest') {
                await this.handleManifest(msg);
            } else if (msg.type === 'need') {
                // We are the sender: the peer just told us what it lacks.
                const resolve = this.needResolver;
                this.needResolver = null;
                if (resolve) resolve(msg.hashes);
            }
            // 'eof' needs no action - assembly finishes when the manifest is
            // fully written, which may happen before eof arrives if most
            // chunks came from the local cache.
        } else {
            let bytes = data;
            if (this.encryption.isEncrypted) {
                bytes = await this.encryption.decryptChunk(bytes);
            }
            this.acceptFrame(new Uint8Array(bytes));
        }
    }

    /**
     * Receiver: compare the manifest against what we already hold and ask
     * only for the difference. This is where "sends less than the file"
     * actually happens.
     */
    async handleManifest(manifest) {
        this.manifest = manifest;
        this.receivingFileName = manifest.name;
        this.expectedSize = manifest.size;
        this.receivedSize = 0;

        // A file can repeat the same chunk; ask for each distinct one once.
        const distinct = [];
        const seen = new Set();
        for (const c of manifest.chunks) {
            if (seen.has(c.hash)) continue;
            seen.add(c.hash);
            distinct.push(c);
        }

        const held = await chunkStore.have(distinct.map(c => c.hash));
        const needList = distinct.filter(c => !held.has(c.hash));

        const haveBytes = distinct
            .filter(c => held.has(c.hash))
            .reduce((s, c) => s + c.length, 0);
        const savedPct = manifest.size > 0 ? (haveBytes / manifest.size) * 100 : 0;

        if (savedPct > 0.5) {
            console.log(
                `🎯 Already hold ${(haveBytes / 1048576).toFixed(1)}MB of ` +
                `${(manifest.size / 1048576).toFixed(1)}MB — requesting only the rest`
            );
            this.onStatusChange(`Receiving ${manifest.name} — ${savedPct.toFixed(0)}% from cache`);
        } else {
            this.onStatusChange(`Receiving ${manifest.name}...`);
        }

        // Frame reassembly state for the chunks we asked for
        this.needList = needList;
        this.needIdx = 0;
        this.acc = [];
        this.accLen = 0;
        this.chunkWaiters = new Map();

        this.writer = new DiskWriter();
        await this.writer.open(manifest.name, manifest.size);

        await this.sendControl({ type: 'need', hashes: needList.map(c => c.hash) });

        this.assemble().catch(err => {
            console.error('Assembly failed:', err);
            this.onStatusChange('Transfer failed');
            this.writer?.abort();
        });
    }

    /**
     * Incoming frames are the requested chunks, back to back and in order.
     * Chunk lengths come from the manifest, so no per-chunk header is needed.
     */
    acceptFrame(bytes) {
        // A frame can arrive before the manifest if messages are reordered or
        // a previous transfer was aborted. Without this guard the accumulator
        // is undefined and the whole channel dies on a TypeError.
        if (!this.needList || this.needIdx >= this.needList.length) {
            console.warn('⚠️ Ignoring chunk frame received outside a transfer');
            return;
        }

        this.acc.push(bytes);
        this.accLen += bytes.byteLength;

        while (this.needIdx < this.needList.length) {
            const want = this.needList[this.needIdx];
            if (this.accLen < want.length) break;

            // Splice exactly `want.length` bytes out of the accumulator
            const chunk = new Uint8Array(want.length);
            let filled = 0;
            while (filled < want.length) {
                const head = this.acc[0];
                const take = Math.min(head.byteLength, want.length - filled);
                chunk.set(head.subarray(0, take), filled);
                filled += take;
                if (take === head.byteLength) this.acc.shift();
                else this.acc[0] = head.subarray(take);
            }
            this.accLen -= want.length;
            this.needIdx++;

            chunkStore.put(want.hash, chunk).catch(() => { /* cache is best-effort */ });

            const waiters = this.chunkWaiters.get(want.hash);
            if (waiters) {
                this.chunkWaiters.delete(want.hash);
                for (const w of waiters) w(chunk);
            }
        }
    }

    awaitChunk(hash) {
        return new Promise(resolve => {
            const list = this.chunkWaiters.get(hash) ?? [];
            list.push(resolve);
            this.chunkWaiters.set(hash, list);
        });
    }

    /**
     * Walk the manifest in order, taking each chunk from the local cache or
     * from the wire, and stream it to disk. Memory stays flat: at most one
     * chunk is held at a time.
     */
    async assemble() {
        for (const c of this.manifest.chunks) {
            let bytes = await chunkStore.get(c.hash);
            if (!bytes) bytes = await this.awaitChunk(c.hash);

            await this.writer.write(bytes);
            this.receivedSize += c.length;
            this.onProgress(Math.min(this.receivedSize / this.expectedSize, 1));
        }

        const blob = await this.writer.close();
        const name = this.receivingFileName;
        this.writer = null;

        if (blob) {
            this.onFileReceived(blob, name);
            this.onStatusChange('File Received! Download starting...');
        } else {
            this.onStatusChange(`Saved ${name} to disk ✅`);
        }
        this.onProgress(1);
        chunkStore.prune().catch(() => { });
    }

    // ==================== TRANSFER RESUME ====================

    async handleDisconnection() {
        if (this.isTransferring && this.transferId) {
            // Save current state
            await transferStorage.saveCheckpoint(this.transferId, {
                fileName: this.fileQueue[this.currentFileIndex]?.name,
                fileSize: this.fileQueue[this.currentFileIndex]?.size,
                completedChunks: this.completedChunks,
                totalChunks: this.totalChunks
            });
        }

        // Attempt reconnection
        setTimeout(() => {
            if (this.peerConnection.connectionState !== 'connected') {
                this.onStatusChange('Reconnecting...');
                // Logic to retry connection would go here
            }
        }, 2000);
    }

    async checkIncompleteTransfers() {
        const incomplete = await transferStorage.getIncompleteTransfers();
        return incomplete;
    }

    // ==================== UTILITY ====================

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
        }
        if (this.peerConnection) {
            this.peerConnection.close();
        }
    }
}
