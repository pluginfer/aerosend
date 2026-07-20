import React, { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { DragDropZone } from './components/DragDropZone';
import { HotspotManager } from './components/HotspotManager';
import { EnhancedWebRTCManager } from './utils/EnhancedWebRTCManager';
import { Wifi, ArrowRight, Home, Lock, Send, Sun, Moon } from 'lucide-react';

const fmtBytes = (n) => {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
};

function App() {
    // Room & Connection State
    const [roomId, setRoomId] = useState('');
    const [isHost, setIsHost] = useState(false);
    const [status, setStatus] = useState('Ready');
    const [qrCodeUrl, setQrCodeUrl] = useState('');
    const [isConnected, setIsConnected] = useState(false);

    // File Transfer State
    const [selectedFiles, setSelectedFiles] = useState([]);
    const [transferProgress, setTransferProgress] = useState(0);

    // UI State
    const [modeSelected, setModeSelected] = useState(false);
    const [manualCode, setManualCode] = useState('');

    // Encryption State
    const [isEncrypted, setIsEncrypted] = useState(false);

    // The dedup result - previously only a console.log, which meant the single
    // most interesting thing this app does was invisible to users.
    const [dedup, setDedup] = useState(null);

    // Theme: explicit choice wins, otherwise follow the OS.
    const [theme, setTheme] = useState(() => {
        const saved = localStorage.getItem('aerosend-theme');
        if (saved) return saved;
        return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    });

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('aerosend-theme', theme);
    }, [theme]);

    const webrtcRef = useRef(null);

    useEffect(() => {
        // Join directly if a room was passed in the URL (QR code scan)
        const params = new URLSearchParams(window.location.search);
        const urlRoomId = params.get('room');

        if (urlRoomId) {
            setIsHost(false);
            setRoomId(urlRoomId);
            setModeSelected(true);
            initWebRTC(urlRoomId);
        }

        return () => {
            if (webrtcRef.current) {
                webrtcRef.current.disconnect();
            }
        };
    }, []);

    const initWebRTC = (id) => {
        if (webrtcRef.current) {
            webrtcRef.current.disconnect();
        }

        webrtcRef.current = new EnhancedWebRTCManager(
            id,
            (newStatus) => {
                setStatus(newStatus);
                if (newStatus.includes('Connected') || newStatus.includes('Ready')) {
                    setIsConnected(true);
                }
            },
            (progress) => {
                setTransferProgress(Math.round(progress * 100));
            },
            (fileBlob, fileName) => {
                // Auto-download received file
                const url = window.URL.createObjectURL(fileBlob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                a.click();
                window.URL.revokeObjectURL(url);
            },
            (encrypted) => setIsEncrypted(encrypted),
            (stats) => setDedup(stats)
        );

        webrtcRef.current.initialize();
    };

    const handleCreateRoom = () => {
        setIsHost(true);
        const newRoomId = Math.floor(100000 + Math.random() * 900000).toString();
        setRoomId(newRoomId);
        setModeSelected(true);
        setStatus('Creating Room...');
        initWebRTC(newRoomId);

        fetch('/api/ip')
            .then(res => res.ok ? res.json() : Promise.reject())
            .then(data => {
                const shareUrl = `${window.location.protocol}//${data.ip}:3000/?room=${newRoomId}`;
                console.log('📱 QR Code URL:', shareUrl);
                return QRCode.toDataURL(shareUrl);
            })
            .catch(err => {
                console.warn('Using fallback for QR code:', err);
                const shareUrl = `${window.location.protocol}//${window.location.hostname}:3000/?room=${newRoomId}`;
                return QRCode.toDataURL(shareUrl);
            })
            .then(url => setQrCodeUrl(url))
            .catch(err => console.error('QR generation failed:', err));
    };

    const handleJoinRoom = () => {
        if (manualCode.length === 6) {
            setIsHost(false);
            setRoomId(manualCode);
            setModeSelected(true);
            setStatus('Joining Room...');
            initWebRTC(manualCode);
        }
    };

    // No limits: any number of files, any size.
    const handleFilesSelect = (newFiles) => {
        setSelectedFiles([...selectedFiles, ...newFiles]);
    };

    const handleRemoveFile = (index) => {
        const newFiles = [...selectedFiles];
        newFiles.splice(index, 1);
        setSelectedFiles(newFiles);
    };

    const handleClearAll = () => {
        setSelectedFiles([]);
        setTransferProgress(0);
        setDedup(null);
        setStatus('Ready to Transfer');
    };

    const handleSend = async () => {
        if (!webrtcRef.current || selectedFiles.length === 0) return;
        try {
            await webrtcRef.current.sendFiles(selectedFiles);
        } catch (err) {
            // Previously this rejected silently, so a failure looked exactly
            // like the button doing nothing. Always say something.
            console.error('Transfer failed:', err);
            setStatus(`Transfer failed: ${err?.message || err}`);
        }
    };

    const handleReset = () => {
        setSelectedFiles([]);
        setTransferProgress(0);
        setDedup(null);
        setStatus('Ready to Transfer');
    };

    const handleGoHome = () => {
        if (webrtcRef.current) {
            webrtcRef.current.disconnect();
        }
        setModeSelected(false);
        setIsHost(false);
        setIsConnected(false);
        setRoomId('');
        setQrCodeUrl('');
        setSelectedFiles([]);
        setTransferProgress(0);
        setManualCode('');
        setStatus('Ready');
        setIsEncrypted(false);
        setDedup(null);
    };

    return (
        <div className="app-container">
            <div className="glass-panel animate-fade-in-up">
                <header className="header">
                    <h1 className="title">
                        <span className="mark"><Send size={16} /></span>
                        AeroSend
                    </h1>
                    <div className="header-actions">
                        <button
                            className="btn-icon"
                            onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
                            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
                            aria-label="Toggle theme"
                        >
                            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
                        </button>
                        {isEncrypted && (
                            <div className="encryption-badge" title="End-to-end encrypted">
                                <Lock size={16} />
                                <span>Encrypted</span>
                            </div>
                        )}
                        {modeSelected && <div className="badge">{isHost ? 'HOST' : 'CLIENT'}</div>}
                        {modeSelected && (
                            <button className="btn-icon" onClick={handleGoHome} title="Go Home">
                                <Home size={20} />
                            </button>
                        )}
                    </div>
                </header>

                {!modeSelected ? (
                    <div className="welcome-screen">
                        <p className="subtitle">Choose how to start:</p>
                        <div className="mode-selection">
                            <button className="btn btn-large btn-primary" onClick={handleCreateRoom}>
                                📡 Create Room
                                <span className="btn-subtitle">I'll host and share a code</span>
                            </button>
                            <div className="join-section">
                                <p style={{ marginBottom: '0.5rem', fontSize: '0.9rem' }}>Have a code? Enter it:</p>
                                <input
                                    type="text"
                                    maxLength="6"
                                    placeholder="123456"
                                    className="code-input"
                                    value={manualCode}
                                    onChange={(e) => setManualCode(e.target.value.replace(/[^0-9]/g, ''))}
                                />
                                <button
                                    className="btn btn-large btn-secondary"
                                    onClick={handleJoinRoom}
                                    disabled={manualCode.length !== 6}
                                >
                                    🔗 Join Room
                                </button>
                            </div>
                        </div>
                        {/* Hotspot Manager - only visible in Electron */}
                        <HotspotManager onHotspotCreated={(config) => setStatus(`Hotspot created: ${config.ssid}`)} />

                        <div className="info-box">
                            <p><strong>💡 Tip:</strong> Both devices can send &amp; receive files once connected!</p>
                            <p><strong>🔒 Secure:</strong> End-to-end encrypted. Files never touch a server.</p>
                            <p><strong>🆓 Free:</strong> Open source, no accounts, no limits.</p>
                        </div>
                    </div>
                ) : (
                    <>
                        <p className="subtitle">{status}</p>

                        {!isConnected && isHost && (
                            <div className="connection-container">
                                <div className="qr-section">
                                    <p>Scan QR or Share Code:</p>
                                    {qrCodeUrl && <img src={qrCodeUrl} alt="Connect via QR" className="qr-code" />}
                                    <p className="room-id">Code: <span className="code-highlight">{roomId}</span></p>
                                </div>
                            </div>
                        )}

                        {!isConnected && !isHost && (
                            <div className="connecting-animation">
                                <Wifi className="pulse" size={64} />
                                <p style={{ marginTop: '1rem' }}>Connecting to Room {roomId}...</p>
                            </div>
                        )}

                        {isConnected && (
                            <div className="transfer-container">
                                <DragDropZone
                                    onFilesSelect={handleFilesSelect}
                                    selectedFiles={selectedFiles}
                                    onRemoveFile={handleRemoveFile}
                                    onClearAll={handleClearAll}
                                />

                                {selectedFiles.length > 0 && transferProgress === 0 && (
                                    <button className="btn btn-primary btn-send" onClick={handleSend}>
                                        Send {selectedFiles.length} File{selectedFiles.length > 1 ? 's' : ''}
                                        <ArrowRight size={20} style={{ marginLeft: '8px' }} />
                                    </button>
                                )}

                                {dedup && dedup.savedPct > 0.5 && (
                                    <div className="dedup-card">
                                        <div className="dedup-headline">
                                            {fmtBytes(dedup.wire)} instead of {fmtBytes(dedup.total)}
                                        </div>
                                        <div className="dedup-detail">
                                            {dedup.savedPct.toFixed(0)}% skipped &mdash; already on the other device.
                                            Saved {fmtBytes(dedup.total - dedup.wire)}.
                                        </div>
                                    </div>
                                )}

                                {transferProgress > 0 && transferProgress < 100 && (
                                    <div className="progress-bar-container">
                                        <div className="progress-bar" style={{ width: `${transferProgress}%` }}></div>
                                        <span className="progress-text">{transferProgress}%</span>
                                    </div>
                                )}

                                {transferProgress === 100 && (
                                    <div style={{ textAlign: 'center', marginTop: '1rem' }}>
                                        <p style={{ color: '#10b981', marginBottom: '1rem', fontSize: '1.1rem' }}>
                                            ✅ Transfer Complete!
                                        </p>
                                        <button className="btn btn-primary" onClick={handleReset}>
                                            Send More Files
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="footer-status">
                            {isConnected ? <span className="status-dot online"></span> : <span className="status-dot offline"></span>}
                            {isConnected ? 'Peer Connected' : 'Waiting...'}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

export default App;
