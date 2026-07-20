# AeroSend

**Peer-to-peer file transfer that sends less than the file.**

Free, open source, no accounts. Runs in a browser — the receiving device
installs nothing.

### → [aerosend-signal.onrender.com](https://aerosend-signal.onrender.com)

Open it on two devices, create a room on one, scan the QR from the other.
Works on the same WiFi or across the internet. Files go peer to peer and never
touch the server.

*(Free tier: if it has been idle a while, the first load takes ~40s to wake.)*

---

## The idea

Every file transfer tool moves bytes from A to B and competes on how fast the
pipe is. AeroSend treats a file as **content-addressed state** and transfers
only what the other device is actually missing.

Send a folder, change one file, send it again — and only that file crosses the
wire.

## Measured savings

Benchmarks on **incompressible random data** (the worst case — none of this
comes from compression). Reproduce with `node test-dedup.mjs`:

| Scenario | Transferred | Saved |
|---|---|---|
| Re-send the same 40 MB video | **0 MB** | **100%** |
| Video after a metadata re-tag | 1.3 MB of 40 MB | **96.7%** |
| Dataset after appending 8 MB | 8.9 MB of 32 MB | **72.3%** |
| **Folder of 8 files, 1 changed** | 9.7 MB of 64 MB | **84.8%** |
| Fine-tuned model vs cached base | 8.8 MB of 32 MB | **72.5%** |

## Swarm: sending to many devices

Sending a 5 GB file to 30 devices normally costs the sender 150 GB of upload
and takes 30× as long, because every receiver pulls independently. AeroSend's
scheduler lets receivers serve each other, so the origin uploads each chunk
about once regardless of how many devices are waiting.

Measured by `node test-swarm.mjs` (simulated network, real scheduler):

| Devices | Classic upload | Swarm upload | Speedup |
|---|---|---|---|
| 1 | 1.0× | 1.00× | — |
| 10 | 10.0× | **1.00×** | 3.1× |
| 30 | 30.0× | **1.00×** | 5.3× |
| 50 | 50.0× | **1.00×** | 6.1× |

The scheduler uses rarest-first selection and treats the origin as a last
resort — if any receiver can serve a chunk, it does, so the sender's cost stays
flat as the swarm grows.

## Sending over the internet

A hosted instance runs at
**[aerosend-signal.onrender.com](https://aerosend-signal.onrender.com)** — use
it directly, or deploy your own so nothing depends on someone else's server:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/pluginfer/aerosend)

One deploy serves both the app and signalling - `server/signal.js` serves the
built frontend when `dist/` is present. Free tier is enough: signalling only
relays connection setup, a few KB per transfer, because file bytes go peer to
peer and never touch the server.

Running it yourself:

```bash
npm run build
npm run signal          # serves app + signalling on PORT (default 8080)
```

### Speed, honestly

Over the internet you are limited by your upload bandwidth - typically
10-50 Mbps against 100-1000 Mbps on a LAN. So it is slower.

Dedup matters *more* there, not less: skipping 54 MB of a 64 MB folder saves a
couple of seconds on WiFi, but minutes on a home connection.

### TURN, and why it is off by default

STUN gets a direct peer connection on most home networks. Symmetric NAT and
carrier-grade NAT need a TURN relay, configured with `TURN_URL`,
`TURN_USERNAME` and `TURN_CREDENTIAL`.

Be aware what that means: **a TURN server relays every byte**. A 5 GB transfer
costs 5 GB of relay bandwidth, unlike the signalling server which costs
kilobytes. That is a real bill, so it stays opt-in.

## How it compares

|  | Dedup | Zero install | Multi-GB files | Ad-hoc send |
|---|:--:|:--:|:--:|:--:|
| AirDrop | ❌ | Apple only | ✅ | ✅ |
| LocalSend | ❌ | ❌ both ends | ✅ | ✅ |
| PairDrop / Snapdrop | ❌ | ✅ | ⚠️ RAM-bound | ✅ |
| rsync / Syncthing | ✅ | ❌ | ✅ | ❌ sync tool |
| **AeroSend** | ✅ | ✅ | ✅ | ✅ |

The techniques are not new — FastCDC is a 2016 paper, rsync is older still.
What is new is putting them behind a QR code. Every tool with content-aware
transfer is a heavyweight sync product that needs installing and configuring on
both ends; every zero-install tool is a dumb pipe.

## How it works

1. **Content-defined chunking.** The file is split on boundaries chosen by a
   rolling hash (FastCDC), not at fixed offsets. Insert a byte at the start and
   only the chunks around the edit change — with fixed-size chunks every later
   chunk would shift and nothing would match.
2. **Content addressing.** Each chunk is keyed by the SHA-256 of its bytes. Two
   devices holding the same bytes compute the same key without talking.
3. **Reconcile, then transfer.** The sender ships a manifest; the receiver
   replies with only the hashes it lacks; the sender sends only those.
4. **Stream to disk.** Chunks are written straight to disk via the File System
   Access API. Memory stays flat, so file size is bounded by disk, not RAM.
5. **End-to-end encryption.** RSA-OAEP 2048 key exchange, AES-256-GCM payload,
   via the Web Crypto API. Files never touch a server — the Node process only
   relays WebRTC signalling.

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

Open the URL on one device, hit **Create Room**, then scan the QR code from the
other device. Both devices can send and receive.

Desktop build (optional):

```bash
npm run electron     # dev shell
npm run dist         # packaged installer
```

## Browser support

| Feature | Chrome / Edge | Firefox / Safari |
|---|:--:|:--:|
| Transfer, dedup, encryption | ✅ | ✅ |
| Streaming to disk (unlimited size) | ✅ | ❌ falls back to memory |

The File System Access API is Chromium-only for now. Elsewhere AeroSend buffers
in memory and warns above 512 MB — the same limitation every browser-based tool
has today.

## Status

**Working end to end:** content-defined chunking, dedup, streaming to disk,
end-to-end encryption, multi-file queues, QR pairing, transfer resume.

**Swarm — scheduler done, transport not yet wired.** `SwarmScheduler` is
complete and proven in simulation (the table above), including rarest-first
selection, seed de-prioritisation, endgame duplication, and peer-failure
recovery. What is *not* built is the mesh transport underneath it: today the
app opens a single WebRTC connection between two peers, so the multi-peer
numbers above are not yet available in the UI. Wiring room membership,
many-to-many connections and HAVE announcements is the next piece of work.

**Not built:** progressive consumption (opening a file before it finishes).

## Tests

```bash
node test-brutal.mjs    # 37 correctness tests - byte-exact round trips
node test-swarm.mjs     # 15 swarm scheduling tests + the scaling benchmark
node test-chunker.mjs   # chunking behaviour and dedup properties
node test-dedup.mjs     # the savings benchmark above
```

## License

Apache-2.0
