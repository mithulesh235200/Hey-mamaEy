/**
 * Client-side upload validation: strict extension + MIME whitelisting with
 * magic-byte (file signature) verification.
 *
 * Why this exists: `File.type` and file names are attacker-controlled, and the
 * Supabase anon key ships in the client — so the app must refuse dangerous
 * payloads (executables, scripts, HTML/SVG that run as our storage origin)
 * BEFORE they reach the storage bucket. Server-side bucket policies
 * (see supabase/migrations/20261014000000_space_media_hardening.sql) are the
 * second layer; true virus scanning still needs a server-side scanner.
 */

export type AllowedKind = "image" | "video" | "audio" | "file";

export type FileVerdict =
  | { ok: true; kind: AllowedKind; safeName: string; mime: string }
  | { ok: false; error: string };

const MB = 1024 * 1024;

/** Absolute ceiling for any single server upload (matches ChatPanel MAX_BYTES). */
export const MAX_UPLOAD_BYTES = 20 * MB;

/** Per-kind caps so one file can't eat disproportionate quota. */
export const PER_KIND_MAX_BYTES: Record<AllowedKind, number> = {
  image: 10 * MB,
  video: 20 * MB,
  audio: 10 * MB,
  file: 10 * MB,
};

type ExtRule = { kind: AllowedKind; mimes: string[] };

/** Allowed extensions (lowercase, no dot) with their accepted MIME types. */
const EXT_RULES: Record<string, ExtRule> = {
  // Images (browser-renderable raster formats only — no SVG, no AVIF/HEIC).
  jpg: { kind: "image", mimes: ["image/jpeg"] },
  jpeg: { kind: "image", mimes: ["image/jpeg"] },
  png: { kind: "image", mimes: ["image/png"] },
  gif: { kind: "image", mimes: ["image/gif"] },
  webp: { kind: "image", mimes: ["image/webp"] },
  // Video (broadly playable, no QuickTime/Matroska edge cases).
  // NOTE: audio-only WebM (voice notes) shares the .webm container, so
  // audio/webm is accepted here too and categorized by the caller.
  mp4: { kind: "video", mimes: ["video/mp4", "application/mp4"] },
  webm: { kind: "video", mimes: ["video/webm", "audio/webm"] },
  // Audio (voice notes + shared clips).
  mp3: { kind: "audio", mimes: ["audio/mpeg", "audio/mp3"] },
  wav: { kind: "audio", mimes: ["audio/wav", "audio/x-wav", "audio/wave"] },
  ogg: { kind: "audio", mimes: ["audio/ogg"] },
  oga: { kind: "audio", mimes: ["audio/ogg"] },
  m4a: { kind: "audio", mimes: ["audio/mp4", "audio/x-m4a", "audio/aac"] },
  // Documents / archives.
  pdf: { kind: "file", mimes: ["application/pdf"] },
  txt: { kind: "file", mimes: ["text/plain"] },
  md: { kind: "file", mimes: ["text/markdown", "text/plain", "text/x-markdown"] },
  csv: { kind: "file", mimes: ["text/csv", "application/csv", "text/plain"] },
  doc: { kind: "file", mimes: ["application/msword"] },
  docx: {
    kind: "file",
    mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  },
  xls: { kind: "file", mimes: ["application/vnd.ms-excel"] },
  xlsx: {
    kind: "file",
    mimes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  },
  ppt: { kind: "file", mimes: ["application/vnd.ms-powerpoint"] },
  pptx: {
    kind: "file",
    mimes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  },
  zip: { kind: "file", mimes: ["application/zip", "application/x-zip-compressed"] },
};

/**
 * Never allowed — checked against EVERY dot-segment so `photo.jpg.exe`,
 * `notes.pdf.html` and `song.mp3.js` are all rejected.
 */
const DENY_EXT = new Set([
  "html", "htm", "xhtml", "shtml", "svg", "svgz",
  "js", "mjs", "cjs", "jsx", "tsx", "ts", "jsonp",
  "exe", "dll", "msi", "bat", "cmd", "com", "scr", "pif",
  "ps1", "vbs", "vbe", "jse", "wsf", "wsh", "jar", "apk",
  "aab", "ipa", "iso", "dmg", "img", "swf", "php", "phtml",
  "phar", "py", "pyc", "rb", "pl", "sh", "bash", "zsh",
  "lnk", "url", "scf", "hta", "gadget", "msc", "reg",
]);

export function formatUploadBytes(bytes = 0): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function sanitizeBaseName(name: string): string {
  const base = (name.split(/[\\/]/).pop() || "file").trim() || "file";
  return base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "file";
}

function normalizeMime(mime: string): string {
  return (mime || "").split(";")[0]?.trim().toLowerCase() ?? "";
}

async function readHead(file: Blob, bytes: number): Promise<Uint8Array> {
  const buf = await file.slice(0, bytes).arrayBuffer();
  return new Uint8Array(buf);
}

function startsWith(head: Uint8Array, sig: number[]): boolean {
  if (head.length < sig.length) return false;
  return sig.every((b, i) => head[i] === b);
}

function asciiAt(head: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = offset; i < Math.min(head.length, offset + length); i++) {
    out += String.fromCharCode(head[i] ?? 0);
  }
  return out;
}

/** Verify magic bytes for the claimed extension. Text formats get a
 *  markup/executable sniff instead of a fixed signature. */
