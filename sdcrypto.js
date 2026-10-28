// SupportDesk phone app - reading and writing the program's sync files (the same as app/sync.py on the computer):
//   key  = scrypt(sync code, "SupportDesk-sync-v1", N=16384, r=8, p=1, 32 bytes)
//   file = "SDS1" + 12-byte nonce + AES-256-GCM(gzip(JSON), additional data "SDS1")
// and checking the program's license code (Ed25519, like app/licensing.py).
(function (root) {
  'use strict';
  const enc = new TextEncoder(), dec = new TextDecoder();
  const MAGIC = enc.encode('SDS1');
  const subtle = (root.crypto || globalThis.crypto).subtle;

  // ---------------------------------------------------------------- scrypt
  async function pbkdf2(pass, salt, len) {
    const k = await subtle.importKey('raw', pass, 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 1, hash: 'SHA-256' }, k, len * 8));
  }
  function salsa8(B, x) {
    x.set(B);
    const R = (a, b) => (a << b) | (a >>> (32 - b));
    for (let i = 0; i < 8; i += 2) {
      x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
      x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
      x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
      x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
      x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
      x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
      x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
      x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
    }
    for (let i = 0; i < 16; i++) B[i] = (B[i] + x[i]) | 0;
  }
  function blockMix(B, Y, X, x, r) {
    X.set(B.subarray((2 * r - 1) * 16, 2 * r * 16));
    for (let i = 0; i < 2 * r; i++) {
      for (let k = 0; k < 16; k++) X[k] ^= B[i * 16 + k];
      salsa8(X, x);
      Y.set(X, i * 16);
    }
    for (let i = 0; i < r; i++) {
      B.set(Y.subarray(2 * i * 16, (2 * i + 1) * 16), i * 16);
      B.set(Y.subarray((2 * i + 1) * 16, (2 * i + 2) * 16), (r + i) * 16);
    }
  }
  async function scrypt(pass, salt, N, r, p, dkLen) {
    const B = await pbkdf2(pass, salt, p * 128 * r);
    const W = 32 * r;
    const V = new Uint32Array(W * N), X = new Uint32Array(W), Y = new Uint32Array(W);
    const T = new Uint32Array(16), x = new Uint32Array(16);
    for (let q = 0; q < p; q++) {
      const off = q * 128 * r;
      for (let k = 0; k < W; k++) {
        const j = off + k * 4;
        X[k] = B[j] | (B[j + 1] << 8) | (B[j + 2] << 16) | (B[j + 3] << 24);
      }
      for (let i = 0; i < N; i++) { V.set(X, i * W); blockMix(X, Y, T, x, r); }
      for (let i = 0; i < N; i++) {
        const j = X[(2 * r - 1) * 16] & (N - 1);
        for (let k = 0; k < W; k++) X[k] ^= V[j * W + k];
        blockMix(X, Y, T, x, r);
      }
      for (let k = 0; k < W; k++) {
        const v = X[k], j = off + k * 4;
        B[j] = v & 255; B[j + 1] = (v >>> 8) & 255; B[j + 2] = (v >>> 16) & 255; B[j + 3] = (v >>> 24) & 255;
      }
    }
    return pbkdf2(pass, B, dkLen);
  }

  // the sync code -> the 32-byte key (raw bytes)
  async function deriveKey(code) {
    return scrypt(enc.encode(String(code).trim()), enc.encode('SupportDesk-sync-v1'), 16384, 8, 1, 32);
  }

  // ---------------------------------------------------------------- the files
  async function gzipBytes(data, mode) {
    const s = new Blob([data]).stream().pipeThrough(mode === 'c' ? new CompressionStream('gzip') : new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  async function aesKey(raw) {
    return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  // an encrypted sync file -> its JSON (throws on a wrong code / not a sync file)
  async function openFile(bytes, rawKey) {
    const b = new Uint8Array(bytes);
    for (let i = 0; i < 4; i++) if (b[i] !== MAGIC[i]) throw new Error('not a sync file');
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(4, 16), additionalData: MAGIC },
      await aesKey(rawKey), b.subarray(16));
    return JSON.parse(dec.decode(await gzipBytes(new Uint8Array(plain), 'd')));
  }
  async function makeFile(obj, rawKey) {
    const z = await gzipBytes(enc.encode(JSON.stringify(obj)), 'c');
    const nonce = (root.crypto || globalThis.crypto).getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: MAGIC }, await aesKey(rawKey), z));
    const out = new Uint8Array(16 + ct.length);
    out.set(MAGIC, 0); out.set(nonce, 4); out.set(ct, 16);
    return out;
  }

  // ---------------------------------------------------------------- the license (app/licensing.py)
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function b32decode(text) {
    let t = String(text || '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
    t = [...t].filter(ch => ALPHABET.includes(ch)).join('');
    let n = 0, bits = 0; const out = [];
    for (const ch of t) {
      n = ((n << 5) | ALPHABET.indexOf(ch)) & 0xffffff; bits += 5;
      if (bits >= 8) { bits -= 8; out.push((n >> bits) & 255); }
    }
    return new Uint8Array(out);
  }
  function b64(s) { const bin = atob(s); return Uint8Array.from(bin, c => c.charCodeAt(0)); }
  // {ok, reason: invalid|expired|nokey|unsupported, expires: 'YYYY-MM-DD', daysLeft}
  async function checkLicense(code, pubB64, today) {
    if (!pubB64) return { ok: false, reason: 'nokey' };
    let key;
    try { key = await subtle.importKey('raw', b64(pubB64), { name: 'Ed25519' }, false, ['verify']); }
    catch (e) { return { ok: false, reason: 'unsupported' }; }
    const raw = b32decode(code);
    const plen = { 2: 11, 3: 15 }[raw[0]];
    if (!plen || raw.length < plen + 64) return { ok: false, reason: 'invalid' };
    const payload = raw.subarray(0, plen), sig = raw.subarray(plen, plen + 64);
    let good = false;
    try { good = await subtle.verify({ name: 'Ed25519' }, key, sig, payload); } catch (e) { good = false; }
    if (!good) return { ok: false, reason: 'invalid' };
    const days = (payload[3] << 8) | payload[4];
    const exp = new Date(Date.UTC(2024, 0, 1) + days * 86400000);
    const now = today || new Date();
    const t0 = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const left = Math.round((exp.getTime() - t0) / 86400000);
    return { ok: left >= 0, reason: left >= 0 ? '' : 'expired', expires: exp.toISOString().slice(0, 10), daysLeft: left };
  }

  const api = { deriveKey, openFile, makeFile, checkLicense, scrypt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SDCrypto = api;
})(typeof window !== 'undefined' ? window : globalThis);
