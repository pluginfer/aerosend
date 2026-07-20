/**
 * Validates the content-defined chunker.
 *
 * Two things must hold or the dedup claim is worthless:
 *   1. Chunks reconstruct the file exactly (contiguous, no gaps/overlap).
 *   2. Inserting bytes near the START must not invalidate every later chunk -
 *      that is the whole point of content-defined vs fixed-size chunking.
 */
import { buildManifest, MIN_SIZE, AVG_SIZE, MAX_SIZE } from './src/utils/chunker.js';

// Deterministic pseudo-random data (compressible-ish, realistic)
function makeData(size, seed = 1) {
    const buf = new Uint8Array(size);
    let x = seed;
    for (let i = 0; i < size; i++) {
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        buf[i] = x & 0xff;
    }
    return buf;
}

const MB = 1024 * 1024;
const SIZE = 64 * MB;

console.log(`Building ${SIZE / MB}MB test file...`);
const original = makeData(SIZE);

const t0 = Date.now();
const m1 = await buildManifest(new Blob([original]));
const elapsed = (Date.now() - t0) / 1000;

// --- Test 1: exact reconstruction -----------------------------------------
let pos = 0, contiguous = true;
for (const c of m1.chunks) {
    if (c.offset !== pos) { contiguous = false; break; }
    pos += c.length;
}
const sizes = m1.chunks.map(c => c.length);
const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;

console.log('\n=== Test 1: reconstruction ===');
console.log(`  chunks          : ${m1.chunks.length}`);
console.log(`  contiguous      : ${contiguous ? 'PASS' : 'FAIL'}`);
console.log(`  covers all bytes: ${pos === SIZE ? 'PASS' : `FAIL (${pos} vs ${SIZE})`}`);
console.log(`  avg chunk       : ${(avg / 1024).toFixed(0)}KB (target ${AVG_SIZE / 1024}KB)`);
console.log(`  min/max         : ${(Math.min(...sizes) / 1024).toFixed(0)}KB / ${(Math.max(...sizes) / 1024).toFixed(0)}KB`);
console.log(`  within bounds   : ${sizes.every(s => s >= MIN_SIZE || s === sizes.at(-1)) && sizes.every(s => s <= MAX_SIZE) ? 'PASS' : 'FAIL'}`);
console.log(`  throughput      : ${(SIZE / MB / elapsed).toFixed(0)} MB/s`);

// --- Test 2: the dedup property -------------------------------------------
// Insert 1KB at offset 1MB. With FIXED chunking every later chunk shifts and
// nothing matches. With CDC only the chunks around the edit should change.
const inserted = new Uint8Array(SIZE + 1024);
inserted.set(original.subarray(0, MB), 0);
inserted.set(makeData(1024, 99), MB);
inserted.set(original.subarray(MB), MB + 1024);

const m2 = await buildManifest(new Blob([inserted]));

const set1 = new Set(m1.chunks.map(c => c.hash));
const shared = m2.chunks.filter(c => set1.has(c.hash));
const sharedBytes = shared.reduce((s, c) => s + c.length, 0);
const reusePct = (sharedBytes / inserted.length) * 100;

console.log('\n=== Test 2: dedup after 1KB insert at 1MB offset ===');
console.log(`  chunks before   : ${m1.chunks.length}`);
console.log(`  chunks after    : ${m2.chunks.length}`);
console.log(`  chunks reused   : ${shared.length}`);
console.log(`  bytes reused    : ${reusePct.toFixed(1)}%`);
console.log(`  would transfer  : ${((100 - reusePct) / 100 * inserted.length / MB).toFixed(1)}MB of ${(inserted.length / MB).toFixed(0)}MB`);
console.log(`  VERDICT         : ${reusePct > 90 ? 'PASS - CDC working' : 'FAIL - behaving like fixed chunking'}`);

// --- Test 3: appending should reuse everything before the append -----------
const appended = new Uint8Array(SIZE + 5 * MB);
appended.set(original, 0);
appended.set(makeData(5 * MB, 7), SIZE);
const m3 = await buildManifest(new Blob([appended]));
const shared3 = m3.chunks.filter(c => set1.has(c.hash));
const reuse3 = (shared3.reduce((s, c) => s + c.length, 0) / appended.length) * 100;

console.log('\n=== Test 3: append 5MB to end ===');
console.log(`  bytes reused    : ${reuse3.toFixed(1)}%`);
console.log(`  VERDICT         : ${reuse3 > 90 ? 'PASS' : 'FAIL'}`);
