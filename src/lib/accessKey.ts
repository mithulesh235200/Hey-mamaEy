// Permanent Secret Access Key Module for Cross-Device Data Access & Identity Sync
//
// v2 (current): 20-char Crockford-base32 key (100 bits of entropy) with an
//               AES-GCM encrypted backup token (`HEYMAMA_KEY2_…`). The backup
//               no longer embeds the access key or identity private key in
//               plaintext — decrypting it requires the key in a separate field.
// v1 (legacy)  : 12-digit numeric key (≈40 bits) with a plaintext base64
//               backup token (`HEYMAMA_KEY_…`). Still accepted for restore so
//               existing installs keep their identity, but never generated
//               again. Legacy userId derivation is byte-for-byte unchanged.

/** Crockford base32 (no I, L, O, U) — unambiguous when typed or dictated. */
const KEY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const NEW_KEY_LENGTH = 20; // 20 × 5 bits = 100 bits

const BACKUP_V2_PREFIX = "HEYMAMA_KEY2_";
const BACKUP_V1_PREFIX = "HEYMAMA_KEY_";
const BACKUP_V1_ALT_PREFIX = "HEYMAMA_BACKUP_";
const PBKDF2_ITERATIONS = 600_000;

/* ---------- randomness (fail closed — never fall back to Math.random) ---------- */

function getSecureRandom(): Crypto {
  const api = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (!api || typeof api.getRandomValues !== "function") {
    throw new Error(
      "Secure randomness is unavailable. Run the app over HTTPS (secure context) to generate keys.",
    );
  }
  return api;
}

function getSubtle(): SubtleCrypto {
  const api = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (!api || !api.subtle) {
    throw new Error(
      "WebCrypto is unavailable. Run the app over HTTPS (secure context) to use encrypted backups.",
    );
  }
  return api.subtle;
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  getSecureRandom().getRandomValues(out);
  return out;
}

/** Unbiased random string: rejection sampling, so every character is uniform. */
function randomFromAlphabet(alphabet: string, length: number): string {
  const api = getSecureRandom();
  // Largest multiple of the alphabet size that fits in 2^32.
  const limit = 0x1_0000_0000 - (0x1_0000_0000 % alphabet.length);
  let out = "";
  while (out.length < length) {
    const buf = new Uint32Array(Math.max(16, length));
    api.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < length; i++) {
      const v = buf[i] ?? 0;
      if (v >= limit) continue; // drop biased values
      out += alphabet[v % alphabet.length];
    }
  }
  return out;
}

/* ---------- key generation / validation ---------- */

function isKeyAlphabet(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (!KEY_ALPHABET.includes(s[i] ?? "")) return false;
  }
  return s.length > 0;
}

function groupNewKey(raw: string): string {
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
}

/**
 * Generates a 100-bit permanent access key formatted as
 * `XXXXX-XXXXX-XXXXX-XXXXX` (e.g. `A1B2C-D3E4F-5G6H7-J8K9M`).
 * Throws when secure randomness is unavailable (fail closed).
 */
export function generatePermanentAccessKey(): string {
  return groupNewKey(randomFromAlphabet(KEY_ALPHABET, NEW_KEY_LENGTH));
}

/** "v2" for 20-char keys, "v1" for legacy numeric keys. */
function keyShape(cleanKey: string): "v2" | "v1" {
  const bare = cleanKey.replace(/-/g, "");
  return bare.length === NEW_KEY_LENGTH && isKeyAlphabet(bare) ? "v2" : "v1";
}

/**
 * Formats and validates a permanent access key or token.
 * Accepts v2 20-char keys and legacy 8–12 digit keys.
 */
