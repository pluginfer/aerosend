/**
 * Brutal correctness suite.
 *
 * The earlier tests checked that chunk offsets were contiguous. That is NOT
 * the same as proving the file survives a round trip. If chunking or frame
 * reassembly is wrong, users get silently corrupted files - the worst possible
 * failure for a transfer tool. Everything here is byte-exact or it fails.
 */
import { buildManifest, findCutPoint, MIN_SIZE, AVG_SIZE, MAX_SIZE } from './src/utils/chunker.js';

let passed = 0, failed = 0;
const results = [];

function check(name, ok, detail = '') {
    if (ok) { passed++; results.push(`  PASS  ${name}`); }
    else { failed++; results.push(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function rnd(size, seed = 1) {
    const b = new Uint8Array(size);
    let x = seed || 1;
    for (let i = 0; i < size; i++) {
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        b[i] = x & 0xff;
    }
    return b;
}

const eq = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
};

/** Rebuild the original bytes from the manifest, exactly as a receiver would. */
async function reassemble(source, manifest) {
    const out = new Uint8Array(manifest.size);
    let pos = 0;
    for (const c of manifest.chunks) {
        const slice = new Uint8Array(await source.slice(c.offset, c.offset + c.length).arrayBuffer());
        if (slice.length !== c.length) throw new Error(`chunk length mismatch at ${c.offset}`);
        out.set(slice, pos);
        pos += slice.length;
    }
    if (pos !== manifest.size) throw new Error(`rebuilt ${pos} of ${manifest.size}`);
    return out;
}

console.log('=== 1. Byte-exact round trip across sizes ===');
const sizes = [
    0, 1, 2, 1023, 4096,
    MIN_SIZE - 1, MIN_SIZE, MIN_SIZE + 1,
    AVG_SIZE, AVG_SIZE + 12345,
    MAX_SIZE - 1, MAX_SIZE, MAX_SIZE + 1,
    5 * 1024 * 1024, 9_999_999,
];
for (const size of sizes) {
    const data = rnd(size, size + 7);
    const blob = new Blob([data]);
    const m = await buildManifest(blob);
    let ok = false, detail = '';
    try {
        const rebuilt = await reassemble(blob, m);
        ok = eq(data, rebuilt);
        if (!ok) detail = 'bytes differ';
    } catch (e) { detail = e.message; }
    check(`round trip ${String(size).padStart(9)} bytes (${m.chunks.length} chunks)`, ok, detail);
}

console.log('\n=== 2. Pathological data ===');
// All-identical bytes: the rolling hash never varies, so no natural cut point
// is ever found. Chunks must be force-cut at MAX_SIZE rather than hanging or
// producing one giant chunk.
{
    const flat = new Uint8Array(10 * 1024 * 1024).fill(0x41);
    const blob = new Blob([flat]);
    const m = await buildManifest(blob);
    const rebuilt = await reassemble(blob, m);
    check('10MB of identical bytes round trips', eq(flat, rebuilt));
    check('  forced cuts respect MAX_SIZE', m.chunks.every(c => c.length <= MAX_SIZE),
        `max chunk ${Math.max(...m.chunks.map(c => c.length))}`);
    // Identical content means identical hashes -> dedup should collapse it
    const distinct = new Set(m.chunks.map(c => c.hash));
    check('  identical chunks share one hash', distinct.size < m.chunks.length,
        `${distinct.size} distinct of ${m.chunks.length}`);
}
{
    const zeros = new Uint8Array(3 * 1024 * 1024);
    const blob = new Blob([zeros]);
    const m = await buildManifest(blob);
    check('3MB of zeros round trips', eq(zeros, await reassemble(blob, m)));
}

console.log('\n=== 3. Determinism (both peers MUST agree) ===');
{
    const data = rnd(20 * 1024 * 1024, 4242);
    const a = await buildManifest(new Blob([data]));
    const b = await buildManifest(new Blob([data]));
    check('same input yields identical chunk count', a.chunks.length === b.chunks.length);
    check('same input yields identical hashes',
        a.chunks.every((c, i) => c.hash === b.chunks[i].hash && c.offset === b.chunks[i].offset));

    // Chunking must not depend on how the data is sliced into read windows.
    const split = new Blob([data.subarray(0, 7_777_777), data.subarray(7_777_777)]);
    const c = await buildManifest(split);
    check('blob assembled from parts yields identical manifest',
        c.chunks.length === a.chunks.length && c.chunks.every((x, i) => x.hash === a.chunks[i].hash));
}

console.log('\n=== 4. Cut point bounds ===');
{
    const data = rnd(50 * 1024 * 1024, 31337);
    const m = await buildManifest(new Blob([data]));
    const lens = m.chunks.map(c => c.length);
    const last = lens[lens.length - 1];
    check('no chunk exceeds MAX_SIZE', lens.every(l => l <= MAX_SIZE));
    check('no chunk below MIN_SIZE (except the last)',
        lens.slice(0, -1).every(l => l >= MIN_SIZE), `min ${Math.min(...lens.slice(0, -1))}`);
    check('last chunk is non-empty', last > 0);
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    check('average chunk within 2x of target',
        avg > AVG_SIZE / 2 && avg < AVG_SIZE * 2, `avg ${(avg / 1024).toFixed(0)}KB`);
}

console.log('\n=== 5. Frame reassembly (the receiver hot path) ===');
{
    // Mirrors acceptFrame(): chunks arrive back-to-back with no headers and
    // are split on arbitrary frame boundaries. Off-by-one here corrupts files.
    function simulate(chunks, frameSize) {
        const needList = chunks.map(c => ({ hash: c.hash, length: c.bytes.length }));
        let acc = [], accLen = 0, idx = 0;
        const out = [];

        const stream = new Uint8Array(chunks.reduce((s, c) => s + c.bytes.length, 0));
        let o = 0;
        for (const c of chunks) { stream.set(c.bytes, o); o += c.bytes.length; }

        for (let p = 0; p < stream.length; p += frameSize) {
            acc.push(stream.subarray(p, Math.min(p + frameSize, stream.length)));
            accLen += Math.min(frameSize, stream.length - p);

            while (idx < needList.length && accLen >= needList[idx].length) {
                const want = needList[idx];
                const chunk = new Uint8Array(want.length);
                let filled = 0;
                while (filled < want.length) {
                    const head = acc[0];
                    const take = Math.min(head.byteLength, want.length - filled);
                    chunk.set(head.subarray(0, take), filled);
                    filled += take;
                    if (take === head.byteLength) acc.shift();
                    else acc[0] = head.subarray(take);
                }
                accLen -= want.length;
                idx++;
                out.push(chunk);
            }
        }
        return out;
    }

    const big = [
        { hash: 'a', bytes: rnd(1000, 1) },
        { hash: 'b', bytes: rnd(250_000, 2) },
        { hash: 'c', bytes: rnd(1, 3) },
        { hash: 'd', bytes: rnd(65_536, 4) },
        { hash: 'e', bytes: rnd(1_048_577, 5) },
    ];
    // Realistic frame sizes (SCTP negotiates 64KB-256KB).
    for (const frameSize of [1024, 65_536, 262_112, 1_000_000]) {
        const out = simulate(big, frameSize);
        const ok = out.length === big.length && out.every((c, i) => eq(c, big[i].bytes));
        check(`frames of ${String(frameSize).padStart(7)} bytes reassemble exactly`, ok);
    }

    // Degenerate frame sizes on a small payload. Kept small deliberately:
    // the accumulator uses Array.shift(), which is O(n), so a million
    // 1-byte frames is O(n^2). Real frames are 64KB+ so the accumulator
    // never holds more than a couple of entries - but the boundary maths
    // still has to be exact.
    const small = [
        { hash: 'x', bytes: rnd(300, 11) },
        { hash: 'y', bytes: rnd(1, 12) },
        { hash: 'z', bytes: rnd(2047, 13) },
    ];
    for (const frameSize of [1, 7, 13]) {
        const out = simulate(small, frameSize);
        const ok = out.length === small.length && out.every((c, i) => eq(c, small[i].bytes));
        check(`degenerate frames of ${String(frameSize).padStart(2)} bytes reassemble exactly`, ok);
    }
}

console.log('\n=== 6. Dedup arithmetic ===');
{
    const base = rnd(16 * 1024 * 1024, 8);
    const m1 = await buildManifest(new Blob([base]));
    const held = new Set(m1.chunks.map(c => c.hash));

    const m2 = await buildManifest(new Blob([base]));
    const resend = m2.chunks.filter(c => !held.has(c.hash)).reduce((s, c) => s + c.length, 0);
    check('identical file costs zero bytes', resend === 0, `${resend} bytes`);

    // A file made of two copies of the same data must dedup against itself
    const doubled = new Uint8Array(base.length * 2);
    doubled.set(base, 0); doubled.set(base, base.length);
    const m3 = await buildManifest(new Blob([doubled]));
    const distinct = new Set(m3.chunks.map(c => c.hash));
    check('self-similar file collapses internally', distinct.size < m3.chunks.length,
        `${distinct.size} distinct of ${m3.chunks.length}`);
}

console.log('\n=== 7. Memory stays flat on a large file ===');
{
    if (global.gc) global.gc();
    const before = process.memoryUsage().heapUsed;
    const big = rnd(64 * 1024 * 1024, 77);
    const blob = new Blob([big]);
    const afterAlloc = process.memoryUsage().heapUsed;
    const m = await buildManifest(blob);
    const afterChunk = process.memoryUsage().heapUsed;
    const growthMB = (afterChunk - afterAlloc) / 1024 / 1024;
    check(`chunking 64MB adds < 48MB heap (${growthMB.toFixed(0)}MB)`, growthMB < 48);
    check('  manifest covers the whole file',
        m.chunks.reduce((s, c) => s + c.length, 0) === big.length);
}

console.log('\n' + results.join('\n'));
console.log(`\n${'='.repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(56));
process.exit(failed === 0 ? 0 : 1);
