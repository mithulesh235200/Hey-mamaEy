import { useEffect, useRef, useState } from "react";
import {
  Image as ImageIcon,
  Menu,
  Mic,
  Paperclip,
  Phone,
  Send,
  Share2,
  Square,
  AudioLines,
  Video,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  formatBytes,
  kindForFile,
  readFileAsDataUrl,
  deleteMessage,
  editMessage,
  sendMessage,
  type MediaKind,
  type Message,
  type Space,
} from "@/lib/heymama";
import { MessageBubble } from "./MessageBubble";
import { InAppCall } from "./InAppCall";

const MAX_BYTES = 12 * 1024 * 1024;

export function ChatPanel({
  space,
  messages,
  userId,
  displayName,
  onForward,
  onOpenSidebar,
}: {
  space: Space | null;
  messages: Message[];
  userId: string;
  displayName: string;
  onForward: (m: Message) => void;
  onOpenSidebar: () => void;
}) {
  const [text, setText] = useState("");
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [editing, setEditing] = useState<Message | null>(null);
  const [callMode, setCallMode] = useState<"voice" | "video" | null>(null);
  const [activeMembers, setActiveMembers] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!space) return;
    const channel = supabase.channel(`presence:${space.code}`);
    const updateMembers = () => {
      const state = channel.presenceState<{ name?: string }>();
      const names = Object.values(state)
        .flat()
        .map((entry) => entry.name?.trim())
        .filter((name): name is string => Boolean(name));
      setActiveMembers([...new Set(names)]);
    };

    channel
      .on("presence", { event: "sync" }, updateMembers)
      .on("presence", { event: "join" }, updateMembers)
      .on("presence", { event: "leave" }, updateMembers)
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ userId, name: displayName.trim() || "Anonymous" });
          updateMembers();
        }
      });

    return () => {
      void channel.untrack();
      void channel.unsubscribe();
      setActiveMembers([]);
    };
  }, [displayName, space, userId]);

  const shareSpace = async () => {
    const url = `${window.location.origin}${window.location.pathname}?space=${encodeURIComponent(space?.code ?? "")}`;
    const shareData = {
      title: `${space?.name ?? "Hey Mama"} invite`,
      text: `Join ${space?.name ?? "this Space"} on HeyMamaEy`,
      url,
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
        return;
      }
      await navigator.clipboard.writeText(url);
      toast.success("Invite link copied", { description: url });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast.error("Couldn’t share the invite link");
    }
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, space?.id]);

  if (!space) {
    return (
      <section className="chat-canvas flex h-full flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <button
          type="button"
          onClick={onOpenSidebar}
          className="absolute left-4 top-4 rounded-lg bg-card p-2 md:hidden"
          aria-label="Open spaces"
        >
          <Menu className="size-4" />
        </button>
        <img
          src="/heymama.jpeg"
          alt="Hey Mama"
          className="size-20 rounded-3xl object-cover shadow-lg glow-ring"
        />
        <div>
          <h2 className="text-lg font-semibold">No Space selected</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Create a Space to get a random Space Number, or type a friend&apos;s number to join
            their room instantly.
          </p>
        </div>
      </section>
    );
  }

  const push = async (
    kind: MediaKind,
    extra: Partial<Omit<Message, "id" | "createdAt" | "authorId" | "authorName">>,
  ) => {
    const ok = await sendMessage({ spaceId: space.id, kind, ...extra });
    if (!ok) toast.error("Message failed to send — check your connection");
  };

  const submitText = async () => {
    const value = text.trim();
    if (!value) return;
    if (editing) {
      const updated = await editMessage(editing.id, space.id, value);
      if (updated) {
        setText("");
        setEditing(null);
      } else {
        toast.error("Message could not be edited");
      }
      return;
    }
    const ok = await sendMessage({ spaceId: space.id, kind: "text", text: value });
    if (ok) {
      setText("");
    } else {
      toast.error("Message failed to send — check your connection");
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.size > MAX_BYTES) {
        toast.error(`${file.name} is too large (${formatBytes(file.size)})`, {
          description: "Keep shared files under 12 MB in this preview.",
        });
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        await push(kindForFile(file), {
          dataUrl,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
        });
      } catch {
        toast.error(`Couldn't read ${file.name}`);
      }
    }
  };

  const toggleRecording = async () => {
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices) {
      audioInputRef.current?.click();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const reader = new FileReader();
        reader.onload = () =>
          push("audio", {
            dataUrl: String(reader.result),
            fileName: "Voice note",
            fileSize: blob.size,
            mimeType: blob.type,
          });
        reader.readAsDataURL(blob);
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      audioInputRef.current?.click();
    }
  };

  return (
    <section className="chat-canvas flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-sidebar px-4 py-3">
        <button
          type="button"
          onClick={onOpenSidebar}
          className="rounded-lg bg-card p-2 md:hidden"
          aria-label="Open spaces"
        >
          <Menu className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{space.name}</h2>
          <p className="text-[11px] text-muted-foreground">
            Space Code <span className="font-mono text-primary">{space.code}</span>
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" />
            {activeMembers.length} active
            {activeMembers.length > 0 && <span aria-label="Active members">· {activeMembers.join(", ")}</span>}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void shareSpace()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-secondary px-2.5 py-1.5 text-xs font-medium transition-colors hover:text-primary"
        >
          <Share2 className="size-3.5" />
          <span className="hidden sm:inline">Share invite</span>
          <span className="sm:hidden">Share</span>
        </button>
        <IconBtn label="Start voice call" onClick={() => setCallMode("voice")}>
          <Phone className="size-3.5" />
        </IconBtn>
        <IconBtn label="Start video call" onClick={() => setCallMode("video")}>
          <Video className="size-3.5" />
        </IconBtn>
      </header>

      <div className="thin-scroll flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="py-10 text-center text-xs text-muted-foreground">
            No messages yet — send text, images, video, voice notes or documents.
          </p>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            mine={m.authorId === userId}
            onForward={onForward}
            onOpenImage={setLightbox}
            onEdit={(message) => {
              setEditing(message);
              setText(message.text ?? "");
            }}
            onDelete={async (message) => {
              if (!window.confirm("Delete this message?")) return;
              const deleted = await deleteMessage(message.id, message.spaceId);
              toast[deleted ? "success" : "error"](
                deleted ? "Message deleted" : "Message could not be deleted",
              );
            }}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <footer className="border-t border-border bg-sidebar p-3">
        {editing && (
          <div className="mb-2 flex items-center justify-between rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">
            <span>Editing message</span>
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setText("");
              }}
              className="font-semibold text-foreground hover:text-primary"
            >
              Cancel
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex shrink-0 gap-1">
            <IconBtn label="Send image" onClick={() => mediaInputRef.current?.click()}>
              <ImageIcon className="size-4" />
            </IconBtn>
            <IconBtn label="Send document" onClick={() => fileInputRef.current?.click()}>
              <Paperclip className="size-4" />
            </IconBtn>
            <IconBtn label="Send audio file" onClick={() => audioInputRef.current?.click()}>
              <AudioLines className="size-4" />
            </IconBtn>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submitText();
              }
            }}
            rows={1}
            placeholder="Message — **bold**, _italic_, `code`, emoji 🎉"
            className="thin-scroll order-2 min-w-[min(100%,12rem)] max-h-32 min-h-10 flex-1 resize-none rounded-xl bg-card px-3 py-2.5 text-sm outline-none ring-1 ring-input focus:ring-primary sm:order-none"
          />
          <IconBtn
            label={recording ? "Stop recording" : "Record voice note"}
            onClick={toggleRecording}
            className={recording ? "bg-destructive text-foreground" : ""}
          >
            {recording ? <Square className="size-4" /> : <Mic className="size-4" />}
          </IconBtn>
          <button
            type="button"
            onClick={() => void submitText()}
            aria-label="Send message"
            className="order-2 flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-transform hover:scale-105 sm:order-none"
          >
            <Send className="size-4" />
          </button>
        </div>
        <input
          ref={mediaInputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={audioInputRef}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </footer>

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-6"
          onClick={() => setLightbox(null)}
        >
          <button
            type="button"
            aria-label="Close image"
            className="absolute right-5 top-5 rounded-full bg-card p-2"
            onClick={() => setLightbox(null)}
          >
            <X className="size-4" />
          </button>
          <img
            src={lightbox}
            alt="Full size attachment"
            className="max-h-full max-w-full rounded-xl object-contain"
          />
        </div>
      )}
      <InAppCall
        spaceCode={space.code}
        userId={userId}
        requestedMode={callMode}
        onClose={() => setCallMode(null)}
      />
    </section>
  );
}

function IconBtn({
  children,
  label,
  onClick,
  className = "",
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={
        "flex size-10 items-center justify-center rounded-xl bg-card text-muted-foreground transition-colors hover:text-primary " +
        className
      }
    >
      {children}
    </button>
  );
}
