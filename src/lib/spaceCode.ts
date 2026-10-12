// Secure Space codes: long alphanumeric tokens (no ambiguous 0/O, 1/I).
// New format: XXXX-XXXX-XXXX (12 chars, ~32^12 combinations).
// Legacy numeric codes (XXX-XXX, XXXX-XXXX) remain joinable.

export const SPACE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateSecureSpaceCode(): string {
  const pick = (n: number): string => {
    let out = "";
    if (typeof window !== "undefined" && window.crypto?.getRandomValues) {
      const buf = new Uint32Array(n);
      window.crypto.getRandomValues(buf);
      for (let i = 0; i < n; i++) {
        const v = buf[i] ?? 0;
        out += SPACE_ALPHABET[v % SPACE_ALPHABET.length];
      }
      return out;
    }
    for (let i = 0; i < n; i++) {
      out += SPACE_ALPHABET[Math.floor(Math.random() * SPACE_ALPHABET.length)];
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
