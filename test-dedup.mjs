/**
 * Benchmarks what dedup actually saves on realistic scenarios.
 *
 * Pure logic - no IndexedDB, no network. It compares the bytes a naive
 * transfer sends against the bytes AeroSend would send once the receiver
 * advertises the chunks it already holds.
 *
 * These numbers are the claim. If they are unimpressive, the claim dies.
 */
import { buildManifest } from './src/utils/chunker.js';

const MB = 1024 * 1024;

function rnd(size, seed = 1) {
    const b = new Uint8Array(size);
    let x = seed;
    for (let i = 0; i < size; i++) {
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        b[i] = x & 0xff;
    }
    return b;
}

const concat = (...parts) => {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
};

/** Bytes that would cross the wire given what the receiver already holds. */
async function transferCost(bytes, heldHashes) {
    const m = await buildManifest(new Blob([bytes]));
    let send = 0, reuse = 0;
    for (const c of m.chunks) {
        if (heldHashes.has(c.hash)) reuse += c.length;
        else send += c.length;
    }
    return { manifest: m, send, reuse, total: bytes.length };
}

const row = (name, r) => {
    const pct = (r.reuse / r.total) * 100;
    const saved = (r.total - r.send) / MB;
    console.log(
        `  ${name.padEnd(34)} ` +
        `${(r.total / MB).toFixed(0).padStart(5)}MB → ` +
        `${(r.send / MB).toFixed(1).padStart(6)}MB sent  ` +
        `(${pct.toFixed(1).padStart(5)}% reused, ${saved.toFixed(1)}MB saved)`
    );
};

console.log('Building fixtures...\n');

// A 40MB "video" and a 24MB "dataset"
const video = rnd(40 * MB, 11);
const dataset = rnd(24 * MB, 22);

console.log('=== Scenario 1: send the same file twice ===');
console.log('  (you re-send a video to the same laptop)');
const first = await transferCost(video, new Set());
row('first send (cold)', first);
const held1 = new Set(first.manifest.chunks.map(c => c.hash));
row('second send (warm cache)', await transferCost(video, held1));

console.log('\n=== Scenario 2: metadata edit at the head of a video ===');
console.log('  (re-tagged the file, bytes at the start changed)');
const retagged = concat(rnd(4096, 999), video.subarray(4096));
row('after re-tag', await transferCost(retagged, held1));

console.log('\n=== Scenario 3: append 8MB to a log/dataset ===');
const dsFirst = await transferCost(dataset, new Set());
const heldDs = new Set(dsFirst.manifest.chunks.map(c => c.hash));
row('after appending 8MB', await transferCost(concat(dataset, rnd(8 * MB, 33)), heldDs));

console.log('\n=== Scenario 4: folder of 8 files, 1 changed ===');
console.log('  (the classic "send me that project folder again")');
const files = Array.from({ length: 8 }, (_, i) => rnd(8 * MB, 100 + i));
const folderV1 = concat(...files);
const fv1 = await transferCost(folderV1, new Set());
const heldFolder = new Set(fv1.manifest.chunks.map(c => c.hash));

const filesV2 = [...files];
filesV2[3] = rnd(8 * MB, 777); // one file rewritten
row('resend folder (1 of 8 changed)', await transferCost(concat(...filesV2), heldFolder));

console.log('\n=== Scenario 5: two similar model files ===');
console.log('  (a fine-tune sharing most blocks with its base - Pluginfer case)');
const base = rnd(32 * MB, 55);
const bm = await transferCost(base, new Set());
const heldBase = new Set(bm.manifest.chunks.map(c => c.hash));
// fine-tune: first 75% identical, last 25% differs
const finetune = concat(base.subarray(0, 24 * MB), rnd(8 * MB, 66));
row('fine-tune vs cached base', await transferCost(finetune, heldBase));

console.log('\nNote: fixtures are incompressible random data - the worst case for');
console.log('any compression-based approach. These savings come purely from');
console.log('content addressing, not from squeezing bytes.');
