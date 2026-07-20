/**
 * Electron Preload Script
 * Exposes safe IPC APIs to renderer process
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    // Hotspot management
    createHotspot: (config) => ipcRenderer.invoke('create-hotspot', config),
    stopHotspot: () => ipcRenderer.invoke('stop-hotspot'),
    getHotspotStatus: () => ipcRenderer.invoke('get-hotspot-status'),

    // WiFi scanning
    scanWifi: () => ipcRenderer.invoke('scan-wifi'),

    // Platform info
    getPlatform: () => ipcRenderer.invoke('get-platform'),

    // Receive events from main process
    onRequestHotspotConfig: (callback) => {
        ipcRenderer.on('request-hotspot-config', callback);
    },

    // Check if running in Electron
    isElectron: true
});
