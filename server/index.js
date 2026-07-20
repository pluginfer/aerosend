import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLocalIp } from './ip-utils.js';
import { createServer as createViteServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = 3000;

// For payment routes (will be CommonJS module)
// const paymentRoutes = require('./payment-routes');
// app.use('/api', paymentRoutes);

// Socket.io signaling
io.on('connection', (socket) => {
    console.log('✅ User connected:', socket.id);

    socket.on('join', (roomId) => {
        socket.join(roomId);
        const roomSize = io.sockets.adapter.rooms.get(roomId)?.size || 0;
        console.log(`📡 Socket ${socket.id} joined room ${roomId}. Room size: ${roomSize}`);
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

async function startServer() {
    const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
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
    httpServer.listen(PORT, '0.0.0.0', () => {
        console.log(`\n\n🚀 AeroSend Ready!`);
        console.log(`> Local:   http://localhost:${PORT}`);
        console.log(`> Network: http://${ip}:${PORT}`);
        console.log(`\nScan the QR code on your mobile device to connect!`);
        console.log(`\n🧪 Test Mode: Add ?testmode=true to URL to enable tier testing\n`);
    });
}

startServer();
