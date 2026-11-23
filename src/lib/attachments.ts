// Supabase Storage uploads for chat attachments.
// Falls back to base64 data URLs when Storage is unavailable so the app
// keeps working before the space-media migration is applied.
import { supabase } from "@/integrations/supabase/client";
import { validateUserFile } from "./fileValidation";

const BUCKET = "space-media";

function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() || "file";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
}

function randomId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Uploads a blob to the space-media bucket. Returns the public URL,
 * or null when the file is rejected by safety validation or Storage is
 * unavailable (caller should use base64 fallback ONLY for validated files).
 *
 * Defense in depth: the file is re-validated here (extension + MIME +
 * magic bytes) and stored with the CANONICAL mime — never the raw
 * client-claimed content type — so a renamed .exe can't be served back as
 * image/png, and HTML/SVG can't be stored at all.
 */
export async function uploadAttachment(
  spaceCode: string,
  blob: Blob,
  fileName: string,
  mimeType: string,
): Promise<string | null> {
  try {
    const verdict = await validateUserFile(blob, fileName, mimeType);
    if (!verdict.ok) return null;
    const safeCode = spaceCode.replace(/[^0-9a-zA-Z-]/g, "") || "shared";
    const path = `${safeCode}/${randomId()}-${sanitizeFileName(verdict.safeName)}`;
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, blob, { contentType: verdict.mime, upsert: false });
    if (error) return null;
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    return data.publicUrl || null;
  } catch {
    return null;
  }
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob | null> {
  try {
    const res = await fetch(dataUrl);
    return await res.blob();
  } catch {
    return null;
  }
}

function sanitizeDownloadName(name: string, fallback: string): string {
  const clean = (name || "").split(/[\\/]/).pop()?.trim() || fallback;
  return clean.slice(0, 120) || fallback;
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = fileName;
  // Required for Firefox + mobile browsers.
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after the browser has picked up the download.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
}

/**
 * True only on phones / Capacitor native app. Desktop browsers (Windows,
 * macOS, Linux — like the screenshot's Windows Share sheet) must NEVER use
 * navigator.share: it pops a share dialog instead of saving to Downloads.
 */
function shouldUseShareSheet(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  try {
    const ua = navigator.userAgent || "";
    // Capacitor native app (Android WebView) — UA can look desktop-ish.
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
      ?.Capacitor;
    if (typeof cap?.isNativePlatform === "function" && cap.isNativePlatform()) return true;
    // Real mobile devices only.
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return true;
    if (navigator.maxTouchPoints > 2 && /Mobile/i.test(ua)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Fetch a remote file's bytes with one retry: transient network blips are
 * the most common reason a save falls back to "opened in a new tab", while
 * 4xx (object pruned/gone) never heals and fails fast with the real status.
 */
async function fetchBytes(url: string, attempts = 2): Promise<Response> {
  let lastErr: unknown = new Error("Download failed");
  for (let i = 0; i < attempts; i++) {
    let res: Response;
    try {
      res = await fetch(url, { mode: "cors" });
    } catch (e) {
      lastErr = e; // network / CORS — worth one retry
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 600));
      continue;
    }
    if (res.ok) return res;
    const statusErr = new Error(`Download failed (HTTP ${res.status})`) as Error & {
      status?: number;
    };
    statusErr.status = res.status;
    if (res.status >= 400 && res.status < 500) throw statusErr; // permanent
    lastErr = statusErr; // 5xx — retry
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 600));
  }
  throw lastErr;
}

/**
 * Saves a remote (Supabase Storage) or inline data: URL to the device's
 * local storage (Downloads folder on desktop, Downloads/Gallery on phones).
 *
 * Why this exists: a plain `<a href="<supabase-url>" download>` does NOT
 * save cross-origin files — browsers ignore the `download` attribute for a
 * different origin and just navigate/open the Supabase URL. Fetching the
 * bytes first and downloading a same-origin blob URL forces a real save.
 *
 * Works on desktop + mobile browsers with zero native plugins. Desktop
 * always uses a direct blob download (saves to Downloads). Only phones /
 * the Capacitor native app use the Web Share sheet (Save to Files/Photos).
 */
export async function saveAttachmentToDevice(
  url: string,
  fileName: string,
): Promise<{ ok: boolean; shared?: boolean; error?: string }> {
  if (typeof window === "undefined" || !url) return { ok: false, error: "No file URL" };
  const safeName = sanitizeDownloadName(fileName, `space-file-${Date.now()}`);

  try {
    // Inline base64 payloads (offline fallback): decode without a network hop.
    if (url.startsWith("data:")) {
      const blob = await dataUrlToBlob(url);
      if (!blob) return { ok: false, error: "Could not read file data" };
      triggerBlobDownload(blob, safeName);
      return { ok: true };
    }

    // Blob URLs created locally (P2P transfers, voice-note previews).
    if (url.startsWith("blob:")) {
      const blob = await dataUrlToBlob(url);
      if (blob) {
        triggerBlobDownload(blob, safeName);
        return { ok: true };
      }
      // The blob died with the page/session that created it — there is
      // nothing to recover (and downloading a 0-byte stub helps no one).
      return { ok: false, error: "This file's local copy expired — ask for it to be re-sent" };
    }

    // Remote Supabase Storage URL: fetch bytes (bucket is CORS-enabled),
    // then save as a same-origin blob so the browser honours the filename.
    const res = await fetchBytes(url);
    const blob = await res.blob();

    // On phones only, prefer the system share sheet so the user can
    // explicitly "Save to Files / Photos". Desktop skips this entirely —
    // navigator.share on Windows opens a Share dialog (your screenshot)
    // instead of saving to Downloads.
    if (shouldUseShareSheet()) {
      try {
        const nav = navigator as Navigator & {
          canShare?: (data: { files?: File[] }) => boolean;
          share?: (data: { files?: File[]; title?: string }) => Promise<void>;
        };
        const file = new File([blob], safeName, {
          type: blob.type || "application/octet-stream",
        });
        if (typeof nav.canShare === "function" && typeof nav.share === "function") {
          try {
            if (nav.canShare({ files: [file] })) {
              await nav.share({ files: [file], title: safeName });
              return { ok: true, shared: true };
            }
          } catch (shareErr) {
            // User dismissed the sheet = treat as done, don't error out.
            if (shareErr instanceof DOMException && shareErr.name === "AbortError") {
              return { ok: true, shared: true };
            }
            // Otherwise fall through to the anchor download below.
          }
        }
      } catch {
        /* share sheet unavailable — use anchor download */
      }
    }

    triggerBlobDownload(blob, safeName);
    return { ok: true };
  } catch (err) {
    // The object itself is gone (pruned / expired): say so instead of
    // pretending a save happened.
    const status = (err as { status?: number } | null)?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return {
        ok: false,
        error:
          status === 404 ? "This file is no longer available" : `Download failed (HTTP ${status})`,
      };
    }
    // Supabase Storage honours ?download=<filename> (Content-Disposition:
    // attachment) on a plain navigation — which works cross-origin even
    // when fetch() is blocked — turning the old "opened in a new tab,
    // right-click to save" dead-end into an actual save.
    if (/\/storage\/v1\//.test(url)) {
      try {
        const sep = url.includes("?") ? "&" : "?";
        window.open(
          `${url}${sep}download=${encodeURIComponent(safeName)}`,
          "_blank",
          "noopener,noreferrer",
        );
        return { ok: true };
      } catch {
        /* fall through to the generic fallback below */
      }
    }
    // Last resort: open the URL so the user can long-press / right-click save.
    try {
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Download failed",
    };
  }
}
