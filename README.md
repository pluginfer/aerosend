# AeroSend

**Peer-to-peer file transfer that sends less than the file.**

Free, open source, no accounts, no cloud. Runs in a browser — the receiving
device installs nothing.

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

## Tests

```bash
node test-brutal.mjs    # 37 correctness tests - byte-exact round trips
node test-chunker.mjs   # chunking behaviour and dedup properties
node test-dedup.mjs     # the savings benchmark above
```

`test-brutal.mjs` is the gate. It proves files survive a round trip byte for
byte at every boundary — 0 bytes, exactly MAX_SIZE, 10 MB of identical bytes,
frames split at awkward offsets. A transfer tool that silently corrupts files is
worse than one that fails loudly, so nothing ships without it green.

## Browser support

| Feature | Chrome / Edge | Firefox / Safari |
|---|:--:|:--:|
| Transfer, dedup, encryption | ✅ | ✅ |
| Streaming to disk (unlimited size) | ✅ | ❌ falls back to memory |

The File System Access API is Chromium-only for now. Elsewhere AeroSend buffers
in memory and warns above 512 MB — the same limitation every browser-based tool
has today.

## Status

**Working:** content-defined chunking, dedup, streaming to disk, end-to-end
encryption, multi-file queues, QR pairing, transfer resume.

**Not built yet:** swarm distribution (receivers seeding each other, so sending
to 30 devices costs one upload instead of thirty) and progressive consumption
(opening a file before it finishes). Both are planned; neither is claimed to
work today.

## License

Apache-2.0
