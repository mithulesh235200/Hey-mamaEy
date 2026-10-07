import { createFileRoute } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { MobileHome, type MobileTab } from "@/components/chat/MobileHome";
import { Sidebar } from "@/components/chat/Sidebar";
import { hydrate, useChatState, type Message } from "@/lib/heymama";

const ChatPanel = lazy(() =>
  import("@/components/chat/ChatPanel").then((m) => ({ default: m.ChatPanel })),
);
const ForwardDialog = lazy(() =>
  import("@/components/chat/ForwardDialog").then((m) => ({ default: m.ForwardDialog })),
);
const SettingsModal = lazy(() =>
  import("@/components/chat/SettingsModal").then((m) => ({ default: m.SettingsModal })),
);

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "HeyMamaEy — Anonymous Code-Based Chat & File Sharing" },
      {
        name: "description",
        content:
          "Private chat and file sharing with random ID codes. No phone number, no email — create a Space, share the code, send text, photos, video, voice notes and documents.",
      },
      {
        property: "og:title",
        content: "HeyMamaEy — Anonymous Code-Based Chat & File Sharing",
      },
      {
        property: "og:description",
        content:
          "Zero-credential messaging. Generate an ID, create a Space, share the number, chat with media.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  const state = useChatState();
  if (typeof window !== "undefined" && !state.ready) {
    hydrate();
  }
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("spaces");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileQuickBar, setMobileQuickBar] = useState(true);
  const backState = useRef({
    activeSpace: false,
    mobileOpen: false,
    mobileTab: "spaces" as MobileTab,
    settingsOpen: false,
  });
  const activeSpace = state.spaces.find((s) => s.id === state.activeSpaceId) ?? null;
  const activeMessages = activeSpace
    ? state.messages.filter((m) => m.spaceId === activeSpace.id)
    : [];

  backState.current = {
    activeSpace: Boolean(activeSpace),
    mobileOpen,
    mobileTab,
    settingsOpen,
  };

  useEffect(() => {
    hydrate();
    const settingsPreloadTimer = window.setTimeout(() => {
      void import("@/components/chat/SettingsModal");
    }, 300);
    const syncPreferences = () => {
      setMobileQuickBar(localStorage.getItem("heymamaey.mobileBar") !== "false");
      const density = localStorage.getItem("heymamaey.density") || "comfortable";
      document.documentElement.setAttribute("data-density", density);
    };
    syncPreferences();
    window.addEventListener("heymamaey:preferences-updated", syncPreferences);
    return () => {
      window.clearTimeout(settingsPreloadTimer);
      window.removeEventListener("heymamaey:preferences-updated", syncPreferences);
    };
  }, []);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let active = true;
    let removeListener: (() => void) | undefined;

    void App.addListener("backButton", () => {
      if (settingsOpen) {
        setSettingsOpen(false);
        return;
      }

      if (activeSpace && mobileOpen) {
        setMobileOpen(false);
        return;
      }

      if (activeSpace) {
        setMobileTab("profile");
        setMobileOpen(true);
        return;
      }

      if (mobileTab === "spaces") {
        setMobileTab("profile");
        return;
      }

      void App.minimizeApp();
    }).then((listener) => {
      if (active) removeListener = () => void listener.remove();
      else void listener.remove();
    });

    return () => {
      active = false;
      removeListener?.();
    };
  }, [activeSpace, mobileOpen, mobileTab, settingsOpen]);

  // Android browsers do not emit Capacitor's backButton event. Keep a same-page
  // history entry so the browser's Back action returns to the in-app Profile.
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;

    const backEntry = { heyMamaEyBackEntry: true };
    window.history.pushState(backEntry, "", window.location.href);

    const handleBrowserBack = () => {
      const current = backState.current;
      if (current.settingsOpen) {
        setSettingsOpen(false);
      } else if (current.activeSpace && current.mobileOpen) {
        setMobileOpen(false);
      } else if (current.activeSpace || current.mobileTab === "spaces") {
        setMobileTab("profile");
        setMobileOpen(true);
      } else {
        // Retain an in-app history entry after handling Back so a second Back
        // can follow normal browser navigation from the profile screen.
        return;
      }

      window.history.pushState(backEntry, "", window.location.href);
    };

    window.addEventListener("popstate", handleBrowserBack);
    return () => window.removeEventListener("popstate", handleBrowserBack);
  }, []);

  if (!state.ready) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
        <div className="flex max-w-xs flex-col items-center text-center">
          <img
            src="/heymama.jpeg"
            alt="Hey Mama"
            className="size-20 rounded-3xl object-cover shadow-lg glow-ring"
          />
          <p className="mt-4 text-sm font-medium">Getting your Spaces ready...</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Your local identity stays on this device.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-screen h-[100dvh] overflow-hidden bg-background text-foreground">
      <div className="hidden w-80 shrink-0 md:block border-r border-border">
        <Sidebar
          userId={state.userId}
          displayName={state.displayName}
          spaces={state.spaces}
          activeSpaceId={state.activeSpaceId}
          messages={state.messages}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </div>

      {activeSpace ? (
        <Suspense fallback={<main className="flex-1 bg-background" aria-label="Loading chat" />}>
          <ChatPanel
            space={activeSpace}
            messages={activeMessages}
            userId={state.userId}
            displayName={state.displayName}
            onForward={setForwarding}
            onOpenSidebar={() => setMobileOpen(true)}
            mobileQuickBar={false}
          />
        </Suspense>
      ) : (
        <WelcomePanel onOpenSidebar={() => setMobileOpen(true)} mobileQuickBar={mobileQuickBar} />
      )}

      {(!activeSpace || mobileOpen) && (
        <div
          className={`fixed inset-0 z-40 md:hidden ${activeSpace && !mobileOpen ? "hidden" : ""}`}
        >
          <MobileHome
            userId={state.userId}
            displayName={state.displayName}
            spaces={state.spaces}
            messages={state.messages}
            activeSpaceId={state.activeSpaceId}
            readTimestamps={state.readTimestamps}
            showBottomNav={mobileQuickBar}
            tab={mobileTab}
            onTabChange={setMobileTab}
            onOpenSettings={() => setSettingsOpen(true)}
            {...(activeSpace ? { onClose: () => setMobileOpen(false) } : {})}
          />
        </div>
      )}

      {forwarding && (
        <Suspense fallback={null}>
          <ForwardDialog
            message={forwarding}
            spaces={state.spaces}
            onClose={() => setForwarding(null)}
          />
        </Suspense>
      )}
      {settingsOpen && (
        <Suspense fallback={<SettingsLoading />}>
          <SettingsModal
            open
            onClose={() => setSettingsOpen(false)}
            userId={state.userId}
            displayName={state.displayName}
          />
        </Suspense>
      )}
    </main>
  );
}

