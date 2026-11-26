// Supabase Edge Function: dm-request
// Body: { target_user_id, from_user_id, from_name }
// Notifies an identity that someone wants to start a 1:1 chat with them —
// used when the stranger gate downgraded a DM tap into a request (see
// get_or_create_direct_space / dm_requests). No space code: nothing exists
// on their side until they accept in People → Requests, so the tap just
// opens the app.
// Transports (both optional — each covers the tokens it is configured for):
//   Web Push (PWA / desktop / Android-installed web app): VAPID_PUBLIC_KEY,
//     VAPID_PRIVATE_KEY — fans out to push_tokens rows with platform='web'.
//   Android/iOS native: FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT (service-account
//     JSON) — fans out to rows with any other platform value.
// Env secrets (supabase secrets set): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// Deploy: supabase functions deploy dm-request

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

type TokenRow = { token: string; platform: string | null };

/** Deletes a push token row whose endpoint is dead (404/410). Best-effort. */
async function dropStaleToken(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  row: TokenRow,
): Promise<void> {
  try {
    await fetch(
      `${supabaseUrl}/rest/v1/push_tokens?user_id=eq.${encodeURIComponent(userId)}&token=eq.${encodeURIComponent(row.token)}`,
      {
        method: "DELETE",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      },
    );
  } catch {
    /* next request retries */
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const PROJECT_ID = Deno.env.get("FCM_PROJECT_ID") || "";
    const SA_JSON = Deno.env.get("FCM_SERVICE_ACCOUNT") || "";
    const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY") || "";
    const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") || "";
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return json({ error: "Missing Supabase credentials" }, 500);
    }

    const hasFcm = Boolean(PROJECT_ID && SA_JSON);
    const hasWeb = Boolean(VAPID_PUBLIC && VAPID_PRIVATE);
    if (!hasFcm && !hasWeb) {
      // No transport configured: report an honest no-op instead of failing.
      console.error("No push transport configured: set VAPID_* and/or FCM_* secrets");
      return json({ sent: 0, fcm: 0, web: 0 });
    }

    const body = (await req.json()) as Record<string, unknown>;
    const target = cleanId(body.target_user_id);
    const fromId = cleanId(body.from_user_id);
    const fromName =
      String(body.from_name ?? "")
        .trim()
        .slice(0, 40) || "A friend";
    if (!target || !fromId) {
      return json({ error: "target_user_id and from_user_id are required" }, 400);
    }
    if (target === fromId) return json({ error: "Cannot message yourself" }, 400);

    // Tokens for the target identity (service role bypasses RLS).
    const tokRes = await fetch(
      `${SUPABASE_URL}/rest/v1/push_tokens?user_id=eq.${encodeURIComponent(target)}&select=token,platform`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    if (!tokRes.ok) return json({ error: "Token lookup failed" }, 502);
    const tokens = (await tokRes.json()) as TokenRow[];
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return json({ sent: 0, fcm: 0, web: 0 });
    }

    // Route every token to the transport that can actually deliver to it —
    // web subscriptions are JSON endpoint objects and must never hit FCM.
    const nativeTokens = tokens.filter((t) => (t.platform ?? "android") !== "web");
    const webTokens = tokens.filter((t) => t.platform === "web");

    const title = `📨 ${fromName} wants to chat`;
    const note = "Open People to accept or decline the request.";
    const dataPayload = {
      dm_request_from: fromId,
      dm_request_name: fromName,
    };

    // ---- FCM (android / ios native tokens) ----
    let fcmSent = 0;
    if (hasFcm && nativeTokens.length > 0) {
      try {
        const sa = JSON.parse(SA_JSON) as { client_email: string; private_key: string };
        const accessToken = await fcmAccessToken(sa.client_email, sa.private_key);
        const results = await Promise.allSettled(
          nativeTokens.slice(0, 10).map((t) =>
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
                  data: dataPayload,
                  android: { priority: "high" },
                },
              }),
            }),
          ),
        );
        fcmSent = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;
      } catch {
        /* FCM down/misconfigured — web push below still runs */
      }
    }

    // ---- Web Push (PWA / installed web app, incl. Android browsers) ----
    let webSent = 0;
    if (hasWeb && webTokens.length > 0) {
      try {
        const webpush = await import("npm:web-push");
        const vapidDetails = {
          subject: "mailto:hello@heymamaey.app",
          publicKey: VAPID_PUBLIC,
          privateKey: VAPID_PRIVATE,
        };
        const payload = JSON.stringify({ title, body: note, ...dataPayload });
        const results = await Promise.allSettled(
          webTokens.slice(0, 25).map(async (t): Promise<boolean> => {
            let subscription: PushSubscriptionJSON;
            try {
              subscription = JSON.parse(t.token) as PushSubscriptionJSON;
            } catch {
              await dropStaleToken(SUPABASE_URL, SERVICE_KEY, target, t);
              return false;
            }
            if (!subscription?.endpoint) {
              await dropStaleToken(SUPABASE_URL, SERVICE_KEY, target, t);
              return false;
            }
            try {
              await webpush.sendNotification(subscription, payload, {
                vapidDetails,
                TTL: 60 * 60 * 24,
                headers: {},
              });
              return true;
            } catch (e) {
              // 404/410 = endpoint gone (browser reset the subscription).
              const status = (e as { statusCode?: number }).statusCode;
              if (status === 404 || status === 410) {
                await dropStaleToken(SUPABASE_URL, SERVICE_KEY, target, t);
              }
              return false;
            }
          }),
        );
        webSent = results.filter((r) => r.status === "fulfilled" && r.value === true).length;
      } catch {
        /* web-push unavailable — FCM above still ran */
      }
    }

    return json({ sent: fcmSent + webSent, fcm: fcmSent, web: webSent });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
