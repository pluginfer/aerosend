import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLocalIp } from './ip-utils.js';

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

// Socket.io signaling
io.on('connection', (socket) => {
    console.log('✅ User connected:', socket.id);

    socket.on('join', (roomId) => {
        socket.join(roomId);
        const roomSize = io.sockets.adapter.rooms.get(roomId)?.size || 0;
        console.log(`📡 Socket ${socket.id} joined room ${roomId}. Room size: ${roomSize}`);
        socket.to(roomId).emit('user-connected', socket.id);
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

    socket.on('disconnect', () => {
        console.log('❌ User disconnected:', socket.id);
    });
});

// Middleware
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

// Serve production build from dist folder
app.use(express.static(path.join(__dirname, '../dist')));

// Catch-all route to serve index.html for SPA routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'));
});

const ip = getLocalIp();
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`\n\n🚀 AeroSend Ready (PRODUCTION BUILD)!`);
    console.log(`> Local:   http://localhost:${PORT}`);
    console.log(`> Network: http://${ip}:${PORT}`);
    console.log(`\nServing bundled app from /dist folder`);
    console.log(`All dependencies bundled - NO CDN required!\n`);
});
