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
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
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
    const secret = password ? `${code.toUpperCase()}::${password}` : `code-only::${code.toUpperCase()}`;
    const salt = enc.encode(`heymamaey-room-v1:${code.toUpperCase()}`);
    const base = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, [
      "deriveKey",
    ]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: 100_000, hash: "SHA-256" },
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

// ---- per-session room password cache (sessionStorage: tab-scoped, gone on close) ----

const MEMO = new Map<string, string>();

export function setRoomPassword(code: string, password: string): void {
  const c = code.toUpperCase();
  if (password) {
    MEMO.set(c, password);
    try {
      sessionStorage.setItem(`heymamaey.roompw.${c}`, password);
    } catch {
      /* ignore */
    }
  } else {
    MEMO.delete(c);
    try {
      sessionStorage.removeItem(`heymamaey.roompw.${c}`);
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
    const s = sessionStorage.getItem(`heymamaey.roompw.${c}`) ?? "";
    if (s) MEMO.set(c, s);
    return s;
  } catch {
    return "";
  }
}

export function clearRoomPassword(code: string): void {
  setRoomPassword(code, "");
}
