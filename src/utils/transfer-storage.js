/**
 * Transfer storage using IndexedDB
 * Enables persistent transfer resume even after app restart
 */

const DB_NAME = 'AeroSendDB';
const DB_VERSION = 1;
const STORE_NAME = 'transfers';

class TransferStorageManager {
    constructor() {
        this.db = null;
    }

    /**
     * Initialize IndexedDB
     */
    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const objectStore = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    objectStore.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };
        });
    }

    /**
     * Save transfer checkpoint
     */
    async saveCheckpoint(transferId, state) {
        if (!this.db) await this.init();

        const checkpoint = {
            id: transferId,
            fileName: state.fileName,
            fileSize: state.fileSize,
            completedChunks: Array.from(state.completedChunks || []),
            totalChunks: state.totalChunks,
            timestamp: Date.now(),
            peerInfo: state.peerInfo || {}
        };

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(checkpoint);

            request.onsuccess = () => resolve(checkpoint);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Load transfer checkpoint
     */
    async loadCheckpoint(transferId) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(transferId);

            request.onsuccess = () => {
                const checkpoint = request.result;
                if (checkpoint) {
                    checkpoint.completedChunks = new Set(checkpoint.completedChunks);
                }
                resolve(checkpoint);
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get all incomplete transfers
     */
    async getIncompleteTransfers() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();

            request.onsuccess = () => {
                const transfers = request.result
                    .filter(t => t.completedChunks.length < t.totalChunks)
                    .map(t => ({
                        ...t,
                        completedChunks: new Set(t.completedChunks),
                        progress: (t.completedChunks.length / t.totalChunks * 100).toFixed(1)
                    }));
                resolve(transfers);
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Delete transfer checkpoint
     */
    async deleteCheckpoint(transferId) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.delete(transferId);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Clean up old transfers (older than 24 hours)
     */
    async cleanupOldTransfers() {
        if (!this.db) await this.init();

        const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const index = store.index('timestamp');
            const request = index.openCursor();

            let deletedCount = 0;
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    if (cursor.value.timestamp < cutoffTime) {
                        cursor.delete();
                        deletedCount++;
                    }
                    cursor.continue();
                } else {
                    resolve(deletedCount);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }
}

// Singleton instance
export const transferStorage = new TransferStorageManager();
