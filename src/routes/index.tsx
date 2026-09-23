import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ForwardDialog } from "@/components/chat/ForwardDialog";
import { Sidebar } from "@/components/chat/Sidebar";
import { hydrate, useChatState, type Message } from "@/lib/heymama";

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
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    hydrate();
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

  const activeSpace = state.spaces.find((s) => s.id === state.activeSpaceId) ?? null;
  const activeMessages = activeSpace
    ? state.messages.filter((m) => m.spaceId === activeSpace.id)
    : [];

  return (
    <main className="flex h-screen overflow-hidden bg-background text-foreground">
      <div className="hidden w-80 shrink-0 md:block">
        <Sidebar
          userId={state.userId}
          displayName={state.displayName}
          spaces={state.spaces}
          activeSpaceId={state.activeSpaceId}
          messages={state.messages}
        />
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden" onClick={() => setMobileOpen(false)}>
          <div className="h-full w-80 max-w-[85%]" onClick={(e) => e.stopPropagation()}>
            <Sidebar
              userId={state.userId}
              displayName={state.displayName}
              spaces={state.spaces}
              activeSpaceId={state.activeSpaceId}
              messages={state.messages}
              onNavigate={() => setMobileOpen(false)}
            />
          </div>
          <div className="flex-1 bg-background/70 backdrop-blur-sm" />
        </div>
      )}

      <ChatPanel
        space={activeSpace}
        messages={activeMessages}
        userId={state.userId}
        displayName={state.displayName}
        onForward={setForwarding}
        onOpenSidebar={() => setMobileOpen(true)}
      />

      <ForwardDialog
        message={forwarding}
        spaces={state.spaces}
        onClose={() => setForwarding(null)}
      />
    </main>
  );
}
