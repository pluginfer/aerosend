/**
 * FastCDC - content-defined chunking.
 *
 * Why not just slice every 1MB?
 * Because fixed offsets are useless for dedup. Insert one byte at the start of
 * a file and every fixed-size chunk after it shifts, so nothing matches and you
 * resend the whole file. Content-defined chunking picks boundaries from the
 * *data* using a rolling hash, so an edit only disturbs the chunks around it.
 * That is the trick behind rsync and Syncthing - and what lets us send less
 * than the file.
 *
 * FastCDC (Xia et al., USENIX ATC '16) over classic Rabin:
 *   - gear hash: one shift + one table lookup per byte
 *   - normalized chunking: two masks, so sizes cluster near the target
 *     instead of following a long-tailed exponential distribution
 *
 * The gear table MUST be identical on both peers or no chunk will ever match,
 * so it is derived deterministically from a fixed seed rather than random.
 */

import { sha256Hex } from './sha256.js';

const SEED = 0x9e3779b9; // golden-ratio constant, arbitrary but fixed forever

/** xorshift32 - deterministic, identical in every JS engine. */
function buildGearTable() {
    const table = new Uint32Array(256);
    let x = SEED;
    for (let i = 0; i < 256; i++) {
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        table[i] = x;
    }
    return table;
}

const GEAR = buildGearTable();

// Tuned for multi-GB transfers: ~1MB average keeps the manifest small
// (10GB -> ~10k chunks) while staying fine-grained enough for useful dedup.
export const MIN_SIZE = 256 * 1024;
export const AVG_SIZE = 1024 * 1024;
export const MAX_SIZE = 4 * 1024 * 1024;

// Normalized chunking: demand more bits before the average (hard to cut early),
// fewer after it (easy to cut late). Pulls sizes toward AVG_SIZE.
//
// The bit count IS the expected chunk size: a mask of N bits fires with
// probability 2^-N, so cuts land about 2^N bytes apart. These must be derived
// from AVG_SIZE, not hand-picked - an earlier version used 8-bit masks, which
// cut every ~256 bytes and silently degenerated into fixed-size chunking.
const AVG_BITS = Math.round(Math.log2(AVG_SIZE));   // 20 for 1MB
const MASK_S = (1 << (AVG_BITS + 2)) - 1;           // strict  - below AVG_SIZE
const MASK_L = (1 << (AVG_BITS - 2)) - 1;           // lenient - above AVG_SIZE

/**
 * Find the cut point within `buf`, scanning from `start`.
 * Returns the length of the chunk beginning at `start`.
 */
export function findCutPoint(buf, start = 0, end = buf.length) {
    const remaining = end - start;
    if (remaining <= MIN_SIZE) return remaining;

    const limit = Math.min(remaining, MAX_SIZE);
    const normal = Math.min(limit, AVG_SIZE);

    let fp = 0;
    let i = MIN_SIZE; // never cut before the minimum

    // Phase 1: strict mask until the average size
    for (; i < normal; i++) {
        fp = ((fp << 1) >>> 0) + GEAR[buf[start + i]];
        fp >>>= 0;
        if ((fp & MASK_S) === 0) return i;
    }

    // Phase 2: lenient mask up to the maximum
    for (; i < limit; i++) {
        fp = ((fp << 1) >>> 0) + GEAR[buf[start + i]];
        fp >>>= 0;
        if ((fp & MASK_L) === 0) return i;
    }

    return limit; // forced cut at MAX_SIZE
}

/**
 * SHA-256 content address for a chunk, as lowercase hex.
 * This is the chunk's identity: same bytes anywhere -> same address, so two
 * devices can compare what they hold without exchanging any data.
 */
export async function hashChunk(bytes) {
    // crypto.subtle only exists in a secure context, so a phone on
    // http://192.168.1.x has none. Both peers must derive identical addresses
    // or nothing ever dedups, so the fallback is real SHA-256 in JS rather
    // than a different (faster) hash.
    if (typeof crypto !== 'undefined' && crypto.subtle) {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const view = new Uint8Array(digest);
        let hex = '';
        for (let i = 0; i < view.length; i++) {
            hex += view[i].toString(16).padStart(2, '0');
        }
        return hex;
    }
    return sha256Hex(bytes);
}

/**
 * Chunk a File/Blob into a content-addressed manifest.
 *
 * Reads in windows rather than loading the file, so memory stays flat
 * regardless of file size. `onProgress` reports 0..1.
 */
export async function buildManifest(file, onProgress = () => { }) {
    const WINDOW = 16 * 1024 * 1024; // read 16MB at a time
    const chunks = [];

    let filePos = 0;      // absolute offset of the next chunk
    let carry = new Uint8Array(0); // bytes left over from the previous window

    while (filePos + carry.length < file.size) {
        const readFrom = filePos + carry.length;
        const slice = file.slice(readFrom, readFrom + WINDOW);
        const fresh = new Uint8Array(await slice.arrayBuffer());

        // Join leftovers with the new window
        let buf;
        if (carry.length === 0) {
            buf = fresh;
        } else {
            buf = new Uint8Array(carry.length + fresh.length);
            buf.set(carry, 0);
            buf.set(fresh, carry.length);
        }

        const isFinalWindow = readFrom + fresh.length >= file.size;
        let pos = 0;

        while (pos < buf.length) {
            const available = buf.length - pos;

            // Unless this is the last window, keep a full MAX_SIZE tail so a
            // cut point is never missed across the boundary.
            if (!isFinalWindow && available < MAX_SIZE) break;

            const len = findCutPoint(buf, pos, buf.length);
            const bytes = buf.subarray(pos, pos + len);
            chunks.push({
                hash: await hashChunk(bytes),
                offset: filePos,
                length: len,
            });
            filePos += len;
            pos += len;
        }

        carry = buf.subarray(pos);
        onProgress(Math.min(filePos / file.size, 1));
    }

    // Whatever is left is the final chunk
    if (carry.length > 0) {
        chunks.push({
            hash: await hashChunk(carry),
            offset: filePos,
            length: carry.length,
        });
    }

    onProgress(1);
    return {
        name: file.name,
        size: file.size,
        mime: file.type,
        chunks,
    };
}

/** Total bytes covered by a set of chunk hashes. */
export function bytesFor(manifest, hashes) {
    const want = hashes instanceof Set ? hashes : new Set(hashes);
    return manifest.chunks
        .filter(c => want.has(c.hash))
        .reduce((sum, c) => sum + c.length, 0);
}
