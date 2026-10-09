// Supabase Storage uploads for chat attachments.
// Falls back to base64 data URLs when Storage is unavailable so the app
// keeps working before the space-media migration is applied.
import { supabase } from "@/integrations/supabase/client";

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
 * or null when Storage is unavailable (caller should use base64 fallback).
 */
export async function uploadAttachment(
  spaceCode: string,
  blob: Blob,
  fileName: string,
  mimeType: string,
): Promise<string | null> {
  try {
    const safeCode = spaceCode.replace(/[^0-9a-zA-Z-]/g, "") || "shared";
    const path = `${safeCode}/${randomId()}-${sanitizeFileName(fileName)}`;
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, blob, { contentType: mimeType || "application/octet-stream", upsert: false });
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
