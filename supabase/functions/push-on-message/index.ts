// Supabase Edge Function: push-on-message
// Trigger: Database Webhook on public.messages INSERT -> POST this function.
//
// Env secrets (supabase secrets set):
//   Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WEBHOOK_SECRET
//   Android/iOS (FCM): FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT (service-account JSON)
//     — optional: without them the function still serves Web Push.
//   Web Push (PWA/desktop): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (P-256 pair,
//     base64url) — optional: without them the function still serves FCM.
//
// Deploy:  supabase functions deploy push-on-message
// Webhook: Dashboard > Database > Webhooks > Create trigger on messages/insert.
// Auth:    set WEBHOOK_SECRET (supabase secrets set) and add it to the webhook
//   as an x-webhook-secret header; requests without it are rejected (401).

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

type NewMessage = {
  id: string;
  space_id: string;
  author_id: string;
  author_name: string;
  kind: string;
  text: string | null;
  file_name: string | null;
};

type TokenRow = { user_id: string; token: string; platform: string | null };

function snippetFor(msg: NewMessage): string {
  // Never leak E2E ciphertext into push payloads.
  if (msg.text?.startsWith("__enc1__.")) return "📩 sent a new message";
  if (msg.kind === "text" && msg.text) {
    if (msg.text.startsWith("__location__")) return "📍 shared a location";
    return msg.text.length > 120 ? msg.text.slice(0, 120) + "…" : msg.text;
  }
  if (msg.kind === "image") return "📷 sent a photo";
  if (msg.kind === "video") return "🎬 sent a video";
  if (msg.kind === "audio") return "🎤 sent a voice note";
  if (msg.kind === "file") {
    return msg.text?.startsWith("__p2p__:")
      ? "⚡ shared a file (P2P)"
      : `📎 ${msg.file_name || "sent a file"}`;
  }
  return "sent a message";
}

/** Deletes a push token row whose endpoint is dead (404/410). Best-effort. */
async function dropStaleToken(
  supabaseUrl: string,
  serviceKey: string,
  row: TokenRow,
): Promise<void> {
  try {
    await fetch(
      `${supabaseUrl}/rest/v1/push_tokens?user_id=eq.${encodeURIComponent(row.user_id)}&token=eq.${encodeURIComponent(row.token)}`,
      {
        method: "DELETE",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
      },
    );
  } catch {
    /* next fan-out retries */
  }
}

Deno.serve(async (req: Request) => {
  try {
    // S4: fail closed before any service-role call or send unless the
    // webhook authenticates. Empty/undefined WEBHOOK_SECRET is rejected too.
    const webhookSecret = Deno.env.get("WEBHOOK_SECRET") || "";
    const providedSecret = req.headers.get("x-webhook-secret") || "";
    if (!webhookSecret || providedSecret !== webhookSecret) {
      if (!webhookSecret) {
        console.error(
          "Set WEBHOOK_SECRET and configure the dashboard webhook to send it in x-webhook-secret",
        );
      }
      return new Response(
        JSON.stringify({ error: "Unauthorized: missing or invalid x-webhook-secret" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const PROJECT_ID = Deno.env.get("FCM_PROJECT_ID") || "";
    const SA_JSON = Deno.env.get("FCM_SERVICE_ACCOUNT") || "";
    const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY") || "";
    const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") || "";
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return new Response("Missing secrets", { status: 500 });
    }
    // At least one transport must be configured, or push is a no-op.
    const fcmReady = Boolean(PROJECT_ID && SA_JSON);
    const webReady = Boolean(VAPID_PUBLIC && VAPID_PRIVATE);
    if (!fcmReady && !webReady) {
      console.error("No push transport configured: set FCM_* and/or VAPID_* secrets");
      return new Response("ok");
    }

    const payload = (await req.json()) as { record?: NewMessage };
    const msg = payload.record;
    if (!msg?.space_id || !msg?.author_id) return new Response("ok");

    const headers = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    };

    // Space code + name for the notification and the tap-to-open payload.
    const spaceRes = await fetch(
      `${SUPABASE_URL}/rest/v1/spaces?id=eq.${msg.space_id}&select=code,name`,
      { headers },
    );
    const spaces = (await spaceRes.json()) as { code: string; name: string }[];
    const space = spaces[0];
    if (!space?.code) return new Response("ok");

    // Tokens of space members except the author.
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_space_push_tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_space_id: msg.space_id, p_exclude_user_id: msg.author_id }),
    });
    const rows = (await rpcRes.json()) as TokenRow[];
    if (!Array.isArray(rows) || rows.length === 0) return new Response("ok");

    const title = `${msg.author_name || "Someone"} in ${space.name}`;
    const body = snippetFor(msg);
    const dataPayload = { space_code: space.code, message_id: msg.id };
    const limit = rows.slice(0, 50);

    // ---- FCM (android / ios native tokens) ----
    if (fcmReady) {
      try {
        const sa = JSON.parse(SA_JSON) as { client_email: string; private_key: string };
        const accessToken = await fcmAccessToken(sa.client_email, sa.private_key);
        await Promise.allSettled(
          limit
            .filter((t) => (t.platform ?? "android") !== "web")
            .map((t) =>
              fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  message: {
                    token: t.token,
                    notification: { title, body },
                    data: dataPayload,
                    android: { priority: "high" },
                  },
                }),
              }),
            ),
        );
      } catch {
        /* FCM down — web push below still runs */
      }
    }

    // ---- Web Push (PWA / installed desktop app) ----
    if (webReady) {
      try {
        const webpush = await import("npm:web-push");
        const vapidDetails = {
          subject: "mailto:hello@heymamaey.app",
          publicKey: VAPID_PUBLIC,
          privateKey: VAPID_PRIVATE,
        };
        const webPayload = JSON.stringify({ title, body, ...dataPayload });
        await Promise.allSettled(
          limit
            .filter((t) => t.platform === "web")
            .map(async (t) => {
              let subscription: PushSubscriptionJSON;
              try {
                subscription = JSON.parse(t.token) as PushSubscriptionJSON;
              } catch {
                await dropStaleToken(SUPABASE_URL, SERVICE_KEY, t);
                return;
              }
              if (!subscription?.endpoint) {
                await dropStaleToken(SUPABASE_URL, SERVICE_KEY, t);
                return;
              }
              try {
                await webpush.sendNotification(subscription, webPayload, {
                  vapidDetails,
                  TTL: 60 * 60 * 24,
                  headers: {},
                });
              } catch (e) {
                // 404/410 = endpoint gone (browser reset the subscription).
                const status = (e as { statusCode?: number }).statusCode;
                if (status === 404 || status === 410) {
                  await dropStaleToken(SUPABASE_URL, SERVICE_KEY, t);
                }
              }
            }),
        );
      } catch {
        /* web-push unavailable — FCM above still ran */
      }
    }

    return new Response("ok");
  } catch (e) {
    return new Response(`error: ${e instanceof Error ? e.message : "unknown"}`, { status: 500 });
  }
});
