import express from 'express';
import { createServer } from 'http';
import net from 'net';
import { createServer as createHttpsServer } from 'https';
import fs from 'fs';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLocalIp } from './ip-utils.js';
import { createServer as createViteServer } from 'vite';
import selfsigned from 'selfsigned';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

/**
 * HTTPS matters more here than it looks.
 *
 * Browsers only expose Web Crypto in a "secure context" - HTTPS, or localhost.
 * A phone opening http://192.168.1.x:3000 gets neither, so crypto.subtle is
 * undefined: no end-to-end encryption, and chunk hashing falls back to a JS
 * SHA-256 that is ~13x slower. Over HTTPS both come back.
 *
 * The certificate is self-signed and regenerated if missing, so the first
 * visit from each device shows a browser warning that has to be accepted once.
 * Set AEROSEND_HTTP=1 to force plain HTTP.
 */
const CERT_DIR = path.join(__dirname, '..', '.certs');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');
const KEY_FILE = path.join(CERT_DIR, 'key.pem');

async function loadOrCreateCert(ip) {
    try {
        if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
            return { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
        }
    } catch { /* fall through and regenerate */ }

    const pems = await selfsigned.generate(
        [{ name: 'commonName', value: ip }],
        {
            days: 3650,
            keySize: 2048,
            algorithm: 'sha256',
            extensions: [{
                name: 'subjectAltName',
                altNames: [
                    { type: 2, value: 'localhost' },
                    { type: 7, ip },
                    { type: 7, ip: '127.0.0.1' },
                ],
            }],
        }
    );

    try {
        fs.mkdirSync(CERT_DIR, { recursive: true });
        fs.writeFileSync(CERT_FILE, pems.cert);
        fs.writeFileSync(KEY_FILE, pems.private);
    } catch (e) {
        console.warn('Could not persist certificate, using in-memory:', e.message);
    }
    return { cert: pems.cert, key: pems.private };
}

const useHttps = process.env.AEROSEND_HTTP !== '1';
let httpServer;   // built in startServer(): the cert is generated asynchronously
let io;

const PORT = 3000;

// For payment routes (will be CommonJS module)
// const paymentRoutes = require('./payment-routes');
// app.use('/api', paymentRoutes);

// Socket.io signaling
function setupSignalling(io) {
io.on('connection', (socket) => {
    console.log(`✅ Socket connected: ${socket.id} from ${(socket.handshake.address || '').replace('::ffff:','')}`);

    socket.on('join', (roomId) => {
        socket.join(roomId);
        const roomSize = io.sockets.adapter.rooms.get(roomId)?.size || 0;
        const from = (socket.handshake.address || '').replace('::ffff:', '');
        console.log(`📡 ${from} joined room ${roomId}. Room size: ${roomSize}`);
        if (roomSize === 1) {
            const others = [...io.sockets.adapter.rooms.keys()]
                .filter(r => r.length === 6 && r !== roomId);
            if (others.length) {
                console.log(`   ⚠️  Alone in ${roomId}. Other open rooms: ${others.join(', ')}`);
            }
        }
        socket.to(roomId).emit('user-connected', socket.id);
        console.log(`   Notified room ${roomId} about new user`);
    });

    socket.on('offer', (payload) => {
        console.log(`🔄 Offer from ${payload.sender} to ${payload.target}`);
        io.to(payload.target).emit('offer', payload);
    });

    socket.on('answer', (payload) => {
        console.log(`✅ Answer from ${payload.sender} to ${payload.target}`);
        io.to(payload.target).emit('answer', payload);
    });

    socket.on('ice-candidate', (payload) => {
        console.log(`🧊 ICE candidate from ${payload.sender} to ${payload.target}`);
        io.to(payload.target).emit('ice-candidate', payload);
    });

    // Encryption key exchange
    socket.on('public-key', (payload) => {
        console.log(`🔑 Public key from ${payload.sender} to ${payload.target}`);
        io.to(payload.target).emit('public-key', payload);
    });

    socket.on('session-key', (payload) => {
        io.to(payload.target).emit('session-key', payload);
    });

    socket.on('disconnect', () => {
        console.log('❌ User disconnected:', socket.id);
    });
});
}

async function startServer() {
    const localIp = getLocalIp();
    httpServer = useHttps
        ? createHttpsServer(await loadOrCreateCert(localIp), app)
        : createServer(app);

    // Serving TLS-only on port 3000 means a plain http:// request just dies
    // with no explanation - the browser talks HTTP, the server answers TLS.
    // Instead, sniff the first byte: 0x16 is a TLS handshake, anything else is
    // plaintext HTTP and gets redirected. Both URLs now work on one port.
    let muxListener = null;
    if (useHttps) {
        const redirector = createServer((req, res) => {
            const host = (req.headers.host || `${localIp}:${PORT}`).split(':')[0];
            res.writeHead(301, { Location: `https://${host}:${PORT}${req.url}` });
            res.end();
        });
        muxListener = net.createServer(socket => {
            // 'readable' + read(1), NOT 'data': the data event switches the
            // socket to flowing mode and bytes are consumed before the TLS
            // layer ever sees them, which breaks the handshake.
            socket.once('readable', () => {
                const first = socket.read(1);
                if (!first) return socket.destroy();
                socket.unshift(first);
                (first[0] === 0x16 ? httpServer : redirector).emit('connection', socket);
            });
            socket.on('error', () => { });
        });
    }
    io = new Server(httpServer, { cors: { origin: '*', methods: ['GET', 'POST'] } });
    setupSignalling(io);

    const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
    });

    // Log every request with its source address. Without this you cannot tell
    // "the phone never reached the machine" from "the phone loaded the page but
    // could not open a socket" - and those have completely different fixes.
    app.use((req, _res, next) => {
        const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
        if (ip !== '127.0.0.1' && ip !== '::1') {
            console.log(`🌐 ${ip} → ${req.method} ${req.url}`);
        }
        next();
    });

    // Middleware for JSON parsing
    app.use(express.json());

    // API endpoint to get server IP
    app.get('/api/ip', (req, res) => {
        res.json({ ip: getLocalIp() });
    });

    // Debug log endpoint
    app.post('/api/debug-log', (req, res) => {
        const logs = req.body.logs || [];
        const timestamp = new Date().toISOString();
        console.log('\n📱 ===== iPhone Debug Logs =====');
        console.log('Time:', timestamp);
        console.log('Count:', logs.length);
        logs.forEach(log => console.log(log));
        console.log('================================\n');
        res.json({ success: true });
    });

    app.use(vite.middlewares);

    const ip = getLocalIp();
    const scheme = useHttps ? 'https' : 'http';
    const listener = muxListener || httpServer;
    listener.listen(PORT, '0.0.0.0', () => {
        console.log(`\n\n🚀 AeroSend Ready!`);
        console.log(`> Local:   ${scheme}://localhost:${PORT}`);
        console.log(`> Network: ${scheme}://${ip}:${PORT}`);
        if (useHttps) {
            console.log(`\n🔒 HTTPS (self-signed). Each device shows a certificate warning`);
            console.log(`   once - accept it. This is what enables encryption and fast`);
            console.log(`   hashing on phones; plain HTTP disables both.`);
        } else {
            console.log(`\n🔓 Plain HTTP: no encryption, and hashing is ~13x slower on`);
            console.log(`   phones. Unset AEROSEND_HTTP to use HTTPS.`);
        }
        console.log(`\nRequests from other devices appear below.\n`);
    });
}

startServer();