function SettingsLoading() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/75 p-4 backdrop-blur-sm">
      <div
        role="status"
        className="flex items-center gap-3 rounded-2xl border border-border bg-card px-5 py-4 text-sm font-medium shadow-xl"
      >
        <span className="size-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        Opening settings…
      </div>
    </div>
  );
}

function WelcomePanel({
  onOpenSidebar,
  mobileQuickBar,
}: {
  onOpenSidebar: () => void;
  mobileQuickBar: boolean;
}) {
  return (
    <section
      className={`chat-canvas relative flex h-full min-w-0 flex-1 flex-col items-center justify-center px-6 text-center ${mobileQuickBar ? "pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0" : ""}`}
    >
      <button
        type="button"
        onClick={onOpenSidebar}
        aria-label="Open Spaces menu"
        className="absolute left-4 top-4 flex size-10 items-center justify-center rounded-xl bg-card text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary md:hidden"
      >
        <Menu className="size-5" aria-hidden="true" />
      </button>
      <img
        src="/heymama.jpeg"
        alt=""
        className="size-20 rounded-3xl object-cover shadow-lg glow-ring"
      />
      <h2 className="mt-4 text-base font-bold">No Space selected</h2>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
        Create a Space to get a random Space Number, or type a friend’s number to join their room
        instantly.
      </p>
    </section>
  );
}
