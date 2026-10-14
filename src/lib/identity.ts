// Phase 2 verifiable identity: per-identity ECDSA P-256 keypair.
// The private key lives on the device (backed up inside the access-key
// payload, same trust root as everything else). The public key is published
// to the identity_keys registry. Messages carry signatures; owner actions
// go through signed admin tickets. All failures are fail-soft (null/false)
// so chat keeps working where identity is unavailable.

import { supabase } from "@/integrations/supabase/client";

const IDKEY_STORAGE = "heymamaey.idkey.v1";
const AUTHOR_KEY_CACHE = "heymamaey.idkeys.v1";
const AUTHOR_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const ADMIN_SIGN_PREFIX = "heymamaey-admin-v1";
export const MSG_SIGN_PREFIX = "heymamaey-msg-v1";

/* ---------- encoding helpers ---------- */

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hexEncode(new Uint8Array(digest));
}

function subtleOrNull(): SubtleCrypto | null {
  try {
    if (typeof window === "undefined" || !window.crypto?.subtle) return null;
    return window.crypto.subtle;
  } catch {
    return null;
  }
}

/* ---------- keypair lifecycle ---------- */

type StoredJwk = { kty: string; crv: string; x: string; y: string; d: string };

function isPrivateJwk(v: unknown): v is StoredJwk {
  const j = v as Partial<StoredJwk>;
  return (
    Boolean(j) &&
    j.kty === "EC" &&
    j.crv === "P-256" &&
    typeof j.x === "string" &&
    typeof j.y === "string" &&
    typeof j.d === "string"
  );
}

let pairMemo: CryptoKeyPair | null = null;

/** Strip export metadata (key_ops/ext) that some runtimes reject on import. */
function cleanPrivateJwk(j: StoredJwk): JsonWebKey {
  return { kty: "EC", crv: "P-256", x: j.x, y: j.y, d: j.d };
}