export function validatePermanentAccessKey(input: string): {
  valid: boolean;
  error?: string;
  cleanKey: string;
} {
  if (!input || typeof input !== "string") {
    return { valid: false, error: "Please enter a valid permanent access key.", cleanKey: "" };
  }

  const clean = input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  // v2: exactly 20 Crockford-base32 characters
  if (clean.length === NEW_KEY_LENGTH && isKeyAlphabet(clean)) {
    return { valid: true, cleanKey: groupNewKey(clean) };
  }

  // v1 legacy: 8–12 decimal digits (existing installs)
  if (/^\d{8,12}$/.test(clean)) {
    const formatted =
      clean.length === 12
        ? `${clean.slice(0, 4)}-${clean.slice(4, 8)}-${clean.slice(8, 12)}`
        : clean;
    return { valid: true, cleanKey: formatted };
  }

  return {
    valid: false,
    error: "Access key must be 20 characters (XXXXX-XXXXX-XXXXX-XXXXX) or a legacy 12-digit key.",
    cleanKey: clean,
  };
}

/** True when the string is a plausible access key (v1 or v2). */
export function looksLikeAccessKey(input: string): boolean {
  return validatePermanentAccessKey(input).valid;
}

/**
 * Fast synchronous FNV-1a hash for deterministic identity derivation.
 * Only used to SHAPE the public display ID — it is not a security control
 * (the identity's real strength comes from the 100-bit key above).
 */
function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}

const ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Deterministically derives a user ID from a permanent access key.
 * Guaranteed to derive the exact same ID on any device or browser.
 *
 * - Legacy 12-digit keys keep the original `MAMA-XXXX-EYXX` shape, hashed
 *   byte-for-byte identically to before, so existing identities never change.
 * - v2 keys derive a wider `MAMA-XXXXXX-EYXXXX` shape (~2^39.6 IDs) so two
 *   different keys almost never collide onto one identity.
 */
export function deriveUserIdFromAccessKey(key: string): string {
  const { valid, cleanKey } = validatePermanentAccessKey(key);
  if (!valid) {
    throw new Error("Invalid permanent access key");
  }

  const h1 = fnv1aHash(cleanKey);
  const h2 = fnv1aHash(cleanKey + "-salt-heymamaey-v2");

  if (keyShape(cleanKey) === "v2") {
    const numPart = String(100000 + (h1 % 900000)); // 6 digits e.g. 849217
    const c1 = ID_CHARS[h2 % ID_CHARS.length] ?? "A";
    const c2 = ID_CHARS[Math.floor(h2 / ID_CHARS.length) % ID_CHARS.length] ?? "A";
    const c3 = ID_CHARS[(h2 >>> 10) % ID_CHARS.length] ?? "A";
    const c4 = ID_CHARS[(h2 >>> 15) % ID_CHARS.length] ?? "A";
    return `MAMA-${numPart}-EY${c1}${c2}${c3}${c4}`;
  }

  const numPart = String(1000 + (h1 % 9000)); // 4 digits e.g. 8492
  const char1 = ID_CHARS[h2 % ID_CHARS.length] ?? "A";
  const char2 = ID_CHARS[Math.floor(h2 / ID_CHARS.length) % ID_CHARS.length] ?? "A";
  return `MAMA-${numPart}-EY${char1}${char2}`;
}

/* ---------- backup payload types ---------- */

export type ContactPayload = {
  id: string;
  nickname: string;
  spaceCode?: string;
  keyprint?: string;
};

/** Device identity private key (JWK) — same trust root as the access key. */
export type IdentityKeyPayload = {
  kty: string;
  crv: string;
  x: string;
  y: string;
  d: string;
};

export type AccessKeyPayload = {
  key: string;
  userId: string;
  displayName: string;
  codes: string[];
  contacts?: ContactPayload[];
  idk?: IdentityKeyPayload;
};

export type ParsedBackup = {
  key: string;
  userId: string;
  displayName?: string;
  codes?: string[];
  contacts?: ContactPayload[];
  idk?: IdentityKeyPayload;
  /** Human-readable failure (e.g. v2 token without its access key). */
  error?: string;
};

