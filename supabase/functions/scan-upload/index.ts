// Supabase Edge Function: scan-upload (layer 3 of the upload-security fix)
//
// Trigger: Storage webhook on storage.objects INSERT (bucket: space-media)
//   -> POST this function with the object record.
// Env secrets (supabase secrets set): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   and optionally VT_API_KEY (VirusTotal) for known-malware hash lookups.
//
// What it does:
//   1. Re-validates the object SERVER-side (extension whitelist + magic bytes
//      + size cap). Client checks can be bypassed by calling the Storage API
//      directly with the anon key — this cannot.
//   2. If VT_API_KEY is set, looks up the file's SHA-256 in VirusTotal and
//      deletes it on a malicious/suspicious verdict (known malware only).
//   3. Deletes the object on any failure verdict and reports why.
//
// What it does NOT do:
// - Full sandbox detonation / behavioral analysis of never-seen files. That
//   needs a dedicated AV provider with async callbacks (e.g. attachment-av).
//   Unknown files that pass static checks stay up with verdict "unscanned".
//
// Deploy:  supabase functions deploy scan-upload
// Webhook: Dashboard > Storage > Webhooks (or Database > Webhooks on
//   storage.objects) > INSERT, bucket filter = space-media, POST here.

const EXT_MIME: Record<string, string[]> = {
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  png: ["image/png"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  mp4: ["video/mp4", "application/mp4"],
  webm: ["video/webm", "audio/webm"],
  mp3: ["audio/mpeg", "audio/mp3"],
  wav: ["audio/wav", "audio/x-wav", "audio/wave"],
  ogg: ["audio/ogg"],
  oga: ["audio/ogg"],
  m4a: ["audio/mp4", "audio/x-m4a", "audio/aac"],
  pdf: ["application/pdf"],
  txt: ["text/plain"],
  md: ["text/markdown", "text/plain", "text/x-markdown"],
  csv: ["text/csv", "application/csv", "text/plain"],
  doc: ["application/msword"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xls: ["application/vnd.ms-excel"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ppt: ["application/vnd.ms-powerpoint"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  zip: ["application/zip", "application/x-zip-compressed"],
};

const DENY_EXT = new Set([
  "html", "htm", "xhtml", "shtml", "svg", "svgz",
  "js", "mjs", "cjs", "jsx", "tsx", "ts",
  "exe", "dll", "msi", "bat", "cmd", "com", "scr", "pif",
  "ps1", "vbs", "vbe", "jse", "wsf", "wsh", "jar", "apk",
  "aab", "ipa", "iso", "dmg", "img", "swf", "php", "phtml",
  "phar", "py", "pyc", "rb", "pl", "sh", "bash", "zsh",
  "lnk", "url", "scf", "hta", "msc", "reg",
]);

const MAX_BYTES = 20 * 1024 * 1024;

function startsWith(h: Uint8Array, s: number[]): boolean {
  return s.every((b, i) => h[i] === b);
}
function ascii(h: Uint8Array, o: number, n: number): string {
  let out = "";
  for (let i = o; i < Math.min(h.length, o + n); i++) out += String.fromCharCode(h[i] ?? 0);
  return out;
}

function magicOk(ext: string, head: Uint8Array, textHead: string): boolean {
  switch (ext) {
    case "jpg":
    case "jpeg":
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case "png":
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "gif":
      return ascii(head, 0, 4) === "GIF8";
    case "webp":
      return ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP";
    case "mp4":
    case "m4a":
      return ascii(head, 4, 4) === "ftyp";
    case "webm":
      return startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]);
    case "mp3":
      return ascii(head, 0, 3) === "ID3" || (head[0] === 0xff && (head[1] ?? 0) >= 0xe0);
    case "wav":
      return ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WAVE";
    case "ogg":
    case "oga":
      return ascii(head, 0, 4) === "OggS";
    case "pdf":
      return ascii(head, 0, 4) === "%PDF";
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
      if (startsWith(head, [0x4d, 0x5a])) return false;
      if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return false;
      if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return false;
      const t = textHead.replace(/^\uFEFF/, "").trimStart().slice(0, 200);
      if (/^<!doctype\s+html/i.test(t)) return false;
      if (/^<(html|svg|script|iframe|object|embed|link|meta|xml)[\s>]/i.test(t)) return false;
      if (/^<\?xml/i.test(t)) return false;
      return true;
    }
    default:
      return false;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Verdict = { clean: boolean; reasons: string[]; vtChecked: boolean };

async function virusTotalLookup(
  apiKey: string,
  sha256: string,
): Promise<{ checked: boolean; malicious: boolean; detail: string }> {
  try {
    const res = await fetch(`https://www.virustotal.com/api/v3/files/${sha256}`, {
      headers: { "x-apikey": apiKey },
    });
    if (res.status === 404) return { checked: true, malicious: false, detail: "hash unknown" };
    if (!res.ok) return { checked: false, malicious: false, detail: `VT HTTP ${res.status}` };
    const data = (await res.json()) as {
      data?: { attributes?: { last_analysis_stats?: Record<string, number> } };
    };
    const stats = data.data?.attributes?.last_analysis_stats ?? {};
    const bad = (stats["malicious"] ?? 0) + (stats["suspicious"] ?? 0);
    return {
      checked: true,
      malicious: bad > 0,
      detail: `malicious=${stats["malicious"] ?? 0} suspicious=${stats["suspicious"] ?? 0}`,
    };
  } catch (e) {
    return { checked: false, malicious: false, detail: e instanceof Error ? e.message : "VT error" };
  }
}

Deno.serve(async (req: Request) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const VT_API_KEY = Deno.env.get("VT_API_KEY") || "";
    if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Missing secrets" }, 500);

    const payload = (await req.json()) as {
      record?: { name?: string; bucket_id?: string; metadata?: { mimetype?: string; size?: number } };
    };
    const record = payload.record;
    const name = record?.name || "";
    if (!name || record?.bucket_id !== "space-media") return json({ verdict: "ignored" });

    const reasons: string[] = [];
    const segments = name.toLowerCase().split("/");
    const file = segments[segments.length - 1] ?? "";
    const parts = file.split(".");
    if (parts.length < 2 || !parts[parts.length - 1]) reasons.push("missing extension");
    const bad = parts.slice(1).find((s) => DENY_EXT.has(s));
    if (bad) reasons.push(`denied extension .${bad}`);
    const ext = parts[parts.length - 1] ?? "";
    const rule = EXT_MIME[ext];
    if (!rule) reasons.push(`extension .${ext} not whitelisted`);

    const claimed = (record?.metadata?.mimetype || "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (rule && claimed && !rule.includes(claimed)) {
      reasons.push(`MIME ${claimed} mismatches .${ext}`);
    }

    const svcHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
    // Download the head (static checks) — full body only if VT lookup needs hashing.
    const objRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/space-media/${encodeURIComponent(name)}`,
      { headers: svcHeaders },
    );
    if (!objRes.ok) return json({ verdict: "fetch-failed", status: objRes.status });
    const bytes = new Uint8Array(await objRes.arrayBuffer());
    if (bytes.length > MAX_BYTES) reasons.push(`size ${bytes.length} exceeds 20 MB cap`);
    if (bytes.length === 0) reasons.push("empty file");

    if (rule && reasons.length === 0) {
      const head = bytes.slice(0, 16);
      let textHead = "";
      if (ext === "txt" || ext === "md" || ext === "csv") {
        textHead = new TextDecoder("utf-8").decode(bytes.slice(0, 4096));
      }
      if (!magicOk(ext, head, textHead)) reasons.push(`content does not match .${ext}`);
    }

    // Known-malware hash lookup (optional, needs VT_API_KEY secret).
    let vtChecked = false;
    if (reasons.length === 0 && VT_API_KEY && bytes.length > 0) {
      const hash = await sha256Hex(bytes);
      const vt = await virusTotalLookup(VT_API_KEY, hash);
      vtChecked = vt.checked;
      if (vt.malicious) reasons.push(`VirusTotal flags this file (${vt.detail})`);
    }

    const verdict: Verdict = { clean: reasons.length === 0, reasons, vtChecked };
    if (verdict.clean) {
      return json({ verdict: vtChecked ? "clean" : "unscanned-static-ok", ...verdict });
    }

    // Failure: delete the object so it can never be served.
    await fetch(
      `${SUPABASE_URL}/storage/v1/object/space-media/${encodeURIComponent(name)}`,
      { method: "DELETE", headers: svcHeaders },
    );
    return json({ verdict: "deleted", ...verdict });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
