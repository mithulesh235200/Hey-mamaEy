// Client-side encryption for Space messages (Web Crypto API).
// Model: AES-GCM-256 with a room key derived via PBKDF2 from
// (space code + optional room password). Ciphertext is what hits Supabase.
// Without a room password the code itself is the key material: this hides
// plaintext from the database/host but anyone holding the code can decrypt
// (expected). WITH a room password, the server/DB never sees the password
// or the plaintext: true end-to-end secrecy for text payloads.

export const ENC_PREFIX = "__enc1__.";

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64encode(bytes: Uint8Array): string {
  // Chunked: attachments can be megabytes — one fromCharCode per byte gets
  // slow, and spreading >64k args overflows some engines' arg limits.
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function b64decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function isEncryptedWire(text: string | undefined | null): boolean {
  return typeof text === "string" && text.startsWith(ENC_PREFIX);
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function cacheKey(code: string, password: string): string {
  return `${code.toUpperCase()}|${password}`;
}

async function deriveRoomKey(code: string, password: string): Promise<CryptoKey> {
  const ck = cacheKey(code, password);
  const hit = keyCache.get(ck);
  if (hit) return hit;
  const task = (async (): Promise<CryptoKey> => {
    const secret = password
      ? `${code.toUpperCase()}::${password}`
      : `code-only::${code.toUpperCase()}`;
    const salt = enc.encode(`heymamaey-room-v1:${code.toUpperCase()}`);
    const base = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, [
      "deriveKey",
    ]);
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt as unknown as BufferSource,
        iterations: 100_000,
        hash: "SHA-256",
      },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  })();
  keyCache.set(ck, task);
  try {
    return await task;
  } catch (e) {
    keyCache.delete(ck);
    throw e;
  }
}

/** Encrypt a plaintext message for a room. Returns wire string. */
export async function encryptRoomText(
  plain: string,
  code: string,
  password: string,
): Promise<string> {
  const key = await deriveRoomKey(code, password);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    enc.encode(plain),
  );
  return `${ENC_PREFIX}${b64encode(iv)}.${b64encode(new Uint8Array(ct))}`;
}

/** Decrypt a wire string. Returns plaintext, or null on failure. */
export async function decryptRoomText(
  wire: string,
  code: string,
  password: string,
): Promise<string | null> {
  try {
    const body = wire.slice(ENC_PREFIX.length);
    const dot = body.indexOf(".");
    if (dot < 0) return null;
    const iv = b64decode(body.slice(0, dot));
    const ct = b64decode(body.slice(dot + 1));
    const key = await deriveRoomKey(code, password);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      key,
      ct as unknown as BufferSource,
    );
    return dec.decode(pt);
  } catch {
    return null;
  }
}

/** SHA-256 hex of a room password. Only the hash is ever sent/stored. */
export async function hashRoomPassword(password: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(`heymamaey-pw-v1:${password}`));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------- attachment (data: URL) encryption ----------
// The payload is sealed as RAW BYTES (header + NUL + bytes), not as the
// base64 string: encrypting the string would grow the wire by ~1.8x and
// push big uploads past the server's 18M-char data_url cap. Raw-byte
// sealing keeps the ciphertext ~the same length as the plaintext data URL.
// Wire format is the same __enc1__.<iv>.<ct> shape as text messages, so
// one prefix check detects both.

/**
 * Encrypts a `data:` URL attachment for a room. Returns the wire string
 * (`__enc1__....`). Non-base64 data URLs (rare) are sealed as whole text.
 */
export async function encryptRoomDataUrl(
  dataUrl: string,
  code: string,
  password: string,
): Promise<string> {
  const comma = dataUrl.indexOf(",");
  const header = comma >= 0 ? dataUrl.slice(0, comma + 1) : "";
  if (!header.endsWith(";base64,")) {
    return encryptRoomText(dataUrl, code, password);
  }
  const raw = b64decode(dataUrl.slice(comma + 1));
  const headerBytes = enc.encode(header);
  // header \0 raw — the header never contains NUL, so the split is unambiguous.
  const plain = new Uint8Array(headerBytes.length + 1 + raw.length);
  plain.set(headerBytes, 0);
  plain[headerBytes.length] = 0;
  plain.set(raw, headerBytes.length + 1);
  const key = await deriveRoomKey(code, password);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    plain as unknown as BufferSource,
  );
  return `${ENC_PREFIX}${b64encode(iv)}.${b64encode(new Uint8Array(ct))}`;
}

/** Decrypts a wire attachment back to a `data:` URL. Null on failure. */
export async function decryptRoomDataUrl(
  wire: string,
  code: string,
  password: string,
): Promise<string | null> {
  try {
    const body = wire.slice(ENC_PREFIX.length);
    const dot = body.indexOf(".");
    if (dot < 0) return null;
    const iv = b64decode(body.slice(0, dot));
    const ct = b64decode(body.slice(dot + 1));
    const key = await deriveRoomKey(code, password);
    const pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as unknown as BufferSource },
        key,
        ct as unknown as BufferSource,
      ),
    );
    const nul = pt.indexOf(0);
    if (nul >= 0) {
      // Standard format: header \0 raw bytes.
      const header = dec.decode(pt.subarray(0, nul));
      if (!header.startsWith("data:")) return null;
      return header + b64encode(pt.subarray(nul + 1));
    }
    // Fallback format (non-base64 data URL sealed as whole text).
    const whole = dec.decode(pt);
    return whole.startsWith("data:") ? whole : null;
  } catch {
    return null;
  }
}

// ---- room password cache (localStorage: survives reload/new-tab so locked
// Spaces never vanish; cleared only on Leave / password removal) ----

const MEMO = new Map<string, string>();

function storageGet(key: string): string {
  try {
    const v = window.localStorage.getItem(key);
    if (v) return v;
  } catch {
    /* ignore */
  }
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function storageRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function setRoomPassword(code: string, password: string): void {
  const c = code.toUpperCase();
  const key = `heymamaey.roompw.${c}`;
  if (password) {
    MEMO.set(c, password);
    try {
      storageSet(key, password);
    } catch {
      /* ignore */
    }
  } else {
    MEMO.delete(c);
    try {
      storageRemove(key);
    } catch {
      /* ignore */
    }
  }
}

export function getRoomPassword(code: string): string {
  const c = (code ?? "").toUpperCase();
  const memo = MEMO.get(c);
  if (memo !== undefined) return memo;
  try {
    const s = storageGet(`heymamaey.roompw.${c}`) ?? "";
    if (s) MEMO.set(c, s);
    return s;
  } catch {
    return "";
  }
}

export function clearRoomPassword(code: string): void {
  setRoomPassword(code, "");
}