/* ---------- base64url helpers ---------- */

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function deriveBackupKey(accessKey: string, salt: Uint8Array): Promise<CryptoKey> {
  const subtle = getSubtle();
  const base = await subtle.importKey(
    "raw",
    utf8(accessKey.trim().toUpperCase()),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/* ---------- backup creation (v2: encrypted) ---------- */

/**
 * Encodes the full user profile & joined spaces into a portable, ENCRYPTED
 * access token. The token itself no longer contains the access key: restoring
 * requires the access key separately, so a leaked token alone is useless.
 */
export async function createFullBackupPayload(
  key: string,
  displayName: string,
  codes: string[],
  contacts?: ContactPayload[],
  idk?: IdentityKeyPayload,
): Promise<string> {
  const { valid, cleanKey } = validatePermanentAccessKey(key);
  if (!valid) throw new Error("Invalid permanent access key");
  const userId = deriveUserIdFromAccessKey(cleanKey);

  const data: AccessKeyPayload = {
    key: cleanKey,
    userId,
    displayName: displayName || "You",
    codes: codes || [],
    ...(contacts && contacts.length > 0 && { contacts: contacts.slice(0, 200) }),
    ...(idk && idk.kty === "EC" && idk.crv === "P-256" && idk.d && { idk }),
  };

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const aesKey = await deriveBackupKey(cleanKey, salt);
  const ciphertext = await getSubtle().encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    aesKey,
    utf8(JSON.stringify(data)),
  );
  return `${BACKUP_V2_PREFIX}${b64urlFromBytes(salt)}.${b64urlFromBytes(iv)}.${b64urlFromBytes(
    new Uint8Array(ciphertext),
  )}`;
}

/** True when the pasted string is a backup token (v1 plaintext or v2 encrypted). */
export function isBackupToken(input: string): boolean {
  const s = (input ?? "").trim();
  return (
    s.startsWith(BACKUP_V2_PREFIX) ||
    s.startsWith(BACKUP_V1_PREFIX) ||
    s.startsWith(BACKUP_V1_ALT_PREFIX)
  );
}

function parseContactsList(raw: unknown): ContactPayload[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleanList: ContactPayload[] = [];
  for (const entry of raw.slice(0, 200)) {
    const r = entry as Partial<ContactPayload>;
    const id = String(r.id ?? "")
      .trim()
      .toUpperCase();
    const nickname = String(r.nickname ?? "")
      .trim()
      .slice(0, 40);
    if (id.length < 3 || id.length > 64 || !nickname) continue;
    const spaceCode =
      typeof r.spaceCode === "string" && r.spaceCode.trim() ? r.spaceCode.trim() : undefined;
    const keyprint =
      typeof r.keyprint === "string" && /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/.test(r.keyprint)
        ? r.keyprint
        : undefined;
    cleanList.push({
      id,
      nickname,
      ...(spaceCode !== undefined && { spaceCode }),
      ...(keyprint !== undefined && { keyprint }),
    });
  }
  return cleanList.length > 0 ? cleanList : undefined;
}

function parseIdk(raw: unknown): IdentityKeyPayload | undefined {
  const rawIdk = raw as Partial<IdentityKeyPayload> | undefined;
  if (
    rawIdk &&
    rawIdk.kty === "EC" &&
    rawIdk.crv === "P-256" &&
    typeof rawIdk.x === "string" &&
    typeof rawIdk.y === "string" &&
    typeof rawIdk.d === "string"
  ) {
    return { kty: "EC", crv: "P-256", x: rawIdk.x, y: rawIdk.y, d: rawIdk.d };
  }
  return undefined;
}

/**
 * Parses user input: a v2 encrypted token (requires `accessKey`),
 * a legacy plaintext token, or a bare access key.
 * Never throws — failures come back as `error`.
 */
export async function parseBackupInput(input: string, accessKey?: string): Promise<ParsedBackup> {
  const clean = (input ?? "").trim();

  /* ---- v2: encrypted token, needs the access key supplied separately ---- */
  if (clean.startsWith(BACKUP_V2_PREFIX)) {
    const providedKey = (accessKey ?? "").trim();
    const validation = validatePermanentAccessKey(providedKey);
    if (!validation.valid) {
      return {
        key: "",
        userId: "",
        error:
          "This is an encrypted backup. Paste your permanent access key in the first field, then the backup token in the second.",
      };
    }
    const parts = clean.slice(BACKUP_V2_PREFIX.length).split(".");
    if (parts.length !== 3 || parts.some((p) => !p)) {
      return { key: "", userId: "", error: "This backup token is damaged or truncated." };
    }
    try {
      const salt = bytesFromB64url(parts[0] as string);
      const iv = bytesFromB64url(parts[1] as string);
      const ct = bytesFromB64url(parts[2] as string);
      const aesKey = await deriveBackupKey(validation.cleanKey, salt);
      const plain = await getSubtle().decrypt(
        { name: "AES-GCM", iv: iv as unknown as BufferSource },
        aesKey,
        ct as unknown as BufferSource,
      );
      const parsed = JSON.parse(decodeUtf8(new Uint8Array(plain))) as {
        key?: string;
        displayName?: string;
        codes?: string[];
        contacts?: unknown;
        idk?: unknown;
      };
      const secretKey = parsed.key || validation.cleanKey;
      const contacts = parseContactsList(parsed.contacts);
      const idk = parseIdk(parsed.idk);
      return {
        key: validation.cleanKey,
        userId: deriveUserIdFromAccessKey(secretKey),
        ...(parsed.displayName !== undefined && { displayName: parsed.displayName }),
        ...(Array.isArray(parsed.codes) && { codes: parsed.codes.map(String).slice(0, 500) }),
        ...(contacts !== undefined && { contacts }),
        ...(idk !== undefined && { idk }),
      };
    } catch {
      return {
        key: "",
        userId: "",
        error:
          "Couldn't unlock this backup — check that the access key matches the one used to create it.",
      };
    }
  }

  /* ---- v1: legacy plaintext token (self-contained) ---- */
  if (clean.startsWith(BACKUP_V1_PREFIX) || clean.startsWith(BACKUP_V1_ALT_PREFIX)) {
    try {
      const prefix = clean.startsWith(BACKUP_V1_PREFIX) ? BACKUP_V1_PREFIX : BACKUP_V1_ALT_PREFIX;
      const jsonStr = decodeURIComponent(escape(atob(clean.slice(prefix.length))));
      const parsed = JSON.parse(jsonStr) as {
        key?: string;
        phrase?: string;
        displayName?: string;
        codes?: string[];
        contacts?: unknown;
        idk?: unknown;
      };
      const secretKey = parsed.key || parsed.phrase;
      if (secretKey) {
        const validation = validatePermanentAccessKey(secretKey);
        if (!validation.valid) {
          return { key: "", userId: "", error: validation.error ?? "Invalid permanent access key" };
        }
        const contacts = parseContactsList(parsed.contacts);
        const idk = parseIdk(parsed.idk);
        return {
          key: validation.cleanKey,
          userId: deriveUserIdFromAccessKey(validation.cleanKey),
          ...(parsed.displayName !== undefined && { displayName: parsed.displayName }),
          ...(Array.isArray(parsed.codes) && { codes: parsed.codes.map(String).slice(0, 500) }),
          ...(contacts !== undefined && { contacts }),
          ...(idk !== undefined && { idk }),
        };
      }
      return { key: "", userId: "", error: "This legacy backup contains no access key." };
    } catch {
      return { key: "", userId: "", error: "This backup token is damaged or truncated." };
    }
  }

  /* ---- bare key (optionally paired with a token in the other field) ---- */
  const primary = validatePermanentAccessKey(clean);
  if (primary.valid) {
    return { key: primary.cleanKey, userId: deriveUserIdFromAccessKey(primary.cleanKey) };
  }

  // A token was pasted where a key belongs (or vice versa) — guide the user.
  if (isBackupToken(clean)) {
    return {
      key: "",
      userId: "",
      error:
        "Backup token detected — paste it in the second field and your access key in the first.",
    };
  }

  return { key: "", userId: "", error: primary.error ?? "Invalid permanent access key" };
}
