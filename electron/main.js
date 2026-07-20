/**
 * Electron Main Process
 * Handles WiFi hotspot creation and native OS integration
 */

const { app, BrowserWindow, ipcMain, Tray, Menu } = require('electron');
const path = require('path');
const wifi = require('node-wifi');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

let mainWindow;
let tray;
let isHotspotActive = false;

// Initialize WiFi module
wifi.init({
    iface: null // network interface, choose a random wifi interface if set to null
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        },
        icon: path.join(__dirname, 'icon.png'),
        title: 'AeroSend'
    });

    // In development, load from Vite dev server
    if (process.env.NODE_ENV === 'development') {
        mainWindow.loadURL('http://localhost:3000');
        mainWindow.webContents.openDevTools();
    } else {
        // In production, load built files
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    // Create system tray
    createTray();

    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
}

function createTray() {
    tray = new Tray(path.join(__dirname, 'tray-icon.png'));

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Open AeroSend',
            click: () => mainWindow.show()
        },
        {
            label: 'WiFi Hotspot',
            type: 'checkbox',
            checked: isHotspotActive,
            click: toggleHotspot
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                app.isQuitting = true;
                app.quit();
            }
        }
    ]);

    tray.setToolTip('AeroSend - File Transfer');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
        mainWindow.show();
    });
}

/**
 * Create WiFi Hotspot (Windows)
 */
async function createHotspot(ssid, password) {
    try {
        if (process.platform === 'win32') {
            // Windows: Use netsh commands
            const commands = [
                `netsh wlan set hostednetwork mode=allow ssid="${ssid}" key="${password}"`,
                `netsh wlan start hostednetwork`
            ];

            for (const cmd of commands) {
                const { stdout, stderr } = await execPromise(cmd);
                console.log('Hotspot command output:', stdout);
                if (stderr) console.error('Error:', stderr);
            }

            isHotspotActive = true;
            updateTrayMenu();
            return { success: true, ssid, password };

        } else if (process.platform === 'darwin') {
            // macOS: Internet Sharing (requires admin)
            // This is more complex and might need AppleScript
            return {
                success: false,
                error: 'macOS hotspot requires manual setup in System Preferences'
            };

        } else if (process.platform === 'linux') {
            // Linux: Use nmcli (NetworkManager)
            const cmd = `nmcli dev wifi hotspot ssid "${ssid}" password "${password}"`;
            const { stdout } = await execPromise(cmd);
            isHotspotActive = true;
            updateTrayMenu();
            return { success: true, ssid, password };
        }

    } catch (error) {
        console.error('Error creating hotspot:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Stop WiFi Hotspot
 */
async function stopHotspot() {
    try {
        if (process.platform === 'win32') {
            await execPromise('netsh wlan stop hostednetwork');
            isHotspotActive = false;
            updateTrayMenu();
            return { success: true };

        } else if (process.platform === 'linux') {
            await execPromise('nmcli connection down Hotspot');
            isHotspotActive = false;
            updateTrayMenu();
            return { success: true };
        }

    } catch (error) {
        console.error('Error stopping hotspot:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Get hotspot status
 */
async function getHotspotStatus() {
    try {
        if (process.platform === 'win32') {
            const { stdout } = await execPromise('netsh wlan show hostednetwork');
            const isRunning = stdout.includes('Status') && stdout.includes('Started');
            return { active: isRunning, details: stdout };
        }
        return { active: isHotspotActive };
    } catch (error) {
        return { active: false, error: error.message };
    }
}

function toggleHotspot() {
    if (isHotspotActive) {
        stopHotspot();
    } else {
        // Send request to renderer to get SSID/password
        mainWindow.webContents.send('request-hotspot-config');
    }
}

function updateTrayMenu() {
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Open AeroSend', click: () => mainWindow.show() },
        {
            label: 'WiFi Hotspot',
            type: 'checkbox',
            checked: isHotspotActive,
            click: toggleHotspot
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                app.isQuitting = true;
                app.quit();
            }
        }
    ]);
    tray.setContextMenu(contextMenu);
}

// IPC Handlers
ipcMain.handle('create-hotspot', async (event, { ssid, password }) => {
    return await createHotspot(ssid, password);
});

ipcMain.handle('stop-hotspot', async () => {
    return await stopHotspot();
});

ipcMain.handle('get-hotspot-status', async () => {
    return await getHotspotStatus();
});

ipcMain.handle('scan-wifi', async () => {
    try {
        const networks = await wifi.scan();
        return { success: true, networks };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-platform', () => {
    return process.platform;
});

// App lifecycle
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.on('before-quit', async () => {
    // Clean up hotspot if active
    if (isHotspotActive) {
        await stopHotspot();
    }
});

// Handle cleanup on exit
process.on('SIGINT', async () => {
    if (isHotspotActive) {
        await stopHotspot();
    }
    app.quit();
});
