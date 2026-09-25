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
  Download,
  Search,
  ArrowDown,
  Pin,
  BarChart2,
  Star,
  QrCode,
  Copy,
  Check,
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

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB limit

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
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [editing, setEditing] = useState<Message | null>(null);
  const [pinnedMessage, setPinnedMessage] = useState<Message | null>(null);
  const [starredIds, setStarredIds] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("heymamaey.starred");
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });
  const [showStarredModal, setShowStarredModal] = useState(false);
  const [showQrModal, setShowQrModal] = useState(false);
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [callMode, setCallMode] = useState<"voice" | "video" | null>(null);
  const [activeMembers, setActiveMembers] = useState<string[]>([]);
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  // Poll creation modal state
  const [showPollModal, setShowPollModal] = useState(false);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState<string[]>(["", ""]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem("heymamaey.starred", JSON.stringify(Array.from(starredIds)));
    } catch {
      // ignore localstorage errors
    }
  }, [starredIds]);

  const toggleStar = (m: Message) => {
    setStarredIds((prev) => {
      const next = new Set(prev);
      if (next.has(m.id)) {
        next.delete(m.id);
        toast.info("Message unstarred");
      } else {
        next.add(m.id);
        toast.success("Message starred");
      }
      return next;
    });
  };

  useEffect(() => {
    if (!space) return;
    const channel = supabase.channel(`presence:${space.code}`, {
      config: { broadcast: { self: false } },
    });
    presenceChannelRef.current = channel;

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
      .on(
        "broadcast",
        { event: "typing-start" },
        ({ payload }: { payload: { name: string; userId: string } }) => {
          if (payload.userId === userId) return;
          setTypingUsers((prev) => new Set(prev).add(payload.name));
        },
      )
      .on(
        "broadcast",
        { event: "typing-stop" },
        ({ payload }: { payload: { name: string; userId: string } }) => {
          if (payload.userId === userId) return;
          setTypingUsers((prev) => {
            const next = new Set(prev);
            next.delete(payload.name);
            return next;
          });
        },
      )
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ userId, name: displayName.trim() || "Anonymous" });
          updateMembers();
        }
      });

    return () => {
      void channel.untrack();
      void channel.unsubscribe();
      presenceChannelRef.current = null;
      setActiveMembers([]);
      setTypingUsers(new Set());
    };
  }, [displayName, space, userId]);

  const handleTyping = (val: string) => {
    setText(val);
    if (!presenceChannelRef.current) return;
    const name = displayName.trim() || "Anonymous";

    if (val.trim().length > 0) {
      void presenceChannelRef.current.send({
        type: "broadcast",
        event: "typing-start",
        payload: { name, userId },
      });

      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      typingTimerRef.current = setTimeout(() => {
        void presenceChannelRef.current?.send({
          type: "broadcast",
          event: "typing-stop",
          payload: { name, userId },
        });
      }, 2500);
    } else {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      void presenceChannelRef.current.send({
        type: "broadcast",
        event: "typing-stop",
        payload: { name, userId },
      });
    }
  };

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const isUp = el.scrollHeight - el.scrollTop - el.clientHeight > 150;
    setShowScrollBottom(isUp);
  };

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const shareSpace = async () => {
    setShowQrModal(true);
  };

  const inviteUrl = `${window.location.origin}${window.location.pathname}?space=${encodeURIComponent(space?.code ?? "")}`;

  const copyInviteLink = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopiedInvite(true);
      toast.success("Invite link copied!");
      setTimeout(() => setCopiedInvite(false), 2000);
    } catch {
      toast.error("Couldn't copy invite link");
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

  const filteredMessages = messages.filter((m) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      m.text?.toLowerCase().includes(q) ||
      m.authorName?.toLowerCase().includes(q) ||
      m.fileName?.toLowerCase().includes(q)
    );
  });

  const starredMessagesList = messages.filter((m) => starredIds.has(m.id));

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
    if (presenceChannelRef.current) {
      void presenceChannelRef.current.send({
        type: "broadcast",
        event: "typing-stop",
        payload: { name: displayName.trim() || "Anonymous", userId },
      });
    }

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

  const createPoll = async () => {
    if (!pollQuestion.trim()) {
      toast.error("Please enter a poll question");
      return;
    }
    const validOptions = pollOptions.filter((o) => o.trim().length > 0);
    if (validOptions.length < 2) {
      toast.error("Please add at least 2 options for the poll");
      return;
    }

    const pollText = `📊 **POLL: ${pollQuestion.trim()}**\n` + validOptions.map((opt, i) => `${i + 1}. ${opt.trim()}`).join("\n");
    const ok = await sendMessage({ spaceId: space.id, kind: "text", text: pollText });
    if (ok) {
      toast.success("Poll created!");
      setShowPollModal(false);
      setPollQuestion("");
      setPollOptions(["", ""]);
    } else {
      toast.error("Couldn't create poll");
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.size > MAX_BYTES) {
        toast.error(`${file.name} is too large (${formatBytes(file.size)})`, {
          description: "Keep shared files under 50 MB in this space.",
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

  const typingArray = Array.from(typingUsers);

  return (
    <section className="chat-canvas flex h-full min-w-0 flex-1 flex-col">
      <header className="flex flex-col border-b border-border bg-sidebar px-4 py-3">
        <div className="flex items-center gap-3">
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
            onClick={() => setShowStarredModal(true)}
            title="Starred Messages"
            className="relative rounded-lg bg-card p-2 text-muted-foreground hover:text-amber-400 transition-colors"
          >
            <Star className="size-4" />
            {starredIds.size > 0 && (
              <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-amber-500 font-mono text-[9px] font-bold text-black shadow-sm">
                {starredIds.size}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setShowSearch((v) => !v)}
            title="Search messages"
            className={
              "rounded-lg bg-card p-2 text-muted-foreground hover:text-primary transition-colors " +
              (showSearch ? "text-primary ring-1 ring-primary" : "")
            }
          >
            <Search className="size-4" />
          </button>
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
        </div>

        {showSearch && (
          <div className="mt-2.5 flex items-center gap-2 rounded-xl bg-card px-3 py-1.5 border border-border animate-in fade-in duration-150">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search in this space..."
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            )}
          </div>
        )}
      </header>

      {pinnedMessage && (
        <div className="flex items-center justify-between border-b border-border bg-secondary/80 px-4 py-2 text-xs backdrop-blur-md animate-in slide-in-from-top-2 duration-150">
          <div className="flex items-center gap-2 min-w-0">
            <Pin className="size-3.5 shrink-0 text-primary" />
            <span className="font-semibold text-primary">Pinned:</span>
            <span className="truncate text-muted-foreground">
              {pinnedMessage.text || pinnedMessage.fileName || "Media attachment"}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setPinnedMessage(null);
              toast.info("Message unpinned");
            }}
            className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="thin-scroll relative flex-1 space-y-3 overflow-y-auto p-4"
      >
        {filteredMessages.length === 0 && (
          <p className="py-10 text-center text-xs text-muted-foreground">
            {searchQuery ? "No messages matching your search." : "No messages yet — send text, images, video, voice notes or documents."}
          </p>
        )}
        {filteredMessages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            mine={m.authorId === userId}
            onForward={onForward}
            onOpenImage={setLightbox}
            onPin={(message) => {
              setPinnedMessage(message);
              toast.success("Message pinned to top");
            }}
            onStar={toggleStar}
            isStarred={starredIds.has(m.id)}
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

        {showScrollBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="sticky bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-2xl transition-transform hover:scale-105 animate-in fade-in duration-150"
          >
            <ArrowDown className="size-3.5" />
            <span>Latest messages</span>
          </button>
        )}
      </div>

      <footer className="border-t border-border bg-sidebar p-3">
        {typingArray.length > 0 && (
          <div className="mb-2 flex items-center gap-2 px-1 text-xs text-muted-foreground italic animate-pulse">
            <span className="size-2 rounded-full bg-primary animate-ping" />
            <span>
              {typingArray.join(", ")} {typingArray.length === 1 ? "is" : "are"} typing...
            </span>
          </div>
        )}

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
            <IconBtn label="Create Poll" onClick={() => setShowPollModal(true)}>
              <BarChart2 className="size-4" />
            </IconBtn>
          </div>
          <textarea
            value={text}
            onChange={(e) => handleTyping(e.target.value)}
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

      {/* Starred Messages Modal */}
      {showStarredModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="w-full max-w-lg rounded-2xl bg-card border border-border p-5 shadow-2xl flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <Star className="size-5 text-amber-400 fill-amber-400" />
                <h3 className="font-bold text-sm">Starred Messages ({starredMessagesList.length})</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowStarredModal(false)}
                className="rounded-full p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="thin-scroll flex-1 overflow-y-auto my-3 space-y-3 pr-1">
              {starredMessagesList.length === 0 ? (
                <p className="py-10 text-center text-xs text-muted-foreground">
                  No starred messages yet. Hover over any message and click the Star icon to bookmark it!
                </p>
              ) : (
                starredMessagesList.map((m) => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    mine={m.authorId === userId}
                    onForward={onForward}
                    onOpenImage={setLightbox}
                    onStar={toggleStar}
                    isStarred={true}
                    onEdit={(message) => {
                      setShowStarredModal(false);
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
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Space QR Invite Modal */}
      {showQrModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="w-full max-w-sm rounded-3xl bg-card border border-border p-6 shadow-2xl flex flex-col items-center text-center space-y-4">
            <div className="flex w-full items-center justify-between border-b border-border pb-2">
              <div className="flex items-center gap-2">
                <QrCode className="size-5 text-primary" />
                <h3 className="font-bold text-sm">Space QR Invite</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowQrModal(false)}
                className="rounded-full p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="flex flex-col items-center p-4 bg-white rounded-2xl shadow-inner border border-border">
              {/* Elegant SVG QR Code visual */}
              <svg className="size-40 text-slate-900" viewBox="0 0 100 100" fill="currentColor">
                <rect width="100" height="100" fill="white" />
                {/* QR Positioning Squares */}
                <rect x="5" y="5" width="25" height="25" rx="4" />
                <rect x="10" y="10" width="15" height="15" fill="white" />
                <rect x="13" y="13" width="9" height="9" />

                <rect x="70" y="5" width="25" height="25" rx="4" />
                <rect x="75" y="10" width="15" height="15" fill="white" />
                <rect x="78" y="13" width="9" height="9" />

                <rect x="5" y="70" width="25" height="25" rx="4" />
                <rect x="10" y="75" width="15" height="15" fill="white" />
                <rect x="13" y="78" width="9" height="9" />

                {/* Data dots */}
                <rect x="40" y="10" width="8" height="8" />
                <rect x="52" y="10" width="8" height="8" />
                <rect x="36" y="24" width="8" height="8" />
                <rect x="48" y="24" width="8" height="8" />
                <rect x="10" y="40" width="8" height="8" />
                <rect x="22" y="40" width="8" height="8" />
                <rect x="36" y="40" width="10" height="10" />
                <rect x="50" y="40" width="8" height="8" />
                <rect x="64" y="40" width="8" height="8" />
                <rect x="78" y="40" width="8" height="8" />
                <rect x="10" y="52" width="8" height="8" />
                <rect x="24" y="52" width="8" height="8" />
                <rect x="40" y="54" width="8" height="8" />
                <rect x="54" y="54" width="8" height="8" />
                <rect x="68" y="54" width="8" height="8" />
                <rect x="40" y="70" width="8" height="8" />
                <rect x="54" y="70" width="8" height="8" />
                <rect x="70" y="70" width="10" height="10" />
                <rect x="84" y="70" width="8" height="8" />
                <rect x="40" y="84" width="8" height="8" />
                <rect x="56" y="84" width="8" height="8" />
                <rect x="72" y="84" width="8" height="8" />
                <rect x="84" y="84" width="8" height="8" />
              </svg>
              <p className="mt-2 text-xs font-mono font-bold text-slate-800 tracking-wider">
                SPACE CODE: {space.code}
              </p>
            </div>

            <div>
              <h4 className="font-bold text-sm text-foreground">{space.name}</h4>
              <p className="text-xs text-muted-foreground mt-0.5">Scan or share link to join instantly</p>
            </div>

            <button
              type="button"
              onClick={() => void copyInviteLink()}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 text-xs font-bold text-primary-foreground transition-transform hover:scale-102"
            >
              {copiedInvite ? <Check className="size-4" /> : <Copy className="size-4" />}
              <span>{copiedInvite ? "Copied Link!" : "Copy Invite Link"}</span>
            </button>
          </div>
        </div>
      )}

      {showPollModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="w-full max-w-md rounded-2xl bg-card border border-border p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <BarChart2 className="size-5 text-primary" />
                <h3 className="font-bold text-sm">Create a Space Poll</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowPollModal(false)}
                className="rounded-full p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Question
              </label>
              <input
                type="text"
                value={pollQuestion}
                onChange={(e) => setPollQuestion(e.target.value)}
                placeholder="e.g. What time should we call?"
                className="mt-1 w-full rounded-xl bg-background px-3 py-2 text-sm outline-none ring-1 ring-input focus:ring-primary"
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Options
              </label>
              {pollOptions.map((opt, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={opt}
                    onChange={(e) => {
                      const copy = [...pollOptions];
                      copy[i] = e.target.value;
                      setPollOptions(copy);
                    }}
                    placeholder={`Option ${i + 1}`}
                    className="flex-1 rounded-xl bg-background px-3 py-2 text-xs outline-none ring-1 ring-input focus:ring-primary"
                  />
                  {pollOptions.length > 2 && (
                    <button
                      type="button"
                      onClick={() => setPollOptions(pollOptions.filter((_, idx) => idx !== i))}
                      className="text-muted-foreground hover:text-destructive text-xs"
                    >
                      <X className="size-4" />
                    </button>
                  )}
                </div>
              ))}
              {pollOptions.length < 5 && (
                <button
                  type="button"
                  onClick={() => setPollOptions([...pollOptions, ""])}
                  className="text-xs font-semibold text-primary hover:underline mt-1"
                >
                  + Add Option
                </button>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowPollModal(false)}
                className="rounded-xl px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void createPoll()}
                className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-transform hover:scale-105"
              >
                Create Poll
              </button>
            </div>
          </div>
        </div>
      )}

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/95 p-4 sm:p-6 animate-in fade-in duration-200"
          onClick={() => setLightbox(null)}
        >
          <div className="absolute right-5 top-5 flex items-center gap-2">
            <a
              href={lightbox}
              download={`space-connect-photo-${Date.now()}.jpg`}
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1.5 rounded-full bg-card px-4 py-2 text-xs font-semibold text-foreground shadow-xl hover:text-primary transition-colors"
            >
              <Download className="size-4" />
              <span>Download Photo</span>
            </a>
            <button
              type="button"
              aria-label="Close image"
              className="rounded-full bg-card p-2 text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setLightbox(null)}
            >
              <X className="size-4" />
            </button>
          </div>
          <img
            src={lightbox}
            alt="Full size attachment"
            className="max-h-[85vh] max-w-full rounded-2xl object-contain shadow-2xl border border-border"
            onClick={(e) => e.stopPropagation()}
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
