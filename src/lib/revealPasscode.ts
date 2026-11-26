// Device-level passcode that gates REVEALING the Permanent Secret Access Key.
//
// What this is: a UI guard. The Settings modal will not show or copy the key
// until the passcode is entered, so an unlocked device handed to someone else
// can't casually reveal it.
//
// What this is NOT: storage encryption. The key still lives in plaintext in
// `heymamaey.prefs.v2` because hydrate() must restore the identity at startup
// with no prompt — encrypting it would turn this into a full app lock (a
// different, much larger feature). Only a salted PBKDF2 hash of the passcode
// is stored, so the passcode itself is never recoverable from localStorage.

const STORE_KEY = "heymamaey.revealPass.v1";
const ITERATIONS = 150_000;
const enc = new TextEncoder();

type Stored = { v: 1; salt: string; hash: string };

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** PBKDF2-SHA256 of the passcode under a per-device random salt. */
async function derive(passcode: string, salt: Uint8Array): Promise<string> {
  const base = await crypto.subtle.importKey("raw", enc.encode(passcode), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    base,
    256,
  );
  return toB64(new Uint8Array(bits));
}

/** True once a reveal passcode has been chosen on this device. */
export function hasRevealPasscode(): boolean {
  try {
    return Boolean(localStorage.getItem(STORE_KEY));
  } catch {
    return false;
  }
}

/** Passcode rules: same 4–64 range as room passwords. */
export function validateRevealPasscode(passcode: string): string | null {
  const len = passcode.trim().length;
  if (len < 4) return "Passcode must be at least 4 characters.";
  if (len > 64) return "Passcode must be 64 characters or fewer.";
  return null;
}

/** Creates (or replaces) the reveal passcode. Only the hash is stored. */
export async function setRevealPasscode(passcode: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const stored: Stored = { v: 1, salt: toB64(salt), hash: await derive(passcode, salt) };
  localStorage.setItem(STORE_KEY, JSON.stringify(stored));
  failStreak = 0;
}

// Wrong-attempt backoff: each failure doubles the wait before the next try
// (1s, 2s, 4s … capped at 8s), so hammering the prompt from the UI is slow.
// Tracked in memory only — a reload resets it, which is fine: the gate's job
// is to stop casual reveal, not to survive an attacker with the console.
let failStreak = 0;
let lastFailAt = 0;

/** Verifies the passcode; on failure, arms an exponentially longer retry wait. */
export async function verifyRevealPasscode(passcode: string): Promise<boolean> {
  let stored: Stored | null = null;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    stored = raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    stored = null;
  }
  if (!stored?.salt || !stored?.hash) return false;

  if (failStreak > 0) {
    const wait = Math.min(1000 * 2 ** (failStreak - 1), 8000);
    const since = Date.now() - lastFailAt;
    if (since < wait) await new Promise((r) => setTimeout(r, wait - since));
  }

  const ok = (await derive(passcode, fromB64(stored.salt))) === stored.hash;
  if (ok) {
    failStreak = 0;
  } else {
    failStreak += 1;
    lastFailAt = Date.now();
  }
  return ok;
}

/** Removes the passcode (forgot-passcode recovery on this device). */
export function clearRevealPasscode(): void {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* nothing to clear */
  }
  failStreak = 0;
}
