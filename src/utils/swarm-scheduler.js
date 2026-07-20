/**
 * Swarm chunk scheduler.
 *
 * The problem: sending a 5GB file to 30 devices currently costs the sender
 * 150GB of upload, and takes 30x as long. Every tool in this space works that
 * way - one sender, N independent transfers.
 *
 * The fix is BitTorrent's insight applied to a LAN: receivers serve each other.
 * Once a device holds a chunk it can pass it on, so the seeder uploads each
 * chunk roughly once no matter how many devices are waiting.
 *
 * This class is pure decision logic - no network, no sockets - so the
 * behaviour that makes or breaks the claim can be tested directly.
 */

export class SwarmScheduler {
    /**
     * @param {Array<{hash:string,length:number}>} chunks  manifest chunks
     * @param {Set<string>} have  chunk hashes this peer already holds
     */
    constructor(chunks, have = new Set()) {
        this.chunks = chunks;
        this.have = new Set(have);
        this.peerHave = new Map();   // peerId -> Set<hash>
        this.inflight = new Map();   // hash -> Set<peerId>
        this.failed = new Map();     // hash -> Set<peerId> that failed us
        this.seeds = new Set();      // peers holding the complete file

        this.needed = new Set();
        for (const c of chunks) {
            if (!this.have.has(c.hash)) this.needed.add(c.hash);
        }
    }

    get complete() { return this.needed.size === 0; }

    /** Fraction of the file this peer holds, 0..1 */
    get progress() {
        const total = this.chunks.length;
        return total === 0 ? 1 : (total - this.needed.size) / total;
    }

    /**
     * @param {boolean} isSeed  true for the origin peer. Seeds are used only
     *   when no leecher can serve a chunk - otherwise every peer piles onto
     *   the seeder early on and its upload cost scales with swarm size, which
     *   is exactly what swarm exists to prevent.
     */
    announce(peerId, hashes, isSeed = false) {
        this.peerHave.set(peerId, new Set(hashes));
        if (isSeed) this.seeds.add(peerId);
        else this.seeds.delete(peerId);
    }

    /** A peer told us it just finished a chunk. */
    peerGained(peerId, hash) {
        let set = this.peerHave.get(peerId);
        if (!set) { set = new Set(); this.peerHave.set(peerId, set); }
        set.add(hash);
    }

    dropPeer(peerId) {
        this.peerHave.delete(peerId);
        for (const [hash, peers] of this.inflight) {
            peers.delete(peerId);
            if (peers.size === 0) this.inflight.delete(hash);
        }
    }

    markInflight(peerId, hash) {
        let peers = this.inflight.get(hash);
        if (!peers) { peers = new Set(); this.inflight.set(hash, peers); }
        peers.add(peerId);
    }

    /** We received and verified a chunk. */
    markComplete(hash) {
        this.have.add(hash);
        this.needed.delete(hash);
        this.inflight.delete(hash);
    }

    markFailed(peerId, hash) {
        const peers = this.inflight.get(hash);
        if (peers) {
            peers.delete(peerId);
            if (peers.size === 0) this.inflight.delete(hash);
        }
        let f = this.failed.get(hash);
        if (!f) { f = new Set(); this.failed.set(hash, f); }
        f.add(peerId);
    }

    /** How many peers (that we can see) hold this chunk. */
    availability(hash) {
        let n = 0;
        for (const set of this.peerHave.values()) if (set.has(hash)) n++;
        return n;
    }

    /**
     * Decide what to fetch next.
     *
     * Rarest-first: the chunk held by fewest peers is requested first. Without
     * it, everyone grabs the same easy chunks, rare ones become bottlenecks,
     * and the swarm stalls waiting on the seeder - collapsing back to the
     * one-to-many behaviour we are trying to escape.
     *
     * @param {number} maxPerPeer   concurrent requests allowed per peer
     * @param {number} maxTotal     concurrent requests overall
     * @param {boolean} endgame     near the end, ask several peers for the same
     *                              chunk so one slow peer cannot hold up the file
     * @returns {Array<{peerId:string, hash:string}>}
     */
    schedule(maxPerPeer = 4, maxTotal = 16, endgame = null) {
        const assignments = [];
        const load = new Map();
        for (const peerId of this.peerHave.keys()) load.set(peerId, 0);
        for (const peers of this.inflight.values()) {
            for (const p of peers) load.set(p, (load.get(p) ?? 0) + 1);
        }

        let outstanding = 0;
        for (const peers of this.inflight.values()) outstanding += peers.size;

        // Endgame: once very little is left, duplicate requests. Costs a few
        // redundant bytes, avoids the classic "99% then stuck" tail.
        const inEndgame = endgame ?? (this.needed.size > 0 && this.needed.size <= 4);

        const candidates = [...this.needed]
            .filter(h => inEndgame || !this.inflight.has(h))
            .map(h => ({ hash: h, avail: this.availability(h) }))
            .filter(c => c.avail > 0)
            .sort((a, b) => a.avail - b.avail);   // rarest first

        for (const { hash } of candidates) {
            if (outstanding + assignments.length >= maxTotal) break;

            // Pick the least-loaded peer holding it, but treat seeds as a last
            // resort: a leecher serving costs the swarm nothing extra, while
            // every seed upload is bandwidth the origin device has to pay for.
            let best = null, bestLoad = Infinity, bestIsSeed = true;
            for (const [peerId, set] of this.peerHave) {
                if (!set.has(hash)) continue;
                if (this.failed.get(hash)?.has(peerId)) continue;
                if (this.inflight.get(hash)?.has(peerId)) continue;
                const l = load.get(peerId) ?? 0;
                if (l >= maxPerPeer) continue;

                const isSeed = this.seeds.has(peerId);
                // A leecher always beats a seed; among equals, take the idler.
                const better = (bestIsSeed && !isSeed) ||
                    (bestIsSeed === isSeed && l < bestLoad);
                if (better) { bestLoad = l; best = peerId; bestIsSeed = isSeed; }
            }
            if (!best) continue;

            assignments.push({ peerId: best, hash });
            load.set(best, bestLoad + 1);
        }

        return assignments;
    }

    /** Chunks we can serve to a peer that lacks them. */
    canServe(peerHashes) {
        const want = peerHashes instanceof Set ? peerHashes : new Set(peerHashes);
        const out = [];
        for (const h of this.have) if (!want.has(h)) out.push(h);
        return out;
    }
}
