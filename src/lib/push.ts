// Background push notifications.
// - Native (Capacitor + FCM): full registration flow, below.
// - Web (PWA/desktop): Web Push via the service worker + VAPID. The
//   subscription JSON is stored as the "token" with platform='web', so the
//   same register_push_token / flushPushToken path uploads it and the edge
//   function (push-on-message) routes it through web-push instead of FCM.
//
// Server fan-out lives in supabase/functions/push-on-message.
import { Capacitor } from "@capacitor/core";
import { supabase } from "@/integrations/supabase/client";

const TOKEN_KEY = "heymamaey.pushToken";

// Public VAPID key (P-256). Pair private half is a Supabase secret
// (VAPID_PRIVATE_KEY) used only by the edge function. Regenerating the pair
// requires updating both.
const VAPID_PUBLIC_KEY =
  "BOPyW6q5hHfbKyNru3u5Eh3-XEz6CRmq74VdRhdLKG8dTUc5ueuuRJ5ziM7e_5Mmce4-3HOc1KKuAXYvihAAzRw";

export type PushHandlers = {
  /** Current anonymous user id (may be empty before hydrate). */
  getUserId: () => string;
  /** Open a space from a tapped notification (space code like 5509-1234). */
  onOpenSpace: (spaceCode: string) => void;
  /** Foreground message in a non-active space (app already chimes otherwise). */
  onForegroundMessage?: (spaceCode: string, title: string, body: string) => void;
};

function loadToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function saveToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
}

/** Uploads the stored token (FCM or web subscription) for this identity. */
export async function flushPushToken(userId: string): Promise<boolean> {
  const token = loadToken();
  if (!token || !userId) return false;
  try {
    const { error } = await supabase.rpc("register_push_token", {
      p_user_id: userId,
      p_token: token,
      p_platform: Capacitor.getPlatform(),
    });
    return !error;
  } catch {
    return false;
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

function isWebPushSupported(): boolean {
  return (
    !Capacitor.isNativePlatform() &&
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Subscribes this browser to Web Push and stores the subscription as the
 * push token. Returns false when unsupported, denied, or registration fails.
 * Safe to call repeatedly (an existing subscription is reused).
 */
export async function subscribeWebPush(): Promise<boolean> {
  if (!isWebPushSupported()) return false;
  try {
    const permission =
      Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") return false;

    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
      }));
    saveToken(JSON.stringify(subscription.toJSON()));
    return true;
  } catch {
    return false;
  }
}

/**
 * User-gesture entry point (Settings toggle): subscribe + upload now.
 * On native this is a no-op — the Capacitor flow registers on launch.
 */
export async function enablePushForUser(userId: string): Promise<boolean> {
  if (Capacitor.isNativePlatform()) return true;
  if (!(await subscribeWebPush())) return false;
  return flushPushToken(userId);
}

/** Settings toggle OFF: unsubscribe so the push service stops delivering.
 *  The next fan-out gets 410 and the edge function deletes the token row. */
export async function disableWebPush(): Promise<void> {
  if (!isWebPushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

/** Registers for push. Native: full FCM flow. Web: re-subscribes silently
 *  when permission was already granted AND the user hasn't opted out. */
export async function initPushNotifications(handlers: PushHandlers): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    if (!isWebPushSupported() || Notification.permission !== "granted") return;
    // Respect the Settings toggle: never re-subscribe after an opt-out.
    let optedIn = false;
    try {
      optedIn = localStorage.getItem("heymamaey.notifications") === "true";
    } catch {
      optedIn = false;
    }
    if (!optedIn) return;
    // Silent path: permission already granted from a previous visit — no
    // prompt, just make sure a live subscription exists and is uploaded.
    const ok = await subscribeWebPush();
    if (ok) void flushPushToken(handlers.getUserId());
    return;
  }
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");

    const perm = await PushNotifications.checkPermissions();
    if (perm.receive !== "granted") {
      const req = await PushNotifications.requestPermissions();
      if (req.receive !== "granted") return;
    }

    await PushNotifications.register();

    PushNotifications.addListener("registration", ({ value }) => {
      if (!value) return;
      saveToken(value);
      void flushPushToken(handlers.getUserId());
    });

    PushNotifications.addListener("registrationError", () => {
      /* push stays unavailable; in-app sounds still work */
    });

    PushNotifications.addListener("pushNotificationReceived", (notification) => {
      const spaceCode = (notification.data?.space_code as string | undefined) || "";
      if (spaceCode) {
        handlers.onForegroundMessage?.(
          spaceCode,
          notification.title || "New message",
          notification.body || "",
        );
      }
    });

    PushNotifications.addListener("pushNotificationActionPerformed", ({ notification }) => {
      const spaceCode = (notification.data?.space_code as string | undefined) || "";
      if (spaceCode) handlers.onOpenSpace(spaceCode);
    });
  } catch {
    /* plugin missing (web/PWA) — notifications simply stay in-app */
  }
}
