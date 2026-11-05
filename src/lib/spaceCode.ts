// Secure Space codes: long alphanumeric tokens (no ambiguous 0/O, 1/I).
// New format: XXXX-XXXX-XXXX (12 chars, ~32^12 combinations).
// Legacy numeric codes (XXX-XXX, XXXX-XXXX) remain joinable.

export const SPACE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateSecureSpaceCode(): string {
  const pick = (n: number): string => {
    // Fail closed: a join code is a credential, so never fall back to
    // Math.random — it is predictable and would make codes guessable.
    const api = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
    if (!api || typeof api.getRandomValues !== "function") {
      throw new Error(
        "Secure randomness is unavailable. Run the app over HTTPS (secure context) to create spaces.",
      );
    }
    const buf = new Uint32Array(n);
    api.getRandomValues(buf);
    let out = "";
    for (let i = 0; i < n; i++) {
      out += SPACE_ALPHABET[(buf[i] ?? 0) % SPACE_ALPHABET.length];
    }
    return out;
  };
  const raw = pick(12);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

/** Strip separators, uppercase. Keeps A-Z + 2-9 only. */
export function cleanSpaceCode(input: string): string {
  return (input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Normalize user input to canonical display form, or null when invalid. */
export function normalizeSpaceCode(input: string): string | null {
  const clean = cleanSpaceCode(input);
  if (/^[0-9]{6}$/.test(clean)) return `${clean.slice(0, 3)}-${clean.slice(3)}`;
  if (/^[0-9]{8}$/.test(clean)) return `${clean.slice(0, 4)}-${clean.slice(4)}`;
  if (/^[A-Z2-9]{12}$/.test(clean)) {
    // Reject pure-numeric 12-char strings (not an issued format).
    if (/^[0-9]{12}$/.test(clean)) return null;
    return `${clean.slice(0, 4)}-${clean.slice(4, 8)}-${clean.slice(8, 12)}`;
  }
  return null;
}

export function isValidSpaceCode(input: string): boolean {
  return normalizeSpaceCode(input) !== null;
}
