/**
 * Standalone signalling server.
 *
 * The dev server (index.js) bundles Vite for local hacking. This one is the
 * deployable half: pure socket.io signalling plus the built static app, no
 * build tooling, so it runs on any small always-on host.
 *
 * It only relays connection setup - SDP offers, ICE candidates, public keys.
 * File bytes never pass through here; those go peer to peer over WebRTC. A
 * transfer of any size costs this server a few kilobytes of signalling.
 */
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST'] },
});

app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: countRooms() }));

/**
 * ICE configuration is served rather than hard-coded so TURN credentials stay
 * out of the bundle and can be rotated without a rebuild.
 *
 * STUN alone gets a direct peer connection on most home networks. Symmetric
 * NAT and carrier-grade NAT need TURN, which *relays every byte* - so a TURN
 * server carries the full file, unlike this signalling server. That is a real
 * bandwidth bill, which is why it is opt-in via env rather than on by default.
 */
app.get('/api/ice', (_req, res) => {
    const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ];
    if (process.env.TURN_URL) {
        iceServers.push({
            urls: process.env.TURN_URL.split(',').map(u => u.trim()),
            username: process.env.TURN_USERNAME,
            credential: process.env.TURN_CREDENTIAL,
        });
    }
    res.json({ iceServers, turn: Boolean(process.env.TURN_URL) });
});

// Serve the built app when it is present (single-deploy mode)
const dist = path.join(__dirname, '..', 'dist');
if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

function countRooms() {
    return [...io.sockets.adapter.rooms.keys()].filter(r => r.length === 6).length;
}

io.on('connection', (socket) => {
    socket.on('join', (roomId) => {
        socket.join(roomId);
        const size = io.sockets.adapter.rooms.get(roomId)?.size || 0;
        console.log(`join ${roomId} (${size})`);
        socket.to(roomId).emit('user-connected', socket.id);
    });

    const relay = (event) => socket.on(event, (payload) => {
        if (payload?.target) io.to(payload.target).emit(event, payload);
    });
    ['offer', 'answer', 'ice-candidate', 'public-key', 'session-key'].forEach(relay);

    socket.on('disconnect', () => {
        for (const room of socket.rooms) {
            if (room !== socket.id) socket.to(room).emit('user-disconnected', socket.id);
        }
    });
});

httpServer.listen(PORT, () => {
    console.log(`AeroSend signalling on :${PORT}`);
    console.log(process.env.TURN_URL ? 'TURN configured' : 'STUN only (no TURN relay)');
});
