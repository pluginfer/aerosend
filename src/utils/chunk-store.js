/**
 * Content-addressed chunk store (IndexedDB).
 *
 * Every chunk is keyed by the SHA-256 of its bytes, so identity is intrinsic:
 * if two devices hold the same bytes they compute the same key without ever
 * talking to each other. That is what lets a receiver say "I already have
 * these 9GB, only send me the other 1GB".
 *
 * This is the difference between moving a file and reconciling state.
 */

const DB_NAME = 'aerosend-chunks';
const DB_VERSION = 1;
const STORE = 'chunks';
const META = 'meta';

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE); // key = chunk hash
            }
            if (!db.objectStoreNames.contains(META)) {
                db.createObjectStore(META);   // key = hash -> {size, lastSeen}
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

function tx(db, stores, mode) {
    return db.transaction(stores, mode);
}

export class ChunkStore {
    /** Which of these hashes do we already hold? Returns a Set. */
    async have(hashes) {
        const db = await openDB();
        const held = new Set();
        await new Promise((resolve, reject) => {
            const t = tx(db, [META], 'readonly');
            const store = t.objectStore(META);
            let pending = hashes.length;
            if (pending === 0) return resolve();
            for (const h of hashes) {
                const r = store.getKey(h);
                r.onsuccess = () => {
                    if (r.result !== undefined) held.add(h);
                    if (--pending === 0) resolve();
                };
                r.onerror = () => { if (--pending === 0) resolve(); };
            }
            t.onerror = () => reject(t.error);
        });
        return held;
    }

    async get(hash) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const r = tx(db, [STORE], 'readonly').objectStore(STORE).get(hash);
            r.onsuccess = () => resolve(r.result ?? null);
            r.onerror = () => reject(r.error);
        });
    }

    /** Store a chunk. `bytes` should be an ArrayBuffer or Uint8Array. */
    async put(hash, bytes) {
        const db = await openDB();
        const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        return new Promise((resolve, reject) => {
            const t = tx(db, [STORE, META], 'readwrite');
            t.objectStore(STORE).put(buf, hash);
            t.objectStore(META).put({ size: buf.byteLength, lastSeen: Date.now() }, hash);
            t.oncomplete = () => resolve();
            t.onerror = () => reject(t.error);
        });
    }

    /** Total bytes currently cached. */
    async size() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            let total = 0;
            const cursor = tx(db, [META], 'readonly').objectStore(META).openCursor();
            cursor.onsuccess = () => {
                const c = cursor.result;
                if (!c) return resolve(total);
                total += c.value?.size ?? 0;
                c.continue();
            };
            cursor.onerror = () => reject(cursor.error);
        });
    }

    /**
     * Evict least-recently-seen chunks until the cache fits `budgetBytes`.
     * The cache is an optimisation, never a source of truth, so dropping
     * chunks only costs bandwidth on a future transfer.
     */
    async prune(budgetBytes = 2 * 1024 ** 3) {
        const current = await this.size();
        if (current <= budgetBytes) return 0;

        const db = await openDB();
        const entries = await new Promise((resolve, reject) => {
            const out = [];
            const cursor = tx(db, [META], 'readonly').objectStore(META).openCursor();
            cursor.onsuccess = () => {
                const c = cursor.result;
                if (!c) return resolve(out);
                out.push({ hash: c.key, ...c.value });
                c.continue();
            };
            cursor.onerror = () => reject(cursor.error);
        });

        entries.sort((a, b) => (a.lastSeen ?? 0) - (b.lastSeen ?? 0));

        let freed = 0;
        const doomed = [];
        for (const e of entries) {
            if (current - freed <= budgetBytes) break;
            doomed.push(e.hash);
            freed += e.size ?? 0;
        }

        await new Promise((resolve, reject) => {
            const t = tx(db, [STORE, META], 'readwrite');
            for (const h of doomed) {
                t.objectStore(STORE).delete(h);
                t.objectStore(META).delete(h);
            }
            t.oncomplete = () => resolve();
            t.onerror = () => reject(t.error);
        });

        console.log(`🧹 Pruned ${doomed.length} chunks, freed ${(freed / 1024 ** 2).toFixed(0)}MB`);
        return freed;
    }

    async clear() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const t = tx(db, [STORE, META], 'readwrite');
            t.objectStore(STORE).clear();
            t.objectStore(META).clear();
            t.oncomplete = () => resolve();
            t.onerror = () => reject(t.error);
        });
    }
}

export const chunkStore = new ChunkStore();
