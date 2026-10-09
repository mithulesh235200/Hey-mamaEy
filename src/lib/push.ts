// Background push notifications via Capacitor + FCM.
// Web builds are unaffected: the native plugin is loaded lazily and only on
// a native platform. Server fan-out lives in supabase/functions/push-on-message.
import { Capacitor } from "@capacitor/core";
import { supabase } from "@/integrations/supabase/client";

const TOKEN_KEY = "heymamaey.pushToken";

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

/** Uploads the stored FCM token for this identity. Safe to call repeatedly. */
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

/** Registers for push on Android/iOS. No-op on web. Call once on launch. */
export async function initPushNotifications(handlers: PushHandlers): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
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
