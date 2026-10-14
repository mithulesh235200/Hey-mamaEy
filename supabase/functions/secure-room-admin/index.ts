// Supabase Edge Function: secure-room-admin
// Verifies an ECDSA P-256 signature against the caller's registered identity
// key, then mints a one-time admin ticket for a single owner action.
// Body: { action, code, user_id, expires, sig }
//   sig = base64url(raw R||S) over "heymamaey-admin-v1|action|code|user_id|expires"
// Env secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Deploy: supabase functions deploy secure-room-admin

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const ACTIONS = new Set([
  "set_password",
  "set_lock",
  "set_readonly",
  "kick",
  "unban",
  "delete_space",
]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Missing secrets" }, 500);

    const body = (await req.json()) as Record<string, unknown>;
    const action = String(body.action ?? "").trim();
    const code = String(body.code ?? "")
      .trim()
      .slice(0, 32);
    const userId = String(body.user_id ?? "")
      .trim()
      .toUpperCase()
      .slice(0, 64);
    const expires = Number(body.expires ?? 0);
    const sig = String(body.sig ?? "").trim();
    if (!ACTIONS.has(action) || !code || !userId || !sig) {
      return json({ error: "action, code, user_id and sig are required" }, 400);
    }
    if (
      !Number.isFinite(expires) ||
      expires < Date.now() - 30_000 ||
      expires > Date.now() + 10 * 60_000
    ) {
      return json({ error: "Bad expiry" }, 400);
    }

    const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

    // Registered public key for this identity.
    const keyRes = await fetch(
      `${SUPABASE_URL}/rest/v1/identity_keys?user_id=eq.${encodeURIComponent(userId)}&select=public_jwk`,
      { headers },
    );
    if (!keyRes.ok) return json({ error: "Registry lookup failed" }, 502);
    const rows = (await keyRes.json()) as { public_jwk: string }[];
    const jwkText = rows[0]?.public_jwk;
    if (!jwkText) return json({ error: "NO_IDENTITY" }, 403);
    let jwk: JsonWebKey;
    try {
      jwk = JSON.parse(jwkText) as JsonWebKey;
      if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) throw new Error("bad");
    } catch {
      return json({ error: "NO_IDENTITY" }, 403);
    }

    // Verify signature.
    const payload = `heymamaey-admin-v1|${action}|${code}|${userId}|${expires}`;
    let ok = false;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      const raw = b64urlDecode(sig);
      if (raw.length !== 64) return json({ error: "BAD_SIGNATURE" }, 403);
      ok = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        raw.buffer as ArrayBuffer,
        new TextEncoder().encode(payload),
      );
    } catch {
      ok = false;
    }
    if (!ok) return json({ error: "BAD_SIGNATURE" }, 403);

    // Resolve the space, then mint a 5-minute single-purpose ticket.
    const spaceRes = await fetch(
      `${SUPABASE_URL}/rest/v1/spaces?code=eq.${encodeURIComponent(code)}&select=id,owner_id`,
      { headers },
    );
    if (!spaceRes.ok) return json({ error: "Space lookup failed" }, 502);
    const spaces = (await spaceRes.json()) as { id: string; owner_id: string | null }[];
    const space = spaces[0];
    if (!space?.id || space.owner_id !== userId) return json({ error: "NOT_OWNER" }, 403);

    const ticket = crypto.randomUUID();
    const insRes = await fetch(`${SUPABASE_URL}/rest/v1/admin_tickets`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({
        ticket,
        space_id: space.id,
        user_id: userId,
        action,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
    });
    if (!insRes.ok) return json({ error: "Ticket mint failed" }, 502);
    return json({ ticket });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