function magicOk(ext: string, head: Uint8Array, fullTextHead?: string): boolean {
  switch (ext) {
    case "jpg":
    case "jpeg":
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case "png":
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "gif":
      return asciiAt(head, 0, 4) === "GIF8";
    case "webp":
      return asciiAt(head, 0, 4) === "RIFF" && asciiAt(head, 8, 4) === "WEBP";
    case "mp4":
    case "m4a":
      // ftyp box at offset 4 (e.g. isom, mp41, M4A …).
      return asciiAt(head, 4, 4) === "ftyp";
    case "webm":
      return startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]);
    case "mp3":
      return asciiAt(head, 0, 3) === "ID3" || (head[0] === 0xff && (head[1] ?? 0) >= 0xe0);
    case "wav":
      return asciiAt(head, 0, 4) === "RIFF" && asciiAt(head, 8, 4) === "WAVE";
    case "ogg":
    case "oga":
      return asciiAt(head, 0, 4) === "OggS";
    case "pdf":
      return asciiAt(head, 0, 4) === "%PDF";
    case "zip":
    case "docx":
    case "xlsx":
    case "pptx":
      return startsWith(head, [0x50, 0x4b, 0x03, 0x04]);
    case "doc":
    case "xls":
    case "ppt":
      return startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case "txt":
    case "md":
    case "csv": {
      // Reject executables / markup masquerading as text: MZ/ELF/zip/OLE
      // headers, or a document that OPENS with an HTML/SVG/XML tag.
      if (startsWith(head, [0x4d, 0x5a])) return false; // MZ
      if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return false; // ELF
      if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return false; // ZIP
      const text = (fullTextHead ?? "").replace(/^\uFEFF/, "").trimStart().slice(0, 200);
      if (/^<!doctype\s+html/i.test(text)) return false;
      if (/^<(html|svg|script|iframe|object|embed|link|meta|xml)[\s>]/i.test(text)) return false;
      if (/^<\?xml/i.test(text)) return false;
      return true;
    }
    default:
      return false;
  }
}

/**
 * Validates a user-supplied file before upload/sharing. Returns the canonical
 * kind, a sanitized name, and the canonical MIME to store (never the raw
 * client-claimed content type).
 */
export async function validateUserFile(
  file: Blob,
  fileName: string,
  claimedType = "",
): Promise<FileVerdict> {
  const size = file.size ?? 0;
  if (!size || size <= 0) return { ok: false, error: "That file is empty." };
  if (size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `File is too large (${formatUploadBytes(size)}). Keep uploads under ${formatUploadBytes(MAX_UPLOAD_BYTES)}.`,
    };
  }

  const safeName = sanitizeBaseName(fileName);
  const segments = safeName.toLowerCase().split(".");
  if (segments.length < 2 || !segments[segments.length - 1]) {
    return { ok: false, error: "Files need a supported extension (e.g. .jpg, .mp4, .pdf)." };
  }
  // Every dot-segment is checked: blocks photo.jpg.exe and notes.pdf.html.
  const badSegment = segments.slice(1).find((seg) => DENY_EXT.has(seg));
  if (badSegment) {
    return { ok: false, error: `Files of type .${badSegment} are not allowed for safety.` };
  }
  const ext = segments[segments.length - 1] as string;
  const rule = EXT_RULES[ext];
  if (!rule) {
    return { ok: false, error: `Files of type .${ext} are not supported.` };
  }

  const claimed = normalizeMime(claimedType);
  if (claimed && !rule.mimes.includes(claimed)) {
    return {
      ok: false,
      error: `That .${ext} file reports an unexpected type (${claimed || "unknown"}) and was blocked.`,
    };
  }

  const cap = PER_KIND_MAX_BYTES[rule.kind];
  if (size > cap) {
    return {
      ok: false,
      error: `That ${rule.kind} is ${formatUploadBytes(size)} — the ${rule.kind} limit is ${formatUploadBytes(cap)}.`,
    };
  }

  // Magic-byte verification (catches renamed .exe/.html payloads).
  try {
    const needsText = ext === "txt" || ext === "md" || ext === "csv";
    const head = await readHead(file, needsText ? 4096 : 16);
    let textHead: string | undefined;
    if (needsText) {
      try {
        textHead = new TextDecoder("utf-8", { fatal: false }).decode(head.slice(0, 4096));
      } catch {
        textHead = "";
      }
    }
    if (!magicOk(ext, head, textHead)) {
      return {
        ok: false,
        error: `That file's contents don't match its .${ext} extension — it was blocked for safety.`,
      };
    }
  } catch {
    return { ok: false, error: "Couldn't read that file for safety checks." };
  }

  // Canonical MIME (first listed) — never store the client-claimed type.
  const mime = rule.mimes[0] as string;
  return { ok: true, kind: rule.kind, safeName, mime };
}

/** Picker-level filters (convenience only — validation above is the real gate). */
export const ACCEPT_IMAGE_VIDEO =
  "image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,.jpg,.jpeg,.png,.gif,.webp,.mp4,.webm";
export const ACCEPT_AUDIO =
  "audio/mpeg,audio/wav,audio/x-wav,audio/ogg,audio/webm,audio/mp4,audio/x-m4a,.mp3,.wav,.ogg,.oga,.webm,.m4a";
export const ACCEPT_DOCUMENT =
  ".pdf,.txt,.md,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip";
