/**
 * Encryption utilities using Web Crypto API
 * Provides end-to-end encryption for file transfers
 */

export class EncryptionManager {
    constructor() {
        this.keyPair = null;
        this.sessionKey = null;
        this.peerPublicKey = null;
        this.isEncrypted = false;
    }

    /**
     * Generate RSA-OAEP key pair for key exchange
     */
    async generateKeyPair() {
        this.keyPair = await window.crypto.subtle.generateKey(
            {
                name: "RSA-OAEP",
                modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: "SHA-256"
            },
            true,
            ["encrypt", "decrypt"]
        );
        return this.keyPair;
    }

    /**
     * Generate AES-GCM session key for data encryption
     */
    async generateSessionKey() {
        this.sessionKey = await window.crypto.subtle.generateKey(
            {
                name: "AES-GCM",
                length: 256
            },
            true,
            ["encrypt", "decrypt"]
        );
        return this.sessionKey;
    }

    /**
     * Export public key for transmission to peer
     */
    async exportPublicKey() {
        if (!this.keyPair) {
            await this.generateKeyPair();
        }
        const exported = await window.crypto.subtle.exportKey(
            "spki",
            this.keyPair.publicKey
        );
        return this.arrayBufferToBase64(exported);
    }

    /**
     * Import peer's public key
     */
    async importPeerPublicKey(base64Key) {
        const binaryKey = this.base64ToArrayBuffer(base64Key);
        this.peerPublicKey = await window.crypto.subtle.importKey(
            "spki",
            binaryKey,
            {
                name: "RSA-OAEP",
                hash: "SHA-256"
            },
            true,
            ["encrypt"]
        );
        this.isEncrypted = true;
    }

    /**
     * Export session key encrypted with peer's public key
     */
    async exportEncryptedSessionKey() {
        if (!this.sessionKey) {
            await this.generateSessionKey();
        }
        const rawKey = await window.crypto.subtle.exportKey("raw", this.sessionKey);
        const encrypted = await window.crypto.subtle.encrypt(
            { name: "RSA-OAEP" },
            this.peerPublicKey,
            rawKey
        );
        return this.arrayBufferToBase64(encrypted);
    }

    /**
     * Import session key (decrypt with our private key)
     */
    async importEncryptedSessionKey(base64EncryptedKey) {
        const encryptedKey = this.base64ToArrayBuffer(base64EncryptedKey);
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "RSA-OAEP" },
            this.keyPair.privateKey,
            encryptedKey
        );

        this.sessionKey = await window.crypto.subtle.importKey(
            "raw",
            decrypted,
            { name: "AES-GCM" },
            true,
            ["encrypt", "decrypt"]
        );
        this.isEncrypted = true;
    }

    /**
     * Encrypt data chunk
     */
    async encryptChunk(data) {
        if (!this.sessionKey) {
            throw new Error("Session key not initialized");
        }

        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await window.crypto.subtle.encrypt(
            {
                name: "AES-GCM",
                iv: iv
            },
            this.sessionKey,
            data
        );

        // Prepend IV to encrypted data
        const result = new Uint8Array(iv.length + encrypted.byteLength);
        result.set(iv, 0);
        result.set(new Uint8Array(encrypted), iv.length);

        return result.buffer;
    }

    /**
     * Decrypt data chunk
     */
    async decryptChunk(encryptedData) {
        if (!this.sessionKey) {
            throw new Error("Session key not initialized");
        }

        const data = new Uint8Array(encryptedData);
        const iv = data.slice(0, 12);
        const encrypted = data.slice(12);

        const decrypted = await window.crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: iv
            },
            this.sessionKey,
            encrypted
        );

        return decrypted;
    }

    // Utility functions
    arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }

    base64ToArrayBuffer(base64) {
        const binary = window.atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }
}
