// Permanent Secret Access Key Module for Cross-Device Data Access & Identity Sync

/**
 * Generates a clean 12-digit permanent numeric access key formatted as `XXXX-XXXX-XXXX`
 * (e.g. `8492-3841-9021`)
 */
export function generatePermanentAccessKey(): string {
  const digits: number[] = [];
  if (typeof window !== "undefined" && window.crypto && window.crypto.getRandomValues) {
    const arr = new Uint32Array(12);
    window.crypto.getRandomValues(arr);
    for (let i = 0; i < 12; i++) {
      const val = arr[i] ?? 0;
      digits.push(val % 10);
    }
  } else {
    for (let i = 0; i < 12; i++) {
      digits.push(Math.floor(Math.random() * 10));
    }
  }
  const str = digits.join("");
  return `${str.slice(0, 4)}-${str.slice(4, 8)}-${str.slice(8, 12)}`;
}

/**
 * Formats and validates a permanent access key or token
 */
export function validatePermanentAccessKey(input: string): {
  valid: boolean;
  error?: string;
  cleanKey: string;
} {
  if (!input || typeof input !== "string") {
    return { valid: false, error: "Please enter a valid permanent access key.", cleanKey: "" };
  }

  // Remove non-alphanumeric characters for clean parsing
  const clean = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length < 8) {
    return {
      valid: false,
      error: "Permanent access key must be at least 8 digits/characters long.",
      cleanKey: clean,
    };
  }

  // Format as XXXX-XXXX-XXXX if 12 digits
  let formatted = clean;
  if (clean.length === 12) {
    formatted = `${clean.slice(0, 4)}-${clean.slice(4, 8)}-${clean.slice(8, 12)}`;
  }

  return { valid: true, cleanKey: formatted };
}

/**
 * Fast synchronous FNV-1a hash for deterministic identity derivation
 */
function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}

/**
 * Deterministically derives a user ID (`MAMA-XXXX-EYYY`) from a permanent access key.
 * Guaranteed to derive the exact same ID on any device or browser!
 */
export function deriveUserIdFromAccessKey(key: string): string {
  const { valid, cleanKey } = validatePermanentAccessKey(key);
  if (!valid) {
    throw new Error("Invalid permanent access key");
  }

  const h1 = fnv1aHash(cleanKey);
  const h2 = fnv1aHash(cleanKey + "-salt-heymamaey-v2");

  const numPart = String(1000 + (h1 % 9000)); // 4 digits e.g. 8492
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const char1 = chars[h2 % chars.length];
  const char2 = chars[Math.floor(h2 / chars.length) % chars.length];

  return `MAMA-${numPart}-EY${char1}${char2}`;
}

/**
 * Full Backup Payload structure
 */
export type AccessKeyPayload = {
  key: string;
  userId: string;
  displayName: string;
  codes: string[];
};

/**
 * Encodes full user profile & joined spaces into a portable access token string
 */
export function createFullBackupPayload(key: string, displayName: string, codes: string[]): string {
  const userId = deriveUserIdFromAccessKey(key);
  const data: AccessKeyPayload = {
    key,
    userId,
    displayName: displayName || "You",
    codes: codes || [],
  };
  try {
    return "HEYMAMA_KEY_" + btoa(unescape(encodeURIComponent(JSON.stringify(data))));
  } catch {
    return key;
  }
}

/**
 * Parses user input (which can be a permanent key string or full backup token)
 */
export function parseBackupInput(input: string): {
  key: string;
  userId: string;
  displayName?: string;
  codes?: string[];
} {
  const clean = input.trim();
  if (clean.startsWith("HEYMAMA_KEY_") || clean.startsWith("HEYMAMA_BACKUP_")) {
    try {
      const prefix = clean.startsWith("HEYMAMA_KEY_") ? "HEYMAMA_KEY_" : "HEYMAMA_BACKUP_";
      const rawB64 = clean.slice(prefix.length);
      const jsonStr = decodeURIComponent(escape(atob(rawB64)));
      const parsed = JSON.parse(jsonStr) as { key?: string; phrase?: string; displayName?: string; codes?: string[] };
      const secretKey = parsed.key || parsed.phrase;
      if (secretKey) {
        const userId = deriveUserIdFromAccessKey(secretKey);
        return {
          key: secretKey,
          userId,
          ...(parsed.displayName !== undefined && { displayName: parsed.displayName }),
          ...(parsed.codes !== undefined && { codes: parsed.codes }),
        };
      }
    } catch {
      // fallback
    }
  }

  const userId = deriveUserIdFromAccessKey(clean);
  return { key: clean, userId };
}
