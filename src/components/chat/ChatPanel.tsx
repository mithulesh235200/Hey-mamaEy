import { useEffect, useRef, useState } from "react";
import {
  Image as ImageIcon,
  Menu,
  ChevronLeft,
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
  Volume2,
  VolumeX,
  Sparkles,
  Sliders,
  FolderOpen,
  FileText,
  FileDown,
  Clock,
  Zap,
  Lock,
  Unlock,
  KeyRound,
  MapPin,
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

function playChime(type: "send" | "receive", muted: boolean) {
  if (muted) return;
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === "send") {
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    } else {
      osc.frequency.setValueAtTime(660, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(520, ctx.currentTime + 0.18);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.2);
    }
  } catch {
    // ignore audio autoplay restriction
  }
}

type WallpaperStyle = "default" | "dots" | "grid" | "cosmic";
type PhotoFilter = "none" | "grayscale" | "sepia" | "vintage" | "neon";
type MediaTab = "all" | "image" | "video" | "audio" | "file";
type DisappearingTimer = "off" | "24h" | "7d" | "30d";

const QUICK_EMOJIS = ["🔥", "👍", "❤️", "🎉", "😂", "💯", "🚀", "👏"];
const DRAFT_TEMPLATES = [
  "👋 Hey there! How are you doing?",
  "📍 I'm on my way now!",
  "📞 Call me when you get a chance.",
  "📁 I've shared the files in this space.",
  "⏳ Give me 5 minutes to check.",
  "✅ Got it, thanks!",
];

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
  const [activePhotoFilter, setActivePhotoFilter] = useState<PhotoFilter>("none");
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const [editing, setEditing] = useState<Message | null>(null);
  const [pinnedMessage, setPinnedMessage] = useState<Message | null>(null);
  const [mutedSound, setMutedSound] = useState(false);
  const [wallpaper, setWallpaper] = useState<WallpaperStyle>(() => {
    return (localStorage.getItem("heymamaey.wallpaper") as WallpaperStyle) || "default";
  });
  const [disappearingTimer, setDisappearingTimer] = useState<DisappearingTimer>(() => {
    return (localStorage.getItem(`heymamaey.disappearing.${space?.id}`) as DisappearingTimer) || "off";
  });
  const [showDisappearingMenu, setShowDisappearingMenu] = useState(false);
  const [showWallpaperMenu, setShowWallpaperMenu] = useState(false);
  const [showSnippetsMenu, setShowSnippetsMenu] = useState(false);
  const [showGifsMenu, setShowGifsMenu] = useState(false);
  const [showGalleryModal, setShowGalleryModal] = useState(false);
  const [activeMediaTab, setActiveMediaTab] = useState<MediaTab>("all");

  // Space PIN Lock state
  const [spacePin, setSpacePin] = useState<string>(() => {
    return space?.id ? localStorage.getItem(`heymamaey.pin.${space.id}`) || "" : "";
  });
  const [isLocked, setIsLocked] = useState<boolean>(() => {
    return space?.id ? Boolean(localStorage.getItem(`heymamaey.pin.${space.id}`)) : false;
  });
  const [pinInput, setPinInput] = useState("");
  const [showPinSetup, setShowPinSetup] = useState(false);
  const [newPinInput, setNewPinInput] = useState("");

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
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const lastMsgCountRef = useRef(messages.length);

  useEffect(() => {
    if (space?.id) {
      const savedPin = localStorage.getItem(`heymamaey.pin.${space.id}`) || "";
      setSpacePin(savedPin);
      setIsLocked(Boolean(savedPin));
      setPinInput("");
    }
  }, [space?.id]);

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    if (messages.length > lastMsgCountRef.current) {
      const last = messages[messages.length - 1];
      if (last && last.authorId !== userId) {
        playChime("receive", mutedSound);
        if (typeof window !== "undefined" && document.hidden && "Notification" in window && Notification.permission === "granted") {
          try {
            new Notification(`New message in ${space?.name || "Space"}`, {
              body: `${last.authorName}: ${last.text || last.fileName || "Shared media"}`,
              icon: "/heymama.jpeg",
            });
          } catch {
            /* ignore notification error */
          }
        }
      }
    }
    lastMsgCountRef.current = messages.length;
  }, [messages, userId, mutedSound, space?.name]);

  const unlockSpace = () => {
    if (pinInput === spacePin) {
      setIsLocked(false);
      setPinInput("");
      toast.success("Space unlocked!");
    } else {
      toast.error("Incorrect PIN");
    }
  };

  const savePin = () => {
    if (newPinInput.length !== 4 || !/^\d+$/.test(newPinInput)) {
      toast.error("PIN must be 4 numbers");
      return;
    }
    if (space?.id) {
      localStorage.setItem(`heymamaey.pin.${space.id}`, newPinInput);
      setSpacePin(newPinInput);
      setIsLocked(false);
      setShowPinSetup(false);
      setNewPinInput("");
      toast.success("PIN protection enabled for this Space");
    }
  };

  const removePin = () => {
    if (space?.id) {
      localStorage.removeItem(`heymamaey.pin.${space.id}`);
      setSpacePin("");
      setIsLocked(false);
      setShowPinSetup(false);
      toast.info("PIN lock removed");
    }
  };

  const changeWallpaper = (w: WallpaperStyle) => {
    setWallpaper(w);
    localStorage.setItem("heymamaey.wallpaper", w);
    setShowWallpaperMenu(false);
    toast.success(`Wallpaper changed to ${w}`);
  };

  const changeDisappearingTimer = (timer: DisappearingTimer) => {
    setDisappearingTimer(timer);
    if (space?.id) {
      localStorage.setItem(`heymamaey.disappearing.${space.id}`, timer);
    }
    setShowDisappearingMenu(false);
    toast.success(`Disappearing timer set to ${timer === "off" ? "Off" : timer}`);
  };

  const exportChatHistory = () => {
    if (messages.length === 0) {
      toast.error("No chat history to export");
      return;
    }
    let content = `=========================================\nHEY MAMAEY - CHAT EXPORT BACKUP\nSpace: ${space?.name} (Code: ${space?.code})\nExported: ${new Date().toLocaleString()}\n=========================================\n\n`;

    messages.forEach((m) => {
      const dateStr = new Date(m.createdAt).toLocaleString();
      const author = m.authorName || m.authorId;
      const body = m.text ? m.text : `[Attachment: ${m.fileName || m.kind}]`;
      content += `[${dateStr}] ${author}: ${body}\n`;
    });

    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `heymamaey-chat-${space?.code}-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("Chat history exported!");
  };

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

  const handleReplyQuote = (m: Message) => {
    const author = m.authorName || "User";
    const snippet = m.text ? (m.text.length > 40 ? m.text.slice(0, 40) + "..." : m.text) : m.fileName || "attachment";
    setText((prev) => `> Replying to @${author}: "${snippet}"\n${prev}`);
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

  const mediaMessages = messages.filter((m) => m.dataUrl && m.kind !== "text");
  const filteredGallery = mediaMessages.filter((m) => {
    if (activeMediaTab === "all") return true;
    return m.kind === activeMediaTab;
  });

  const starredMessagesList = messages.filter((m) => starredIds.has(m.id));

  const push = async (
    kind: MediaKind,
    extra: Partial<Omit<Message, "id" | "createdAt" | "authorId" | "authorName">>,
  ) => {
    const ok = await sendMessage({ spaceId: space.id, kind, ...extra });
    if (ok) {
      playChime("send", mutedSound);
    } else {
      toast.error("Message failed to send — check your connection");
    }
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
      playChime("send", mutedSound);
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
      playChime("send", mutedSound);
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
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
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
      setRecordSecs(0);
      recordTimerRef.current = setInterval(() => {
        setRecordSecs((s) => s + 1);
      }, 1000);
    } catch {
      audioInputRef.current?.click();
    }
  };

  const handleShareLocation = () => {
    if (typeof window === "undefined" || !navigator.geolocation) {
      toast.error("Geolocation is not supported by your browser");
      return;
    }
    toast.info("Acquiring GPS location...");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        void push("location", {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          locationName: "Current GPS Location",
        });
        toast.success("Location shared!");
      },
      (err) => {
        toast.error(`Location access error: ${err.message}`);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const typingArray = Array.from(typingUsers);

  const getWallpaperStyle = () => {
    if (wallpaper === "dots") {
      return { backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)", backgroundSize: "16px 16px" };
    }
    if (wallpaper === "grid") {
      return { backgroundImage: "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)", backgroundSize: "24px 24px" };
    }
    if (wallpaper === "cosmic") {
      return { backgroundImage: "radial-gradient(circle at 50% 50%, var(--primary) 0%, transparent 70%)", opacity: 0.15 };
    }
    return {};
  };

  const getPhotoFilterStyle = () => {
    if (activePhotoFilter === "grayscale") return "grayscale(100%)";
    if (activePhotoFilter === "sepia") return "sepia(100%)";
    if (activePhotoFilter === "vintage") return "sepia(50%) contrast(120%) brightness(90%)";
    if (activePhotoFilter === "neon") return "saturate(200%) contrast(130%)";
    return "none";
  };

  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
  const charCount = text.length;

  if (isLocked) {
    return (
      <section className="chat-canvas flex h-full flex-1 flex-col items-center justify-center p-6 text-center">
        <div className="w-full max-w-sm rounded-3xl bg-card border border-border p-6 shadow-2xl space-y-4 flex flex-col items-center animate-in zoom-in-95 duration-200">
          <div className="flex size-14 items-center justify-center rounded-full bg-primary/15 text-primary">
            <Lock className="size-7" />
          </div>
          <div>
            <h3 className="font-bold text-base text-foreground">{space.name} is Locked</h3>
            <p className="text-xs text-muted-foreground mt-1">Enter your 4-digit PIN to access messages</p>
          </div>
          <input
            type="password"
            maxLength={4}
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && unlockSpace()}
            placeholder="••••"
            className="w-36 text-center font-mono text-2xl tracking-widest rounded-xl bg-background py-2.5 outline-none ring-1 ring-input focus:ring-primary"
          />
          <button
            type="button"
            onClick={unlockSpace}
            className="w-full rounded-xl bg-primary py-2.5 text-xs font-bold text-primary-foreground shadow-lg transition-transform hover:scale-102"
          >
            Unlock Space
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="chat-canvas flex h-full min-w-0 flex-1 flex-col" style={getWallpaperStyle()}>
      <header className="flex flex-col border-b border-border bg-sidebar px-3 py-2.5 sm:px-4 sm:py-3">
        <div className="flex items-center gap-2 sm:gap-3">
          <button
            type="button"
            onClick={onOpenSidebar}
            className="inline-flex items-center gap-1 rounded-xl bg-primary px-2.5 py-1.5 text-xs font-bold text-primary-foreground shadow-xs transition-opacity hover:opacity-90 md:hidden shrink-0"
            aria-label="Open spaces menu"
          >
            <ChevronLeft className="size-4" />
            <span>Spaces</span>
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-bold text-foreground">{space.name}</h2>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span className="font-mono text-primary font-semibold">Code: {space.code}</span>
              <span className="flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-emerald-400" />
                {activeMembers.length} active
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1 overflow-x-auto thin-scroll max-w-[50%] sm:max-w-none">
            <button
              type="button"
              onClick={() => setShowPinSetup((v) => !v)}
              title={spacePin ? "Lock Space / PIN Settings" : "Set Space PIN Lock"}
              className={
                "rounded-xl bg-card p-2 text-muted-foreground hover:text-primary transition-colors shrink-0 " +
                (spacePin ? "text-primary ring-1 ring-primary/40" : "")
              }
            >
              {spacePin ? <Lock className="size-4 text-primary" /> : <Unlock className="size-4" />}
            </button>

            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setShowDisappearingMenu((v) => !v)}
                title="Disappearing Messages"
                className={
                  "rounded-xl bg-card p-2 text-muted-foreground hover:text-primary transition-colors " +
                  (disappearingTimer !== "off" ? "text-primary ring-1 ring-primary" : "")
                }
              >
                <Clock className="size-4" />
              </button>
              {showDisappearingMenu && (
                <div className="absolute right-0 top-10 z-40 w-40 rounded-xl border border-border bg-card p-1.5 shadow-2xl animate-in zoom-in-95 duration-150">
                  <div className="px-2 py-1 text-[10px] uppercase font-bold text-muted-foreground">Auto-destruct</div>
                  {(["off", "24h", "7d", "30d"] as DisappearingTimer[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => changeDisappearingTimer(t)}
                      className={
                        "flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors " +
                        (disappearingTimer === t ? "bg-primary text-primary-foreground font-semibold" : "hover:bg-secondary text-muted-foreground")
                      }
                    >
                      <span>{t === "off" ? "Off (Permanent)" : t}</span>
                      {disappearingTimer === t && <Check className="size-3" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={exportChatHistory}
              title="Export Chat Backup"
              className="rounded-xl bg-card p-2 text-muted-foreground hover:text-primary transition-colors shrink-0"
            >
              <FileDown className="size-4" />
            </button>

            <button
              type="button"
              onClick={() => setShowGalleryModal(true)}
              title="Space Media Gallery"
              className="rounded-xl bg-card p-2 text-muted-foreground hover:text-primary transition-colors shrink-0"
            >
              <FolderOpen className="size-4" />
            </button>

            <button
              type="button"
              onClick={() => setMutedSound((v) => !v)}
              title={mutedSound ? "Unmute sounds" : "Mute sounds"}
              className="rounded-xl bg-card p-2 text-muted-foreground hover:text-primary transition-colors shrink-0"
            >
              {mutedSound ? <VolumeX className="size-4 text-destructive" /> : <Volume2 className="size-4 text-primary" />}
            </button>

            <div className="relative shrink-0">
              <button
                type="button"
                onClick={() => setShowWallpaperMenu((v) => !v)}
                title="Chat Wallpaper"
                className="rounded-xl bg-card p-2 text-muted-foreground hover:text-primary transition-colors"
              >
                <Sparkles className="size-4" />
              </button>
              {showWallpaperMenu && (
                <div className="absolute right-0 top-10 z-40 w-36 rounded-xl border border-border bg-card p-1.5 shadow-2xl animate-in zoom-in-95 duration-150">
                  {(["default", "dots", "grid", "cosmic"] as WallpaperStyle[]).map((w) => (
                    <button
                      key={w}
                      type="button"
                      onClick={() => changeWallpaper(w)}
                      className={
                        "flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs capitalize transition-colors " +
                        (wallpaper === w ? "bg-primary text-primary-foreground font-semibold" : "hover:bg-secondary text-muted-foreground")
                      }
                    >
                      <span>{w}</span>
                      {wallpaper === w && <Check className="size-3" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => setShowStarredModal(true)}
              title="Starred Messages"
              className="relative rounded-xl bg-card p-2 text-muted-foreground hover:text-amber-400 transition-colors shrink-0"
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
                "rounded-xl bg-card p-2 text-muted-foreground hover:text-primary transition-colors shrink-0 " +
                (showSearch ? "text-primary ring-1 ring-primary" : "")
              }
            >
              <Search className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => void shareSpace()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-secondary px-2.5 py-2 text-xs font-semibold transition-colors hover:text-primary shrink-0"
            >
              <Share2 className="size-3.5" />
              <span className="hidden sm:inline">Share</span>
            </button>
            <IconBtn label="Start voice call" onClick={() => setCallMode("voice")} className="shrink-0">
              <Phone className="size-3.5" />
            </IconBtn>
            <IconBtn label="Start video call" onClick={() => setCallMode("video")} className="shrink-0">
              <Video className="size-3.5" />
            </IconBtn>
          </div>
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
            onReply={handleReplyQuote}
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
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            {QUICK_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => setText((t) => t + emoji)}
                className="flex size-7 shrink-0 items-center justify-center rounded-full bg-card text-sm transition-transform hover:scale-125 hover:bg-secondary"
              >
                {emoji}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            {charCount > 0 && (
              <span className="text-[10px] font-mono text-muted-foreground">
                {charCount} chars · {wordCount} words
              </span>
            )}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowGifsMenu((v) => !v)}
                className="inline-flex items-center gap-1 rounded-full bg-card px-2.5 py-1 text-[11px] font-semibold text-primary border border-border hover:bg-secondary transition-colors"
              >
                <span>🖼️ GIFs & Stickers</span>
              </button>

              {showGifsMenu && (
                <div className="absolute right-0 bottom-8 z-40 w-64 rounded-2xl border border-border bg-card p-2 shadow-2xl animate-in zoom-in-95 duration-150 space-y-2">
                  <div className="px-2 py-0.5 text-[10px] uppercase font-bold text-muted-foreground">GIFs & Animated Stickers</div>
                  <div className="grid grid-cols-2 gap-1.5 max-h-48 overflow-y-auto thin-scroll p-1">
                    {[
                      { label: "Party 🎉", url: "https://media.giphy.com/media/l2JIdnF6aJnAqzmy4/giphy.gif" },
                      { label: "Mindblown 🤯", url: "https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif" },
                      { label: "High Five 🙌", url: "https://media.giphy.com/media/3oEJHV0z8S7WM4MwnK/giphy.gif" },
                      { label: "Dance 💃", url: "https://media.giphy.com/media/l3vRlT2k2L35CboWY/giphy.gif" },
                      { label: "Cat Vibe 🐱", url: "https://media.giphy.com/media/GeimqsH0TLDt4tScGw/giphy.gif" },
                      { label: "Applause 👏", url: "https://media.giphy.com/media/g9582DNuQppxC/giphy.gif" },
                      { label: "Cool 😎", url: "https://media.giphy.com/media/l41YkxvU8c7J7Bba0/giphy.gif" },
                      { label: "Shocked 😱", url: "https://media.giphy.com/media/LpLd2NGvOtAXVAkEFz/giphy.gif" },
                    ].map((gif) => (
                      <button
                        key={gif.url}
                        type="button"
                        onClick={() => {
                          setShowGifsMenu(false);
                          void push("image", { dataUrl: gif.url, fileName: `${gif.label}.gif` });
                        }}
                        className="group relative overflow-hidden rounded-xl border border-border bg-secondary/50 p-1 hover:border-primary transition-all"
                      >
                        <img src={gif.url} alt={gif.label} className="h-16 w-full object-cover rounded-lg group-hover:scale-105 transition-transform" />
                        <span className="mt-0.5 block truncate text-[9px] font-semibold text-center">{gif.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="relative">
              <button
                type="button"
                onClick={() => setShowSnippetsMenu((v) => !v)}
                className="inline-flex items-center gap-1 rounded-full bg-card px-2.5 py-1 text-[11px] font-semibold text-primary border border-border hover:bg-secondary transition-colors"
              >
                <Zap className="size-3 text-amber-400 fill-amber-400" />
                <span>Snippets</span>
              </button>

              {showSnippetsMenu && (
                <div className="absolute right-0 bottom-8 z-40 w-64 rounded-2xl border border-border bg-card p-2 shadow-2xl animate-in zoom-in-95 duration-150 space-y-1">
                  <div className="px-2 py-1 text-[10px] uppercase font-bold text-muted-foreground">Quick Templates</div>
                  {DRAFT_TEMPLATES.map((tmpl, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        setText(tmpl);
                        setShowSnippetsMenu(false);
                      }}
                      className="w-full text-left rounded-xl px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors truncate"
                    >
                      {tmpl}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {typingArray.length > 0 && (
          <div className="mb-2 flex items-center gap-2 px-1 text-xs text-muted-foreground italic animate-pulse">
            <span className="size-2 rounded-full bg-primary animate-ping" />
            <span>
              {typingArray.join(", ")} {typingArray.length === 1 ? "is" : "are"} typing...
            </span>
          </div>
        )}

        {recording && (
          <div className="mb-2 flex items-center gap-3 rounded-xl bg-destructive/15 border border-destructive/30 px-3 py-2 text-xs text-destructive animate-pulse">
            <span className="size-2.5 rounded-full bg-destructive animate-ping" />
            <span className="font-semibold">Recording Voice Note...</span>
            <span className="font-mono font-bold">
              {Math.floor(recordSecs / 60)}:{String(recordSecs % 60).padStart(2, "0")}
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
            <IconBtn label="Share Location" onClick={handleShareLocation}>
              <MapPin className="size-4 text-emerald-400" />
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
            className={recording ? "bg-destructive text-foreground animate-bounce" : ""}
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

      {/* PIN Setup Modal */}
      {showPinSetup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="w-full max-w-xs rounded-3xl bg-card border border-border p-5 shadow-2xl flex flex-col items-center text-center space-y-4">
            <div className="flex size-12 items-center justify-center rounded-full bg-primary/15 text-primary">
              <KeyRound className="size-6" />
            </div>
            <div>
              <h3 className="font-bold text-sm">Space Lock PIN</h3>
              <p className="text-xs text-muted-foreground mt-0.5">Protect this Space with a 4-digit code</p>
            </div>
            <input
              type="password"
              maxLength={4}
              value={newPinInput}
              onChange={(e) => setNewPinInput(e.target.value)}
              placeholder="1234"
              className="w-32 text-center font-mono text-xl tracking-widest rounded-xl bg-background py-2 outline-none ring-1 ring-input focus:ring-primary"
            />
            <div className="flex gap-2 w-full pt-1">
              {spacePin ? (
                <button
                  type="button"
                  onClick={removePin}
                  className="flex-1 rounded-xl bg-secondary py-2 text-xs font-semibold text-destructive hover:bg-destructive/10"
                >
                  Remove PIN
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowPinSetup(false)}
                  className="flex-1 rounded-xl bg-secondary py-2 text-xs font-semibold text-muted-foreground"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                onClick={savePin}
                className="flex-1 rounded-xl bg-primary py-2 text-xs font-bold text-primary-foreground"
              >
                Save PIN
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Media Gallery Modal */}
      {showGalleryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="w-full max-w-2xl rounded-2xl bg-card border border-border p-5 shadow-2xl flex flex-col max-h-[85vh]">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <FolderOpen className="size-5 text-primary" />
                <h3 className="font-bold text-sm">Space Media Gallery ({filteredGallery.length})</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowGalleryModal(false)}
                className="rounded-full p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="flex gap-1 border-b border-border py-2 text-xs">
              {(["all", "image", "video", "audio", "file"] as MediaTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveMediaTab(tab)}
                  className={
                    "rounded-lg px-3 py-1.5 capitalize font-medium transition-colors " +
                    (activeMediaTab === tab ? "bg-primary text-primary-foreground font-bold" : "text-muted-foreground hover:bg-secondary")
                  }
                >
                  {tab === "all" ? "All Media" : tab + "s"}
                </button>
              ))}
            </div>

            <div className="thin-scroll flex-1 overflow-y-auto my-3 p-1">
              {filteredGallery.length === 0 ? (
                <p className="py-12 text-center text-xs text-muted-foreground">
                  No attachments found in this category.
                </p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {filteredGallery.map((m) => (
                    <div key={m.id} className="relative group rounded-xl border border-border bg-background p-2 flex flex-col justify-between">
                      {m.kind === "image" && (
                        <img
                          src={m.dataUrl}
                          alt={m.fileName || "Shared photo"}
                          onClick={() => setLightbox(m.dataUrl!)}
                          className="h-28 w-full object-cover rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
                        />
                      )}
                      {m.kind === "video" && (
                        <video src={m.dataUrl} controls className="h-28 w-full object-cover rounded-lg bg-black" />
                      )}
                      {m.kind === "audio" && (
                        <div className="p-3 flex flex-col items-center justify-center gap-2 bg-secondary/50 rounded-lg h-28 text-center">
                          <AudioLines className="size-8 text-primary" />
                          <span className="text-[10px] font-semibold truncate w-full">{m.fileName || "Voice Note"}</span>
                        </div>
                      )}
                      {m.kind === "file" && (
                        <div className="p-3 flex flex-col items-center justify-center gap-2 bg-secondary/50 rounded-lg h-28 text-center">
                          <FileText className="size-8 text-primary" />
                          <span className="text-[10px] font-semibold truncate w-full">{m.fileName || "Document"}</span>
                        </div>
                      )}
                      <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
                        <span className="truncate">{m.authorName}</span>
                        <a
                          href={m.dataUrl}
                          download={m.fileName || `heymama-${m.kind}-${Date.now()}`}
                          className="flex items-center gap-1 text-primary hover:underline font-semibold"
                        >
                          <Download className="size-3" /> Save
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

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
                    onPin={(message) => {
                      setPinnedMessage(message);
                      setShowStarredModal(false);
                      toast.success("Message pinned to top");
                    }}
                    onStar={toggleStar}
                    onReply={handleReplyQuote}
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
          onClick={() => {
            setLightbox(null);
            setActivePhotoFilter("none");
          }}
        >
          <div className="absolute right-5 top-5 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-full bg-card px-2 py-1 shadow-xl border border-border" onClick={(e) => e.stopPropagation()}>
              <Sliders className="size-3.5 text-primary ml-1" />
              {(["none", "grayscale", "sepia", "vintage", "neon"] as PhotoFilter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setActivePhotoFilter(f)}
                  className={
                    "rounded-full px-2 py-0.5 text-[10px] font-medium capitalize transition-colors " +
                    (activePhotoFilter === f ? "bg-primary text-primary-foreground font-bold" : "text-muted-foreground hover:text-foreground")
                  }
                >
                  {f}
                </button>
              ))}
            </div>
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
              onClick={() => {
                setLightbox(null);
                setActivePhotoFilter("none");
              }}
            >
              <X className="size-4" />
            </button>
          </div>
          <img
            src={lightbox}
            alt="Full size attachment"
            style={{ filter: getPhotoFilterStyle() }}
            className="max-h-[85vh] max-w-full rounded-2xl object-contain shadow-2xl border border-border transition-all duration-200"
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
