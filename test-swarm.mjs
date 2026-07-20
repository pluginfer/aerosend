/**
 * Swarm simulation.
 *
 * The claim is that sending to N devices costs the seeder ~1x the file
 * instead of Nx. That is the whole reason swarm exists, so it has to be
 * measured, not asserted.
 *
 * This runs the real SwarmScheduler against a simulated network: discrete
 * rounds, bounded per-peer upload slots, peers announcing chunks as they
 * complete them. No sockets - the scheduling decisions are what matter.
 */
import { SwarmScheduler } from './src/utils/swarm-scheduler.js';

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
    if (ok) { passed++; console.log(`  PASS  ${name}`); }
    else { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const CHUNK = 1024 * 1024; // 1MB

function makeChunks(n) {
    return Array.from({ length: n }, (_, i) => ({ hash: `c${i}`, length: CHUNK }));
}

/**
 * @param {number} nChunks     size of the file, in chunks
 * @param {number} nLeechers   devices receiving it
 * @param {boolean} swarm      false = classic one-to-many (everyone pulls from the seeder)
 * @param {number} slots       concurrent uploads a single peer will serve
 */
function simulate({ nChunks, nLeechers, swarm = true, slots = 4, maxRounds = 100000 }) {
    const chunks = makeChunks(nChunks);
    const allHashes = chunks.map(c => c.hash);

    const seeder = { id: 'seed', have: new Set(allHashes), uploaded: 0 };
    const peers = Array.from({ length: nLeechers }, (_, i) => {
        const id = `p${i}`;
        const sch = new SwarmScheduler(chunks, new Set());
        sch.announce('seed', allHashes, true);
        return { id, sch, uploaded: 0, done: false };
    });

    // In swarm mode every peer can see every other peer.
    if (swarm) {
        for (const p of peers) {
            for (const q of peers) if (p !== q) p.sch.announce(q.id, []);
        }
    }

    let round = 0;
    for (; round < maxRounds; round++) {
        if (peers.every(p => p.sch.complete)) break;

        // Upload slots reset each round; this is the bandwidth constraint.
        const budget = new Map([['seed', slots]]);
        for (const p of peers) budget.set(p.id, slots);

        const delivered = [];

        for (const p of peers) {
            if (p.sch.complete) continue;
            const wanted = p.sch.schedule(slots, slots * 2);
            for (const { peerId, hash } of wanted) {
                const left = budget.get(peerId) ?? 0;
                if (left <= 0) continue;
                budget.set(peerId, left - 1);

                // Charge the upload to whoever served it
                if (peerId === 'seed') seeder.uploaded += CHUNK;
                else {
                    const src = peers.find(x => x.id === peerId);
                    if (src) src.uploaded += CHUNK;
                }
                delivered.push({ peer: p, hash });
            }
        }

        if (delivered.length === 0) break; // deadlock guard

        // Apply deliveries, then let everyone announce what they gained.
        for (const { peer, hash } of delivered) peer.sch.markComplete(hash);
        if (swarm) {
            for (const { peer, hash } of delivered) {
                for (const other of peers) {
                    if (other !== peer) other.sch.peerGained(peer.id, hash);
                }
            }
        }
    }

    const fileBytes = nChunks * CHUNK;
    return {
        rounds: round,
        allComplete: peers.every(p => p.sch.complete),
        seederUploadedX: seeder.uploaded / fileBytes,
        peerUploaded: peers.reduce((s, p) => s + p.uploaded, 0) / fileBytes,
        fileMB: fileBytes / 1024 / 1024,
    };
}

console.log('=== 1. Correctness: every peer receives the whole file ===');
for (const n of [1, 2, 5, 30]) {
    const r = simulate({ nChunks: 40, nLeechers: n });
    check(`${String(n).padStart(2)} peers all complete`, r.allComplete);
}

console.log('\n=== 2. The claim: seeder upload stays ~1x regardless of peers ===');
const table = [];
for (const n of [1, 5, 10, 30, 50]) {
    const sw = simulate({ nChunks: 40, nLeechers: n });
    const cl = simulate({ nChunks: 40, nLeechers: n, swarm: false });
    table.push({ n, sw, cl });
    console.log(
        `  ${String(n).padStart(3)} devices │ ` +
        `classic ${cl.seederUploadedX.toFixed(1).padStart(5)}x  (${cl.rounds.toString().padStart(4)} rounds) │ ` +
        `swarm ${sw.seederUploadedX.toFixed(2).padStart(5)}x  (${sw.rounds.toString().padStart(3)} rounds)`
    );
}

const at30 = table.find(t => t.n === 30);
check('seeder uploads < 2x the file for 30 devices',
    at30.sw.seederUploadedX < 2, `${at30.sw.seederUploadedX.toFixed(2)}x`);
check('classic mode really does cost ~30x',
    at30.cl.seederUploadedX > 25, `${at30.cl.seederUploadedX.toFixed(1)}x`);
check('swarm finishes far sooner than classic',
    at30.sw.rounds * 4 < at30.cl.rounds, `${at30.sw.rounds} vs ${at30.cl.rounds} rounds`);
check('seeder cost is flat as devices scale',
    Math.abs(table.at(-1).sw.seederUploadedX - table[0].sw.seederUploadedX) < 1.5,
    `1 peer ${table[0].sw.seederUploadedX.toFixed(2)}x vs 50 peers ${table.at(-1).sw.seederUploadedX.toFixed(2)}x`);

console.log('\n=== 3. Rarest-first actually prefers rare chunks ===');
{
    const chunks = makeChunks(10);
    const s = new SwarmScheduler(chunks, new Set());
    // Everyone has c0..c8; only one peer has c9
    s.announce('a', chunks.slice(0, 9).map(c => c.hash));
    s.announce('b', chunks.slice(0, 9).map(c => c.hash));
    s.announce('c', ['c9']);
    const first = s.schedule(4, 1)[0];
    check('rarest chunk is requested first', first?.hash === 'c9', `got ${first?.hash}`);
}

console.log('\n=== 4. Resilience ===');
{
    const chunks = makeChunks(20);
    const s = new SwarmScheduler(chunks, new Set());
    s.announce('a', chunks.map(c => c.hash));
    const a = s.schedule(4, 4);
    check('schedules from the only available peer', a.length > 0);

    s.dropPeer('a');
    check('nothing scheduled once every peer vanishes', s.schedule(4, 4).length === 0);

    s.announce('b', chunks.map(c => c.hash));
    check('recovers when a new peer appears', s.schedule(4, 4).length > 0);

    // A peer that fails us should not be retried for that chunk
    const s2 = new SwarmScheduler(chunks, new Set());
    s2.announce('x', ['c0']);
    const pick = s2.schedule(4, 1)[0];
    s2.markInflight(pick.peerId, pick.hash);
    s2.markFailed('x', 'c0');
    check('failed peer is not retried for the same chunk',
        !s2.schedule(4, 4).some(a => a.peerId === 'x' && a.hash === 'c0'));
}

console.log('\n=== 5. No duplicate work in the normal case ===');
{
    const chunks = makeChunks(40);
    const s = new SwarmScheduler(chunks, new Set());
    s.announce('a', chunks.map(c => c.hash));
    s.announce('b', chunks.map(c => c.hash));
    const picks = s.schedule(8, 16);
    const hashes = picks.map(p => p.hash);
    check('same chunk not requested twice while plenty remain',
        new Set(hashes).size === hashes.length);
    check('load spread across peers', new Set(picks.map(p => p.peerId)).size > 1);
}

console.log('\n' + '='.repeat(56));
console.log(`  ${passed} passed, ${failed} failed`);
console.log('='.repeat(56));
process.exit(failed === 0 ? 0 : 1);
