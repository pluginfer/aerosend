/**
 * Streaming file writer.
 *
 * The whole point: never hold a complete file in memory.
 *
 * PairDrop/Snapdrop buffer every chunk in RAM and build a Blob at the end,
 * which is why transfers over a few hundred MB die (their issue #120). We
 * stream each chunk straight to disk via the File System Access API, so the
 * only ceiling is free disk space.
 *
 * Firefox/Safari don't expose showSaveFilePicker yet, so we fall back to
 * in-memory buffering there - same behaviour as the others, no worse.
 */

export const canStreamToDisk = () =>
    typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

export class DiskWriter {
    constructor() {
        this.mode = null;        // 'disk' | 'memory'
        this.writable = null;    // FileSystemWritableFileStream
        this.buffer = [];        // memory fallback
        this.fileName = '';
        this.bytesWritten = 0;
    }

    /**
     * Ask the user where to save, then open a writable stream.
     * Must be called from a user gesture on some browsers, so the caller
     * should prompt as early as possible (when metadata arrives).
     */
    async open(fileName, fileSize) {
        this.fileName = fileName;
        this.bytesWritten = 0;

        if (canStreamToDisk()) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: fileName,
                    startIn: 'downloads',
                });
                this.writable = await handle.createWritable();
                this.mode = 'disk';
                console.log(`💾 Streaming "${fileName}" straight to disk (no memory limit)`);
                return this.mode;
            } catch (err) {
                // User cancelled the picker, or it is unavailable in this context
                // (e.g. a non-secure origin). Fall back rather than fail the transfer.
                console.warn('Disk streaming unavailable, buffering in memory:', err?.name || err);
            }
        }

        this.mode = 'memory';
        this.buffer = [];
        if (fileSize > 512 * 1024 * 1024) {
            console.warn(
                `⚠️ ${fileName} is ${(fileSize / 1024 ** 3).toFixed(1)}GB and this browser ` +
                `cannot stream to disk. Use Chrome or Edge for large files.`
            );
        }
        return this.mode;
    }

    async write(chunk) {
        if (this.mode === 'disk') {
            await this.writable.write(chunk);
        } else {
            this.buffer.push(chunk);
        }
        this.bytesWritten += chunk.byteLength ?? chunk.size ?? 0;
    }

    /**
     * Finish the file. Returns a Blob in memory mode (so the caller can
     * trigger a download), or null in disk mode - it is already saved.
     */
    async close() {
        if (this.mode === 'disk') {
            await this.writable.close();
            this.writable = null;
            return null;
        }
        const blob = new Blob(this.buffer);
        this.buffer = [];
        return blob;
    }

    async abort() {
        try {
            if (this.mode === 'disk' && this.writable) {
                await this.writable.abort();
            }
        } catch { /* nothing useful to do */ }
        this.writable = null;
        this.buffer = [];
    }
}