function loadStoredPrivateJwk(): StoredJwk | null {
  try {
    const raw = window.localStorage.getItem(IDKEY_STORAGE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isPrivateJwk(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Device identity keypair (generated once, persisted). Null when unavailable. */
export async function ensureIdentityKeypair(): Promise<CryptoKeyPair | null> {
  if (pairMemo) return pairMemo;
  const subtle = subtleOrNull();
  if (!subtle) return null;
  try {
    const stored = typeof window !== "undefined" ? loadStoredPrivateJwk() : null;
    if (stored) {
      // Import private (sign) and public (verify) halves separately: some
      // runtimes reject "verify" usage on a private-key import.
      const clean = cleanPrivateJwk(stored);
      const privateKey = await subtle.importKey(
        "jwk",
        clean,
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign"],
      );
      const publicKey = await subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: clean.x, y: clean.y } as JsonWebKey,
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["verify"],
      );
      pairMemo = { privateKey, publicKey };
      return pairMemo;
    }
    const fresh = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const exported = (await subtle.exportKey("jwk", fresh.privateKey)) as StoredJwk;
    if (!isPrivateJwk(exported)) return null;
    try {
      window.localStorage.setItem(
        IDKEY_STORAGE,
        JSON.stringify({
          kty: "EC",
          crv: "P-256",
          x: exported.x,
          y: exported.y,
          d: exported.d,
        }),
      );
    } catch {
      /* memory-only key */
    }
    pairMemo = fresh;
    return pairMemo;
  } catch {
    return null;
  }
}

export async function getPublicJwk(): Promise<{ x: string; y: string } | null> {
  const pair = await ensureIdentityKeypair();
  if (!pair) return null;
  try {
    const subtle = subtleOrNull();
    if (!subtle) return null;
    const pub = (await subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
    if (typeof pub.x !== "string" || typeof pub.y !== "string") return null;
    return { x: pub.x, y: pub.y };
  } catch {
    return null;
  }
}

/** Registry payload: canonical minimal public JWK text. */
export function publicJwkText(x: string, y: string): string {
  return JSON.stringify({ kty: "EC", crv: "P-256", x, y });
}

/** Full fingerprint (pinned for TOFU) + short display form. */
export async function fingerprintOfPublicKey(x: string, y: string): Promise<string | null> {
  const subtle = subtleOrNull();
  if (!subtle) return null;
  try {
    const xb = b64urlDecode(x);
    const yb = b64urlDecode(y);
    const raw = new Uint8Array(1 + xb.length + yb.length);
    raw[0] = 0x04;
    raw.set(xb, 1);
    raw.set(yb, 1 + xb.length);
    const digest = new Uint8Array(await subtle.digest("SHA-256", raw.buffer as ArrayBuffer));
    const b32 = base32Encode(digest);
    return `${b32.slice(0, 4)}-${b32.slice(4, 8)}-${b32.slice(8, 12)}-${b32.slice(12, 16)}`;
  } catch {
    return null;
  }
}

export function shortFingerprint(full: string): string {
  return full.length >= 9 ? full.slice(0, 9) : full;
}

async function registrationHash(permanentKey: string): Promise<string> {
  return sha256Hex(`heymamaey-reg-v1:${permanentKey.trim()}`);
}

/** Publish our public key (first-claim-wins). Best-effort; returns status. */
export async function registerIdentityKey(
  userId: string,
  permanentKey: string,
): Promise<"ok" | "conflict" | "unavailable" | "error"> {
  const uid = (userId ?? "").trim().toUpperCase();
  if (!uid || !permanentKey) return "unavailable";
  const pub = await getPublicJwk();
  if (!pub) return "unavailable";
  try {
    const { error } = await supabase.rpc("register_identity", {
      p_user_id: uid,
      p_public_jwk: publicJwkText(pub.x, pub.y),
      p_reg_hash: await registrationHash(permanentKey),
    });
    if (!error) return "ok";
    if ((error.message ?? "").includes("IDENTITY_KEY_CONFLICT")) return "conflict";
    return "error";
  } catch {
    return "error";
  }
}

/* ---------- backup / restore of the private key ---------- */

/** Sync read for the access-key backup payload. */
export function exportIdentityJwk(): StoredJwk | undefined {
  try {
    const stored = loadStoredPrivateJwk();
    return stored ?? undefined;
  } catch {
    return undefined;
  }
}

/** Returns false when the shape is invalid (caller keeps current key). */
export function importIdentityJwk(jwk: unknown): boolean {
  if (!isPrivateJwk(jwk)) return false;
  pairMemo = null;
  try {
    window.localStorage.setItem(
      IDKEY_STORAGE,
      JSON.stringify({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }),
    );
  } catch {
    return false;
  }
  return true;
}

export function clearIdentityKey(): void {
  pairMemo = null;
  try {
    window.localStorage.removeItem(IDKEY_STORAGE);
  } catch {
    /* ignore */
  }
}

/* ---------- message signatures ---------- */

export type WireFields = {
  code: string;
  authorId: string;
  kind: string;
  wireText?: string;
  dataUrl?: string;
  fileName?: string;
  forwarded?: boolean;
};

export async function canonicalMessage(fields: WireFields): Promise<string> {
  const textHash = await sha256Hex(fields.wireText ?? "");
  const dataHash = fields.dataUrl ? await sha256Hex(fields.dataUrl) : "";
  return [
    MSG_SIGN_PREFIX,
    (fields.code ?? "").toUpperCase(),
    fields.authorId ?? "",
    fields.kind ?? "",
    textHash,
    dataHash,
    fields.fileName ?? "",
    fields.forwarded ? "1" : "0",
  ].join("|");
}

/** Sign a wire payload. Null when identity is unavailable (legacy unsigned). */
export async function signWireMessage(fields: WireFields): Promise<string | null> {
  const subtle = subtleOrNull();
  const pair = await ensureIdentityKeypair();
  if (!subtle || !pair) return null;
  try {
    const raw = await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      new TextEncoder().encode(await canonicalMessage(fields)),
    );
    return b64urlEncode(new Uint8Array(raw));
  } catch {
    return null;
  }
}

/** Verify a wire signature against a registry public key. */
export async function verifyWireMessage(
  pub: { x: string; y: string },
  sig: string,
  fields: WireFields,
): Promise<boolean> {
  const subtle = subtleOrNull();
  if (!subtle || !sig) return false;
  try {
    const key = await subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: pub.x, y: pub.y } as unknown as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const raw = b64urlDecode(sig);
    if (raw.length !== 64) return false;
    return await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      raw.buffer as ArrayBuffer,
      new TextEncoder().encode(await canonicalMessage(fields)),
    );
  } catch {
    return false;
  }
}

