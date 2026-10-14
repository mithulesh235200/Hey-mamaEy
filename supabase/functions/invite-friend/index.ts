// Supabase Edge Function: invite-friend
// Body: { target_user_id, from_user_id, from_name, space_code, space_name }
// Delivers a chat invite to a friend's devices via FCM, addressed by their
// Unique Identity Code (no space link needed on their side).
// Env secrets (supabase secrets set): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT (full service-account JSON).
//
// Deploy: supabase functions deploy invite-friend

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

function b64urlBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64urlBytes(new TextEncoder().encode(JSON.stringify(obj)));
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer as ArrayBuffer;
}

async function fcmAccessToken(clientEmail: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    b64urlJson({ alg: "RS256", typ: "JWT" }) +
    "." +
    b64urlJson({
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  const jwt = `${unsigned}.${b64urlBytes(new Uint8Array(sig))}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("FCM auth failed");
  return data.access_token;
}

const cleanId = (v: unknown): string => {
  const s = String(v ?? "")
    .trim()
    .toUpperCase();
  if (s.length < 3 || s.length > 64) return "";
  if (!/^[A-Z0-9][A-Z0-9-]*[A-Z0-9]$/.test(s)) return "";
  return s;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const PROJECT_ID = Deno.env.get("FCM_PROJECT_ID") || "";
    const SA_JSON = Deno.env.get("FCM_SERVICE_ACCOUNT") || "";
    if (!SUPABASE_URL || !SERVICE_KEY || !PROJECT_ID || !SA_JSON) {
      return json({ error: "Missing secrets" }, 500);
    }

    const body = (await req.json()) as Record<string, unknown>;
    const target = cleanId(body.target_user_id);
    const fromId = cleanId(body.from_user_id);
    const fromName =
      String(body.from_name ?? "")
        .trim()
        .slice(0, 40) || "A friend";
    const spaceCode = String(body.space_code ?? "")
      .trim()
      .slice(0, 32);
    const spaceName =
      String(body.space_name ?? "")
        .trim()
        .slice(0, 60) || "a private chat";
    if (!target || !fromId || !spaceCode) {
      return json({ error: "target_user_id, from_user_id and space_code are required" }, 400);
    }
    if (target === fromId) return json({ error: "Cannot invite yourself" }, 400);

    // Tokens for the target identity (service role bypasses RLS).
    const tokRes = await fetch(
      `${SUPABASE_URL}/rest/v1/push_tokens?user_id=eq.${encodeURIComponent(target)}&select=token`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    if (!tokRes.ok) return json({ error: "Token lookup failed" }, 502);
    const tokens = (await tokRes.json()) as { token: string }[];
    if (!Array.isArray(tokens) || tokens.length === 0) return json({ sent: 0 });

    const sa = JSON.parse(SA_JSON) as { client_email: string; private_key: string };
    const accessToken = await fcmAccessToken(sa.client_email, sa.private_key);

    const title = `💌 ${fromName} invited you to chat`;
    const note = `Tap to join ${spaceName}`;
    const results = await Promise.allSettled(
      tokens.slice(0, 10).map((t) =>
        fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              token: t.token,
              notification: { title, body: note },
              data: { space_code: spaceCode, invite_from: fromId, invite_name: fromName },
              android: { priority: "high" },
            },
          }),
        }),
      ),
    );
    const sent = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;
    return json({ sent });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