/* ---------- author key directory (cached) ---------- */

type CachedKey = { x: string; y: string; at: number };

function loadAuthorKeyCache(): Record<string, CachedKey> {
  try {
    const raw = window.localStorage.getItem(AUTHOR_KEY_CACHE);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { keys?: Record<string, CachedKey> };
    return parsed.keys && typeof parsed.keys === "object" ? parsed.keys : {};
  } catch {
    return {};
  }
}

function saveAuthorKeyCache(keys: Record<string, CachedKey>) {
  try {
    const entries = Object.entries(keys).slice(-500);
    window.localStorage.setItem(
      AUTHOR_KEY_CACHE,
      JSON.stringify({ keys: Object.fromEntries(entries) }),
    );
  } catch {
    /* ignore */
  }
}

/** Registry public keys for author IDs (cached 30d). Never throws. */
export async function fetchAuthorKeys(
  ids: string[],
): Promise<Map<string, { x: string; y: string }>> {
  const out = new Map<string, { x: string; y: string }>();
  const uniq = [...new Set(ids.map((i) => (i ?? "").trim()).filter(Boolean))];
  if (uniq.length === 0 || typeof window === "undefined") return out;
  const cache = loadAuthorKeyCache();
  const now = Date.now();
  const missing = uniq.filter((id) => {
    const hit = cache[id];
    if (
      hit &&
      typeof hit.x === "string" &&
      typeof hit.y === "string" &&
      now - hit.at < AUTHOR_KEY_TTL_MS
    ) {
      out.set(id, { x: hit.x, y: hit.y });
      return false;
    }
    return true;
  });
  if (missing.length > 0) {
    try {
      const { data } = await supabase.rpc("get_identity_keys", { p_user_ids: missing });
      if (Array.isArray(data)) {
        for (const row of data as { user_id: string; public_jwk: string }[]) {
          try {
            const jwk = JSON.parse(row.public_jwk) as { x?: unknown; y?: unknown };
            if (typeof jwk.x === "string" && typeof jwk.y === "string") {
              out.set(row.user_id, { x: jwk.x, y: jwk.y });
              cache[row.user_id] = { x: jwk.x, y: jwk.y, at: now };
            }
          } catch {
            /* skip malformed */
          }
        }
        saveAuthorKeyCache(cache);
      }
    } catch {
      /* offline — use what the cache gave */
    }
  }
  return out;
}

/* ---------- signed admin tickets ---------- */

/** Mint a one-time admin ticket via the edge verifier. Throws on failure. */
export async function requestAdminTicket(
  action: "set_password" | "set_lock" | "set_readonly" | "kick" | "unban" | "delete_space",
  code: string,
  userId: string,
): Promise<string> {
  const subtle = subtleOrNull();
  const pair = await ensureIdentityKeypair();
  if (!subtle || !pair) throw new Error("NO_IDENTITY");
  const uid = (userId ?? "").trim().toUpperCase();
  const c = (code ?? "").trim();
  if (!uid || !c) throw new Error("Missing identity.");
  const expires = Date.now() + 5 * 60_000;
  const payload = `${ADMIN_SIGN_PREFIX}|${action}|${c}|${uid}|${expires}`;
  const raw = await subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    new TextEncoder().encode(payload),
  );
  const { data, error } = await supabase.functions.invoke("secure-room-admin", {
    body: { action, code: c, user_id: uid, expires, sig: b64urlEncode(new Uint8Array(raw)) },
  });
  if (error) throw new Error(error.message || "Admin verification failed.");
  const ticket = (data as { ticket?: unknown } | null)?.ticket;
  if (typeof ticket !== "string" || !ticket) {
    const detail = (data as { error?: unknown } | null)?.error;
    throw new Error(typeof detail === "string" && detail ? detail : "Admin verification failed.");
  }
  return ticket;
}
