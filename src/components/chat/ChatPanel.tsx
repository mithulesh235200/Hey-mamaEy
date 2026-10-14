import { lazy, Suspense, useEffect, useRef, useState, type ClipboardEvent } from "react";
import { Capacitor } from "@capacitor/core";
import { QRCodeSVG } from "qrcode.react";
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
  MessageSquare,
  Music,
  HardDrive,
  MoreHorizontal,
  Plus,
  Smile,
  Reply,
  Trash2,
  Bell,
  BellOff,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  formatBytes,
  readFileAsDataUrl,
  deleteSpaceForEveryone,
  deleteMessage,
  editMessage,
  hideMessageForMe,
  sendMessage,
  getLastSendError,
  leaveSpace,
  markSpaceMessagesRead,
  markSpaceAsRead,
  isOffline,
  useOnline,
  THREAD_MARKER,
  type MediaKind,
  type Message,
  type Space,
} from "@/lib/heymama";
import { MessageBubble } from "./MessageBubble";
import { createP2PSender } from "@/lib/p2p-file";
import { dataUrlToBlob, saveAttachmentToDevice, uploadAttachment } from "@/lib/attachments";
import {
  ACCEPT_AUDIO,
  ACCEPT_DOCUMENT,
  ACCEPT_IMAGE_VIDEO,
  validateUserFile,
} from "@/lib/fileValidation";

const InAppCall = lazy(() =>
  import("./InAppCall").then((module) => ({ default: module.InAppCall })),
);

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB server-upload limit (larger files: use P2P Direct Share)
const POLL_VOTE_PREFIX = "__poll_vote__:";
const QUOTE_PREFIX = "> Replying to @";

/** Editable body: drop the quote line (reply) so Edit never shows raw quote syntax. */
function stripForEdit(text: string): string {
  if (!text.startsWith(QUOTE_PREFIX)) return text;
  const newline = text.indexOf("\n");
  return newline === -1 ? "" : text.slice(newline + 1);
}

// Reuse one AudioContext: creating a new one per chime leaks contexts and
// browsers cap them (sound stops after a handful of messages).
let sharedAudioCtx: AudioContext | null = null;
function getSharedAudioCtx(): AudioContext | null {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
      sharedAudioCtx = new AudioCtx();
    }
    if (sharedAudioCtx.state === "suspended") void sharedAudioCtx.resume();
    return sharedAudioCtx;
  } catch {
    return null;
  }
}

function playChime(type: "send" | "receive", muted: boolean) {
  if (muted) return;
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
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
  mobileQuickBar,
}: {
  space: Space | null;
  messages: Message[];
  userId: string;
  displayName: string;
  onForward: (m: Message) => void;
  onOpenSidebar: () => void;
  mobileQuickBar: boolean;
}) {
  const [text, setText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [showMobileActions, setShowMobileActions] = useState(false);
  const [showMobileAttachments, setShowMobileAttachments] = useState(false);
  const [showMobileEmojis, setShowMobileEmojis] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [activePhotoFilter, setActivePhotoFilter] = useState<PhotoFilter>("none");
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const [editing, setEditing] = useState<Message | null>(null);
  // Inline reply-quote target: shown as a preview chip above the composer
  // instead of raw `> Replying to...` text inside the input.
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [pinnedMessage, setPinnedMessage] = useState<Message | null>(null);
  const [mutedSound, setMutedSound] = useState(false);
  const [soundEffectsEnabled, setSoundEffectsEnabled] = useState(true);
  const [typingIndicatorsEnabled, setTypingIndicatorsEnabled] = useState(true);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    () => localStorage.getItem("heymamaey.notifications") === "true",
  );
  const [spaceNotificationsMuted, setSpaceNotificationsMuted] = useState(false);
  const [wallpaper, setWallpaper] = useState<WallpaperStyle>(() => {
    return (localStorage.getItem("heymamaey.wallpaper") as WallpaperStyle) || "default";
  });
  const [disappearingTimer, setDisappearingTimer] = useState<DisappearingTimer>(() => {
    return (
      (localStorage.getItem(`heymamaey.disappearing.${space?.id}`) as DisappearingTimer) || "off"
    );
  });
  const [showDisappearingMenu, setShowDisappearingMenu] = useState(false);
  const [showWallpaperMenu, setShowWallpaperMenu] = useState(false);
  const [showSnippetsMenu, setShowSnippetsMenu] = useState(false);
  const [showGifsMenu, setShowGifsMenu] = useState(false);
  const [showGalleryModal, setShowGalleryModal] = useState(false);
  const [activeMediaTab, setActiveMediaTab] = useState<MediaTab>("all");

  // Thread Drawer State
  const [activeThreadMessage, setActiveThreadMessage] = useState<Message | null>(null);
  const [threadText, setThreadText] = useState("");

  // Soundboard FX State
  const [showSoundboard, setShowSoundboard] = useState(false);

  // Storage Manager State
  const [showStorageManager, setShowStorageManager] = useState(false);
  const [storageCategory, setStorageCategory] = useState<
    "all" | "image" | "video" | "audio" | "file"
  >("all");
  const [storageSearch, setStorageSearch] = useState("");

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
  const [roomPasswordInput, setRoomPasswordInput] = useState("");
  // Owner's "add/change room password" box uses its own input so it never
  // clobbers the "enter password to unlock" field (they shared state before).
  const [roomPasswordSettingInput, setRoomPasswordSettingInput] = useState("");
  const [showRoomPasswordBox, setShowRoomPasswordBox] = useState(false);
  const [showAccessBox, setShowAccessBox] = useState(false);
  const [kickInput, setKickInput] = useState("");
  const [bans, setBans] = useState<{ userId: string; bannedAt: number }[]>([]);
  const [bansLoading, setBansLoading] = useState(false);
  const isOwner = space?.ownerId === userId;
  const readOnlyForMe = Boolean(space?.isReadonly && !isOwner);
  const lockedCount = messages.filter((m) => m.locked).length;

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
  const [showDeleteSpaceModal, setShowDeleteSpaceModal] = useState(false);
  const [deleteSpaceMode, setDeleteSpaceMode] = useState<"me" | "everyone">("me");
  const [deletingSpace, setDeletingSpace] = useState(false);
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [callMode, setCallMode] = useState<"voice" | "video" | null>(null);
  const [activeMembers, setActiveMembers] = useState<Array<{ userId: string; name: string }>>([]);
  // Typing state keyed by userId (names can collide, e.g. two "Anonymous").
  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  // Poll creation modal state
  const [showPollModal, setShowPollModal] = useState(false);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState<string[]>(["", ""]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const nearBottomRef = useRef(true);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const p2pFileInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingExpiryRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const presenceChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const knownMessageIdsRef = useRef(new Set(messages.map((message) => message.id)));
  const notificationSpaceIdRef = useRef(space?.id);

  useEffect(() => {
    const syncPreferences = () => {
      setSoundEffectsEnabled(localStorage.getItem("heymamaey.sounds") !== "false");
      const typingEnabled = localStorage.getItem("heymamaey.typing") !== "false";
      setTypingIndicatorsEnabled(typingEnabled);
      setNotificationsEnabled(localStorage.getItem("heymamaey.notifications") === "true");
      if (!typingEnabled) {
        if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
        void presenceChannelRef.current?.send({
          type: "broadcast",
          event: "typing-stop",
          payload: { name: displayName.trim() || "Anonymous", userId },
        });
      }
    };
    syncPreferences();
    window.addEventListener("heymamaey:preferences-updated", syncPreferences);
    return () => window.removeEventListener("heymamaey:preferences-updated", syncPreferences);
  }, [displayName, userId]);

  useEffect(() => {
    if (space?.id) {
      const savedPin = localStorage.getItem(`heymamaey.pin.${space.id}`) || "";
      setSpacePin(savedPin);
      setIsLocked(Boolean(savedPin));
      setPinInput("");
    }
  }, [space?.id]);

  useEffect(() => {
    if (!space?.id) return;
    try {
      const muted = JSON.parse(
        localStorage.getItem("heymamaey.notificationMutedSpaces") || "[]",
      ) as string[];
      setSpaceNotificationsMuted(muted.includes(space.id));
    } catch {
      setSpaceNotificationsMuted(false);
    }
  }, [space?.id]);

  useEffect(() => {
    if (!space || !userId || document.hidden) return;
    let cancelled = false;
    const markRead = async () => {
      const ok = await markSpaceMessagesRead(space.code, userId);
      if (ok && !cancelled) markSpaceAsRead(space.id);
    };
    void markRead();
    const onVisibilityChange = () => {
      if (!document.hidden) void markRead();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [space, userId, messages.length]);

  useEffect(() => {
    if (notificationSpaceIdRef.current !== space?.id) {
      notificationSpaceIdRef.current = space?.id;
      knownMessageIdsRef.current = new Set(messages.map((message) => message.id));
      return;
    }
    const newlyReceived = messages.filter(
      (message) =>
        !knownMessageIdsRef.current.has(message.id) &&
        message.authorId !== userId &&
        !message.text?.startsWith("__poll_vote__:"),
    );
    messages.forEach((message) => knownMessageIdsRef.current.add(message.id));
    if (knownMessageIdsRef.current.size > 1000) {
      knownMessageIdsRef.current = new Set(messages.map((message) => message.id));
    }
    const last = newlyReceived.at(-1);
    if (last) {
      playChime("receive", mutedSound || !soundEffectsEnabled);
      const mutedSpaceIds = (() => {
        try {
          return JSON.parse(
            localStorage.getItem("heymamaey.notificationMutedSpaces") || "[]",
          ) as string[];
        } catch {
          return [];
        }
      })();
      if (
        typeof window !== "undefined" &&
        document.hidden &&
        notificationsEnabled &&
        !mutedSpaceIds.includes(last.spaceId) &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
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
  }, [
    messages,
    userId,
    mutedSound,
    soundEffectsEnabled,
    notificationsEnabled,
    space?.id,
    space?.name,
  ]);

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

  // Saves any Supabase-hosted attachment to phone/desktop local storage.
  // Uses fetch-then-blob so cross-origin Supabase URLs actually download
  // instead of just opening in a new tab.
  const handleSaveAttachment = async (dataUrl: string | undefined, fileName?: string) => {
    if (!dataUrl) {
      toast.error("No file to save");
      return;
    }
    try {
      toast.info("Saving to your device...");
      const result = await saveAttachmentToDevice(
        dataUrl,
        fileName || `space-connect-file-${Date.now()}`,
      );
      if (result.ok) {
        if (!result.shared) toast.success("Saved to your device!");
      } else {
        toast.error("Couldn't save yet — file opened in a new tab", {
          description: "Long-press / right-click the file and choose Save.",
        });
      }
    } catch {
      toast.error("Couldn't save this file");
    }
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

  const focusComposer = () => {
    // Let state flush first so focus lands after the reply/edit chip renders.
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const handleReplyQuote = (m: Message) => {
    setEditing(null);
    setReplyTo(m);
    focusComposer();
  };

  const handleStartEdit = (m: Message) => {
    setReplyTo(null);
    setEditing(m);
    // Editing a reply used to dump the raw `> Replying to ...` quote and the
    // hidden thread marker into the box. Show only the editable body.
    setText(stripForEdit(m.text ?? ""));
    focusComposer();
  };

  const replySnippet = (m: Message) => {
    const raw = m.text
      ? stripForEdit(m.text).length > 60
        ? stripForEdit(m.text).slice(0, 60) + "..."
        : stripForEdit(m.text)
      : m.fileName || "attachment";
    // Never nest a quote inside a quote preview.
    const firstLine = raw.split("\n")[0] ?? "";
    return firstLine.startsWith("> Replying to @") ? "message" : firstLine;
  };

  // "Delete for me" hides any message (including a friend's) on this device
  // only. "Delete for everyone" removes your own message from the server.
  const handleDeleteForMe = (message: Message) => {
    if (pinnedMessage?.id === message.id) setPinnedMessage(null);
    setStarredIds((prev) => {
      if (!prev.has(message.id)) return prev;
      const next = new Set(prev);
      next.delete(message.id);
      return next;
    });
    const hidden = hideMessageForMe(message.id);
    toast[hidden ? "success" : "info"](
      hidden ? "Deleted for you only — others can still see it" : "Already deleted for you",
    );
  };

  const handleDeleteForEveryone = async (message: Message) => {
    if (!window.confirm("Delete this message for everyone?")) return;
    const deleted = await deleteMessage(message.id, message.spaceId);
    toast[deleted ? "success" : "error"](
      deleted ? "Message deleted for everyone" : "Message could not be deleted",
    );
  };

  useEffect(() => {
    if (!space) return;
    const channel = supabase.channel(`presence:${space.code}`, {
      config: { broadcast: { self: false } },
    });
    presenceChannelRef.current = channel;

    const updateMembers = () => {
      const state = channel.presenceState<{ name?: string; userId?: string }>();
      const seen = new Map<string, string>();
      for (const entries of Object.values(state)) {
        for (const entry of entries) {
          const name = entry.name?.trim();
          const id = entry.userId?.trim() || name;
          if (!name || !id) continue;
          if (!seen.has(id)) seen.set(id, name);
        }
      }
      setActiveMembers([...seen.entries()].map(([userId, name]) => ({ userId, name })));
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
          const previousTimer = typingExpiryRef.current.get(payload.userId);
          if (previousTimer) clearTimeout(previousTimer);
          const label = payload.name?.trim() || "Anonymous";
          setTypingUsers((prev) => new Map(prev).set(payload.userId, label));
          typingExpiryRef.current.set(
            payload.userId,
            setTimeout(() => {
              setTypingUsers((prev) => {
                const next = new Map(prev);
                next.delete(payload.userId);
                return next;
              });
              typingExpiryRef.current.delete(payload.userId);
            }, 4000),
          );
        },
      )
      .on(
        "broadcast",
        { event: "typing-stop" },
        ({ payload }: { payload: { name: string; userId: string } }) => {
          if (payload.userId === userId) return;
          const timer = typingExpiryRef.current.get(payload.userId);
          if (timer) clearTimeout(timer);
          typingExpiryRef.current.delete(payload.userId);
          setTypingUsers((prev) => {
            const next = new Map(prev);
            next.delete(payload.userId);
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

    const typingTimers = typingExpiryRef.current;
    return () => {
      void channel.untrack();
      void channel.unsubscribe();
      typingTimers.forEach(clearTimeout);
      typingTimers.clear();
      presenceChannelRef.current = null;
      setActiveMembers([]);
      setTypingUsers(new Map());
    };
  }, [displayName, space, userId]);

  // Reload per-space disappearing timer when switching spaces (useState
  // initializer only runs once, so it went stale before).
  useEffect(() => {
    if (!space?.id) return;
    try {
      const saved = localStorage.getItem(
        `heymamaey.disappearing.${space.id}`,
      ) as DisappearingTimer | null;
      setDisappearingTimer(saved === "24h" || saved === "7d" || saved === "30d" ? saved : "off");
    } catch {
      setDisappearingTimer("off");
    }
    setShowDisappearingMenu(false);
    // Reset transient composer/panel state so one space never leaks into another.
    setReplyTo(null);
    setEditing(null);
    setText("");
    setThreadText("");
    setActiveThreadMessage(null);
    setSearchQuery("");
    setShowSearch(false);
    setRoomPasswordSettingInput("");
    nearBottomRef.current = true;
  }, [space?.id]);

  // Stop any in-progress voice recording when leaving / switching spaces.
  useEffect(() => {
    return () => {
      try {
        recorderRef.current?.stop();
      } catch {
        /* ignore */
      }
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, []);

  // Global Escape: close dropdowns, drawers and modals in a predictable order.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (showSoundboard) return setShowSoundboard(false);
      if (activeThreadMessage) return setActiveThreadMessage(null);
      if (lightbox) {
        setLightbox(null);
        setActivePhotoFilter("none");
        return;
      }
      if (showPollModal) return setShowPollModal(false);
      if (showGalleryModal) return setShowGalleryModal(false);
      if (showStarredModal) return setShowStarredModal(false);
      if (showStorageManager) return setShowStorageManager(false);
      if (showQrModal) return setShowQrModal(false);
      if (showDeleteSpaceModal) return setShowDeleteSpaceModal(false);
      if (showPinSetup) return setShowPinSetup(false);
      setShowGifsMenu(false);
      setShowSnippetsMenu(false);
      setShowDisappearingMenu(false);
      setShowWallpaperMenu(false);
      setShowMobileActions(false);
      setShowMobileAttachments(false);
      setShowMobileEmojis(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    showSoundboard,
    activeThreadMessage,
    lightbox,
    showPollModal,
    showGalleryModal,
    showStarredModal,
    showStorageManager,
    showQrModal,
    showDeleteSpaceModal,
    showPinSetup,
  ]);

  const handleTyping = (val: string) => {
    setText(val);
    if (!presenceChannelRef.current) return;
    const name = displayName.trim() || "Anonymous";

    if (!typingIndicatorsEnabled) {
      void presenceChannelRef.current.send({
        type: "broadcast",
        event: "typing-stop",
        payload: { name, userId },
      });
      return;
    }

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
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isUp = distanceFromBottom > 150;
    nearBottomRef.current = distanceFromBottom < 80;
    setShowScrollBottom(isUp);
  };

  const scrollToBottom = () => {
    nearBottomRef.current = true;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const shareSpace = () => {
    setShowQrModal(true);
  };

  const toggleSpaceNotifications = () => {
    if (!space) return;
    let mutedIds: string[] = [];
    try {
      mutedIds = JSON.parse(
        localStorage.getItem("heymamaey.notificationMutedSpaces") || "[]",
      ) as string[];
    } catch {
      mutedIds = [];
    }
    const nextMuted = spaceNotificationsMuted
      ? mutedIds.filter((id) => id !== space.id)
      : [...new Set([...mutedIds, space.id])];
    localStorage.setItem("heymamaey.notificationMutedSpaces", JSON.stringify(nextMuted));
    setSpaceNotificationsMuted(!spaceNotificationsMuted);
    toast.success(spaceNotificationsMuted ? "Space notifications enabled" : "Space muted");
  };

  const publicAppUrl = import.meta.env["VITE_PUBLIC_APP_URL"]?.trim().replace(/\/+$/, "") || "";
  const browserOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const canShareBrowserOrigin =
    typeof window !== "undefined" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const inviteBaseUrl =
    publicAppUrl || (Capacitor.isNativePlatform() || !canShareBrowserOrigin ? "" : browserOrigin);
  const inviteUrl =
    inviteBaseUrl && space
      ? `${inviteBaseUrl}${window.location.pathname}?space=${encodeURIComponent(space.code)}`
      : "";

  const copyInviteLink = async () => {
    try {
      const valueToCopy = inviteUrl || space?.code;
      if (!valueToCopy) return;
      await navigator.clipboard.writeText(valueToCopy);
      setCopiedInvite(true);
      toast.success(inviteUrl ? "Invite link copied!" : "Space code copied!");
      setTimeout(() => setCopiedInvite(false), 2000);
    } catch {
      toast.error("Couldn't copy invite link");
    }
  };

  const confirmDeleteSpace = async () => {
    if (!space || deletingSpace) return;
    setDeletingSpace(true);
    try {
      if (deleteSpaceMode === "me") {
        const removed = leaveSpace(space.id);
        if (removed) {
          toast.success(`Removed “${space.name}” from your spaces`);
          setShowDeleteSpaceModal(false);
        } else {
          toast.error("Couldn't remove this space from your account");
        }
        return;
      }

      if (space.ownerId !== userId) {
        toast.error("Only the space owner can delete it for everyone");
        return;
      }

      const removed = await deleteSpaceForEveryone(space.id);
      if (removed) {
        toast.success(`“${space.name}” was deleted for everyone`);
        setShowDeleteSpaceModal(false);
      } else {
        toast.error("Couldn't delete the space for everyone. Check the connection and try again.");
      }
    } finally {
      setDeletingSpace(false);
    }
  };

  useEffect(() => {
    // Don't yank the user away from history: only auto-scroll when they were
    // already near the bottom (or just switched spaces).
    if (!nearBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, space?.id]);

  // Hooks must run before any early return (Rules of Hooks).
  const online = useOnline();

  // WhatsApp-like composer: grow with content up to max-h-32, then scroll.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = 128;
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [text, space?.id]);

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
    if (m.text?.startsWith(POLL_VOTE_PREFIX)) return false;
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

  const handlePollVote = (poll: Message, option: number) => {
    const voteText = `${POLL_VOTE_PREFIX}${poll.id}:${option}`;
    const previousVote = [...messages]
      .reverse()
      .find(
        (candidate) =>
          candidate.authorId === userId &&
          candidate.text?.startsWith(`${POLL_VOTE_PREFIX}${poll.id}:`),
      );
    if (previousVote?.text === voteText) return;
    void sendMessage({ spaceId: poll.spaceId, kind: "text", text: voteText }).then((sent) => {
      if (!sent) toast.error("Your poll vote could not be saved. Check your connection.");
    });
  };

  const push = async (
    kind: MediaKind,
    extra: Partial<Omit<Message, "id" | "createdAt" | "authorId" | "authorName">>,
  ) => {
    if (readOnlyForMe) {
      toast.error("Read-only room", { description: "Only the host can post here." });
      return;
    }
    const offline = isOffline();
    const ok = await sendMessage({ spaceId: space.id, kind, ...extra });
    if (ok) {
      if (offline) {
        toast.info("Saved offline — will send when you reconnect");
      } else {
        playChime("send", mutedSound || !soundEffectsEnabled);
      }
    } else {
      sendFailureToast();
    }
  };

  const sendFailureToast = () => {
    if (isOffline()) {
      toast.error("You're offline — files and media need a connection");
      return;
    }
    const reason = getLastSendError();
    if (reason === "SPACE_READ_ONLY") {
      toast.error("Read-only room", {
        description: "Only the host can post here.",
      });
      return;
    }
    if (reason === "SPACE_USER_BANNED") {
      toast.error("You were removed", {
        description: "The host removed this ID from the Space.",
      });
      leaveSpace(space.id);
      return;
    }
    if (reason === "SPACE_LOCKED") {
      toast.error("Room is locked", {
        description: "The host locked this room.",
      });
      return;
    }
    toast.error("Message failed to send — check your connection");
  };

  const loadBans = async () => {
    setBansLoading(true);
    try {
      const { getSpaceBans } = await import("@/lib/heymama");
      setBans(await getSpaceBans(space.id));
    } finally {
      setBansLoading(false);
    }
  };

  const submitText = async () => {
    const value = text.trim();
    if (!value) return;
    if (readOnlyForMe) {
      toast.error("Read-only room", { description: "Only the host can post here." });
      return;
    }
    if (presenceChannelRef.current) {
      void presenceChannelRef.current.send({
        type: "broadcast",
        event: "typing-stop",
        payload: { name: displayName.trim() || "Anonymous", userId },
      });
    }

    if (editing) {
      // Preserve the original reply quote (Edit box shows body only), and
      // re-attach the thread marker so the reply stays in its thread.
      const originalQuote =
        editing.text?.startsWith(QUOTE_PREFIX) && editing.text.includes("\n")
          ? editing.text.slice(0, editing.text.indexOf("\n"))
          : null;
      const bodyToSave = originalQuote ? `${originalQuote}\n${value}` : value;
      const savedText = editing.threadParentId
        ? `${bodyToSave}${THREAD_MARKER}${editing.threadParentId}`
        : bodyToSave;
      const updated = await editMessage(editing.id, space.id, savedText);
      if (updated) {
        setText("");
        setEditing(null);
        setReplyTo(null);
      } else {
        toast.error("Message could not be edited");
      }
      return;
    }
    // Attach the reply quote as the first line (same wire format as before,
    // now rendered as a styled quote block instead of raw text).
    const outgoing = replyTo
      ? `> Replying to @${replyTo.authorName || "User"}: "${replySnippet(replyTo)}"\n${value}`
      : value;
    const ok = await sendMessage({ spaceId: space.id, kind: "text", text: outgoing });
    if (ok) {
      const queued = isOffline();
      setText("");
      setReplyTo(null);
      if (queued) {
        toast.info("Saved offline — will send when you reconnect");
      } else {
        playChime("send", mutedSound || !soundEffectsEnabled);
      }
    } else if (!isOffline()) {
      sendFailureToast();
    } else {
      toast.error("You're offline — message not sent");
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

    const pollText =
      `📊 **POLL: ${pollQuestion.trim()}**\n` +
      validOptions.map((opt, i) => `${i + 1}. ${opt.trim()}`).join("\n");
    const ok = await sendMessage({ spaceId: space.id, kind: "text", text: pollText });
    if (ok) {
      const queued = isOffline();
      setShowPollModal(false);
      setPollQuestion("");
      setPollOptions(["", ""]);
      if (queued) {
        toast.info("Poll saved offline — will post on reconnect");
      } else {
        toast.success("Poll created!");
        playChime("send", mutedSound || !soundEffectsEnabled);
      }
    } else {
      toast.error(isOffline() ? "You're offline — poll not saved" : "Couldn't create poll");
    }
  };

  const handleFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const rawName = file.name || `pasted-image-${Date.now()}.png`;
      // Safety gate FIRST: executables, scripts, HTML/SVG and content that
      // doesn't match its extension are refused with no inline fallback.
      const verdict = await validateUserFile(file, rawName, file.type);
      if (!verdict.ok) {
        toast.error(`Blocked ${rawName}`, { description: verdict.error });
        continue;
      }
      const { kind, safeName, mime } = verdict;
      try {
        // Images are compressed first (existing behavior), then everything is
        // uploaded to Supabase Storage. Falls back to inline data when offline
        // or before the space-media migration is applied.
        const dataUrl = await readFileAsDataUrl(file);
        let remoteUrl: string | null = null;
        if (kind === "image") {
          const blob = await dataUrlToBlob(dataUrl);
          if (blob) {
            remoteUrl = await uploadAttachment(space.code, blob, safeName, mime);
          }
        } else {
          remoteUrl = await uploadAttachment(space.code, file, safeName, mime);
        }
        await push(kind, {
          dataUrl: remoteUrl ?? dataUrl,
          fileName: safeName,
          fileSize: file.size,
          mimeType: mime,
        });
      } catch {
        toast.error(`Couldn't read ${safeName}`);
      }
    }
  };

  // Lets users copy an image (screenshot, browser image, file) and paste it
  // straight into the composer. Copied web images often appear only as
  // clipboard items (not files), so both sources are checked. Plain-text
  // pastes fall through to the default behavior untouched.
  const handleComposerPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboard = e.clipboardData;
    if (!clipboard) return;
    const seen = new Set<string>();
    const pasted: File[] = [];
    const addFile = (f: File | null) => {
      if (!f) return;
      // clipboard.files and clipboard.items can describe the SAME file with
      // different object identities — dedupe by content key, not reference.
      const key = `${f.name}|${f.size}|${f.lastModified}|${f.type}`;
      if (seen.has(key)) return;
      seen.add(key);
      pasted.push(f);
    };
    if (clipboard.files && clipboard.files.length > 0) {
      Array.from(clipboard.files).forEach(addFile);
    }
    if (clipboard.items) {
      for (const item of Array.from(clipboard.items)) {
        if (item.kind === "file") addFile(item.getAsFile());
      }
    }
    if (pasted.length === 0) return;
    e.preventDefault();
    toast.info(`Sending pasted ${pasted.length === 1 ? "image" : `${pasted.length} files`}...`);
    void handleFiles(pasted);
  };

  const handleP2PFileShare = async (files: FileList | null) => {
    if (!files || !space) return;
    for (const file of Array.from(files)) {
      // Same safety gate as server uploads: P2P receivers download and open
      // these files, so executables/scripts/HTML are refused up front.
      const verdict = await validateUserFile(file, file.name, file.type);
      if (!verdict.ok) {
        toast.error(`Blocked ${file.name}`, { description: verdict.error });
        continue;
      }
      const transferId = `p2p_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      const sender = createP2PSender(transferId, file, userId);
      void sender.start();

      // Hybrid reliability: pure P2P dies the moment the sender closes the
      // tab, so also stash a server-side backup copy when the file fits.
      // The chat message carries it as `dataUrl`; receivers download from the
      // server when the sender is offline, and use live P2P otherwise.
      // Large files that don't fit still send P2P-only with a keep-tab warning.
      // (uploadAttachment re-validates and stores the canonical MIME.)
      let backupUrl: string | undefined;
      if (file.size <= MAX_BYTES) {
        try {
          toast.info(`Uploading backup copy of ${verdict.safeName}...`, {
            description: "So it stays downloadable even if you go offline.",
          });
          backupUrl =
            (await uploadAttachment(space.code, file, verdict.safeName, verdict.mime)) ?? undefined;
        } catch {
          backupUrl = undefined;
        }
      }

      await push("p2p_file", {
        p2pTransferId: transferId,
        p2pFileName: verdict.safeName,
        p2pFileSize: file.size,
        p2pMimeType: verdict.mime,
        ...(backupUrl !== undefined && { dataUrl: backupUrl }),
        text: `⚡ P2P Direct Stream: ${verdict.safeName} (${formatBytes(file.size)})`,
      });
      if (backupUrl) {
        toast.success(`Shared ${verdict.safeName}!`, {
          description: "Live P2P + server backup — stays downloadable if you leave.",
        });
      } else {
        toast.success(`Started P2P Direct Share for ${verdict.safeName}!`, {
          description:
            file.size > MAX_BYTES
              ? "Too large for server backup — keep this tab open until they accept, or the file is lost."
              : "Live P2P stream — keep this tab open until they accept.",
        });
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
        const rawMime = blob.type || "audio/webm";
        const baseMime = rawMime.split(";")[0]?.trim().toLowerCase() || "audio/webm";
        // Recorder output is generated locally (not an attacker file), but it
        // still goes through validation: give it a proper extension + check size.
        const voiceName = baseMime.includes("mp4") ? "Voice note.m4a" : "Voice note.webm";
        void (async () => {
          const verdict = await validateUserFile(blob, voiceName, baseMime);
          if (!verdict.ok) {
            toast.error("Voice note couldn't be saved", { description: verdict.error });
            return;
          }
          // Prefer Supabase Storage; fall back to inline data when unavailable.
          const url = await uploadAttachment(space.code, blob, verdict.safeName, verdict.mime);
          if (url) {
            void push("audio", {
              dataUrl: url,
              fileName: verdict.safeName,
              fileSize: blob.size,
              mimeType: verdict.mime,
            });
            return;
          }
          const reader = new FileReader();
          reader.onload = () =>
            push("audio", {
              dataUrl: String(reader.result),
              fileName: verdict.safeName,
              fileSize: blob.size,
              mimeType: verdict.mime,
            });
          reader.readAsDataURL(blob);
        })();
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
      toast.error("Location is not supported on this device");
      return;
    }
    toast.info("Acquiring GPS location...");

    const sendPosition = (pos: GeolocationPosition) => {
      void push("location", {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        locationName: "Current GPS Location",
      });
      toast.success("Location shared!");
    };

    const failFinal = (err: GeolocationPositionError) => {
      if (err.code === 1) {
        toast.error("Location permission denied", {
          description: "Allow location for this app in system settings, then try again.",
        });
      } else if (err.code === 3) {
        toast.error("Location timed out", {
          description: "Move somewhere with a clearer GPS signal and try again.",
        });
      } else {
        toast.error(`Location unavailable: ${err.message || "try again outdoors"}`);
      }
    };

    // High accuracy first (GPS); on timeout/unavailable retry with cached
    // low-power fix so indoor users still get a working share.
    navigator.geolocation.getCurrentPosition(
      sendPosition,
      (err) => {
        if (err.code === 1) {
          failFinal(err);
          return;
        }
        navigator.geolocation.getCurrentPosition(sendPosition, failFinal, {
          enableHighAccuracy: false,
          timeout: 20000,
          maximumAge: 120000,
        });
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  };

  const playFX = (name: string) => {
    if (!soundEffectsEnabled || mutedSound) return;
    try {
      const ctx = getSharedAudioCtx();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (name === "cheer") {
        osc.type = "triangle";
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.3);
      } else if (name === "airhorn") {
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(300, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(500, ctx.currentTime + 0.15);
      } else if (name === "party") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(523.25, ctx.currentTime);
        osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.1);
        osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.2);
      } else if (name === "chime") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(1046.5, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(2093, ctx.currentTime + 0.3);
      } else {
        osc.type = "square";
        osc.frequency.setValueAtTime(600, ctx.currentTime);
      }

      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);

      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } catch {
      /* ignore audio error */
    }
  };

  const sendSoundFX = (label: string, fxName: string) => {
    playFX(fxName);
    void push("text", { text: `🔊 [Soundboard FX]: ${label}` });
    setShowSoundboard(false);
  };

  const typingArray = typingIndicatorsEnabled ? [...typingUsers.values()] : [];
  const otherMembers = activeMembers.filter((m) => m.userId !== userId);
  const otherMemberNames = [...new Set(otherMembers.map((m) => m.name))];

  const getWallpaperStyle = () => {
    if (wallpaper === "dots") {
      return {
        backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)",
        backgroundSize: "16px 16px",
      };
    }
    if (wallpaper === "grid") {
      return {
        backgroundImage:
          "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
      };
    }
    if (wallpaper === "cosmic") {
      return {
        backgroundImage: "radial-gradient(circle at 50% 50%, var(--primary) 0%, transparent 70%)",
        opacity: 0.15,
      };
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
            <p className="text-xs text-muted-foreground mt-1">
              Enter your 4-digit PIN to access messages
            </p>
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
    <section
      className={`chat-canvas flex h-full min-w-0 flex-1 flex-col ${mobileQuickBar ? "pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0" : ""}`}
      style={getWallpaperStyle()}
    >
      <header className="relative flex flex-col border-b border-border bg-sidebar px-3 py-2.5 sm:px-4 sm:py-3">
        <div className="flex items-center gap-2 sm:gap-3">
          <button
            type="button"
            onClick={onOpenSidebar}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs transition-opacity hover:opacity-90 md:hidden"
            aria-label="Back to spaces"
          >
            <ChevronLeft className="size-4" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-bold text-foreground">{space.name}</h2>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <span className="whitespace-nowrap font-mono font-semibold text-primary">
                <span className="hidden min-[400px]:inline">Code: </span>
                {space.code}
              </span>
              <span
                title="Text messages are encrypted in your browser (AES-GCM) before upload; the database only stores ciphertext."
                className="whitespace-nowrap rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400"
              >
                🔒 E2E
              </span>
              {space.hasPassword && (
                <span
                  title="This room is password-protected."
                  className="whitespace-nowrap rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400"
                >
                  <span className="hidden min-[400px]:inline">🔑 Protected</span>
                  <span className="min-[400px]:hidden" aria-label="Protected">
                    🔑
                  </span>
                </span>
              )}
              <span className="hidden min-w-0 items-center gap-1 truncate md:flex">
                <span className="size-1.5 rounded-full bg-emerald-400" />
                <span className="truncate">
                  {otherMemberNames.length > 0 ? otherMemberNames.join(", ") : "Only you here"}
                </span>
              </span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1 md:hidden">
            <button
              type="button"
              onClick={() => shareSpace()}
              aria-label="Share space"
              title="Share space"
              className="mobile-icon-button !size-10"
            >
              <Share2 className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setCallMode("voice")}
              aria-label="Start voice call"
              title="Voice call"
              className="mobile-icon-button !size-10"
            >
              <Phone className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setCallMode("video")}
              aria-label="Start video call"
              title="Video call"
              className="mobile-icon-button !size-10"
            >
              <Video className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setShowMobileActions((value) => !value)}
              aria-label={showMobileActions ? "Hide space actions" : "Show space actions"}
              aria-expanded={showMobileActions}
              title="More space actions"
              className="mobile-icon-button !size-10"
            >
              <MoreHorizontal className="size-5" />
            </button>
          </div>
        </div>

        <div className="ml-11 mt-1 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground md:hidden">
          <span className="size-1.5 shrink-0 rounded-full bg-emerald-400" />
          <span className="truncate">
            {otherMemberNames.length > 0 ? otherMemberNames.join(", ") : "Only you here"}
          </span>
        </div>

        <div
          className={`${showMobileActions ? "grid grid-cols-5" : "hidden"} mt-3 gap-2 rounded-2xl border border-border bg-background/50 p-2 [&>button]:min-h-10 [&>button]:min-w-10 md:mt-0 md:flex md:flex-wrap md:gap-1 md:rounded-none md:border-0 md:bg-transparent md:p-0`}
        >
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
                <div className="px-2 py-1 text-[10px] uppercase font-bold text-muted-foreground">
                  Auto-destruct
                </div>
                {(["off", "24h", "7d", "30d"] as DisappearingTimer[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => changeDisappearingTimer(t)}
                    className={
                      "flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors " +
                      (disappearingTimer === t
                        ? "bg-primary text-primary-foreground font-semibold"
                        : "hover:bg-secondary text-muted-foreground")
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
            onClick={() => setShowStorageManager(true)}
            title="Space Storage Manager"
            className="rounded-xl bg-card p-2 text-muted-foreground hover:text-primary transition-colors shrink-0"
          >
            <HardDrive className="size-4 text-amber-400" />
          </button>

          <button
            type="button"
            onClick={() => setMutedSound((v) => !v)}
            title={mutedSound || !soundEffectsEnabled ? "Unmute sounds" : "Mute sounds"}
            aria-pressed={mutedSound || !soundEffectsEnabled}
            className="rounded-xl bg-card p-2 text-muted-foreground hover:text-primary transition-colors shrink-0"
          >
            {mutedSound || !soundEffectsEnabled ? (
              <VolumeX className="size-4 text-destructive" />
            ) : (
              <Volume2 className="size-4 text-primary" />
            )}
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
                      (wallpaper === w
                        ? "bg-primary text-primary-foreground font-semibold"
                        : "hover:bg-secondary text-muted-foreground")
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
            onClick={toggleSpaceNotifications}
            title={
              spaceNotificationsMuted ? "Unmute space notifications" : "Mute space notifications"
            }
            aria-label={
              spaceNotificationsMuted ? "Unmute space notifications" : "Mute space notifications"
            }
            aria-pressed={spaceNotificationsMuted}
            className={`rounded-xl bg-card p-2 transition-colors shrink-0 ${spaceNotificationsMuted ? "text-muted-foreground" : "text-primary hover:text-primary"}`}
          >
            {spaceNotificationsMuted ? <BellOff className="size-4" /> : <Bell className="size-4" />}
          </button>
          <button
            type="button"
            onClick={() => {
              setDeleteSpaceMode("me");
              setShowDeleteSpaceModal(true);
            }}
            title="Delete space"
            aria-label="Delete space"
            className="rounded-xl bg-card p-2 text-destructive transition-colors hover:bg-destructive/10 shrink-0"
          >
            <Trash2 className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => void shareSpace()}
            className="hidden shrink-0 items-center gap-1.5 rounded-xl bg-secondary px-2.5 py-2 text-xs font-semibold transition-colors hover:text-primary md:inline-flex"
          >
            <Share2 className="size-3.5" />
            <span className="hidden sm:inline">Share</span>
          </button>
          <IconBtn
            label="Start voice call"
            onClick={() => setCallMode("voice")}
            className="hidden shrink-0 md:inline-flex"
          >
            <Phone className="size-3.5" />
          </IconBtn>
          <IconBtn
            label="Start video call"
            onClick={() => setCallMode("video")}
            className="hidden shrink-0 md:inline-flex"
          >
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

      {!online && (
        <div
          role="status"
          className="flex items-center justify-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-[11px] font-semibold text-amber-300"
        >
          <WifiOff className="size-3.5" />
          <span>
            You&apos;re offline — showing saved chats. Text will queue and send on reconnect.
          </span>
        </div>
      )}

      {lockedCount > 0 && (
        <div className="flex flex-col gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs">
          <p className="text-amber-300">
            🔒 {lockedCount} message{lockedCount === 1 ? "" : "s"} couldn't be decrypted. Enter the
            room password to unlock.
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              value={roomPasswordInput}
              onChange={(e) => setRoomPasswordInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void (async () => {
                    const { unlockSpaceMessages } = await import("@/lib/heymama");
                    await unlockSpaceMessages(space.code, roomPasswordInput);
                    setRoomPasswordInput("");
                    toast.success("Room password applied — messages re-decrypted");
                  })();
                }
              }}
              placeholder="Room password"
              autoComplete="off"
              className="min-w-0 flex-1 rounded-lg bg-background px-2.5 py-1.5 outline-none ring-1 ring-input focus:ring-primary"
            />
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  const { unlockSpaceMessages } = await import("@/lib/heymama");
                  await unlockSpaceMessages(space.code, roomPasswordInput);
                  setRoomPasswordInput("");
                  toast.success("Room password applied — messages re-decrypted");
                })();
              }}
              className="rounded-lg bg-primary px-3 py-1.5 font-semibold text-primary-foreground"
            >
              Unlock
            </button>
          </div>
        </div>
      )}

      {space.ownerId === userId && (
        <div className="flex items-center gap-2 border-b border-border bg-background/60 px-4 py-1.5 text-[11px]">
          <button
            type="button"
            onClick={() => setShowRoomPasswordBox((v) => !v)}
            className="text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
          >
            {space.hasPassword ? "Change room password" : "Add room password (optional)"}
          </button>
          {showRoomPasswordBox && (
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <input
                type="password"
                value={roomPasswordSettingInput}
                onChange={(e) => setRoomPasswordSettingInput(e.target.value)}
                placeholder={space.hasPassword ? "New 4+ chars, or Remove below" : "4+ chars"}
                autoComplete="new-password"
                maxLength={64}
                className="min-w-0 flex-1 rounded-lg bg-card px-2 py-1 outline-none ring-1 ring-input focus:ring-primary"
              />
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    const input = roomPasswordSettingInput.trim();
                    if (input && input.length < 4) {
                      toast.error("Password too short", {
                        description: "Use 4+ characters.",
                      });
                      return;
                    }
                    const { setSpacePassword } = await import("@/lib/heymama");
                    const ok = await setSpacePassword(space.id, roomPasswordSettingInput);
                    if (ok) {
                      toast.success(
                        input
                          ? space.hasPassword
                            ? "Room password changed"
                            : "Room password added"
                          : "Room password removed — room is now open",
                      );
                      setRoomPasswordSettingInput("");
                      setShowRoomPasswordBox(false);
                    } else {
                      toast.error("Couldn't update password", {
                        description: "Only the Space owner can change it.",
                      });
                    }
                  })();
                }}
                className="rounded-lg bg-primary px-2 py-1 font-semibold text-primary-foreground"
              >
                Save
              </button>
              {space.hasPassword && (
                <button
                  type="button"
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Remove the room password? The Space becomes open to anyone with the code. Messages encrypted with the old password may stay locked.",
                      )
                    )
                      return;
                    void (async () => {
                      const { setSpacePassword } = await import("@/lib/heymama");
                      const ok = await setSpacePassword(space.id, "");
                      toast[ok ? "success" : "error"](
                        ok
                          ? "Room password removed — room is now open"
                          : "Couldn't remove password",
                      );
                      if (ok) {
                        setRoomPasswordSettingInput("");
                        setShowRoomPasswordBox(false);
                      }
                    })();
                  }}
                  title="Remove the room password"
                  className="rounded-lg bg-destructive/10 px-2 py-1 font-semibold text-destructive ring-1 ring-destructive/30 hover:bg-destructive/20"
                >
                  Remove
                </button>
              )}
            </span>
          )}
        </div>
      )}

      {isOwner && (
        <div className="border-b border-border bg-background/60 px-4 py-1.5 text-[11px]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button
              type="button"
              onClick={() => {
                setShowAccessBox((v) => !v);
                if (!showAccessBox) void loadBans();
              }}
              className="text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
            >
              {showAccessBox ? "Hide room access" : "Room access (lock / read-only / kick)"}
            </button>
            {space.isLocked && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-semibold text-amber-600">
                🔒 Locked
              </span>
            )}
            {space.isReadonly && (
              <span className="rounded-full bg-blue-500/15 px-2 py-0.5 font-semibold text-blue-600">
                📖 Read-only
              </span>
            )}
          </div>
          {showAccessBox && (
            <div className="mt-2 space-y-2 pb-1">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void (async () => {
                      const { setSpaceLock } = await import("@/lib/heymama");
                      const next = !space.isLocked;
                      const ok = await setSpaceLock(space.id, next);
                      toast[ok ? "success" : "error"](
                        ok
                          ? next
                            ? "Room locked — no new guests can join"
                            : "Room unlocked — guests can join with the code"
                          : "Couldn't change room lock",
                      );
                    })();
                  }}
                  className="rounded-lg bg-card px-2 py-1 font-semibold ring-1 ring-input hover:ring-primary"
                >
                  {space.isLocked ? "Unlock room" : "Lock room"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void (async () => {
                      const { setSpaceReadonly } = await import("@/lib/heymama");
                      const next = !space.isReadonly;
                      const ok = await setSpaceReadonly(space.id, next);
                      toast[ok ? "success" : "error"](
                        ok
                          ? next
                            ? "Read-only on — only you can post"
                            : "Read-only off — everyone can post"
                          : "Couldn't change read-only mode",
                      );
                    })();
                  }}
                  className="rounded-lg bg-card px-2 py-1 font-semibold ring-1 ring-input hover:ring-primary"
                >
                  {space.isReadonly ? "Allow everyone to post" : "Make read-only"}
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  value={kickInput}
                  onChange={(e) => setKickInput(e.target.value)}
                  placeholder="Kick user ID (e.g. MAMA-1234-EYAB)"
                  autoComplete="off"
                  maxLength={64}
                  className="min-w-0 flex-1 rounded-lg bg-card px-2 py-1 uppercase outline-none ring-1 ring-input focus:ring-primary"
                />
                <button
                  type="button"
                  onClick={() => {
                    const target = kickInput.trim();
                    if (!target) {
                      toast.error("Enter a user ID to kick");
                      return;
                    }
                    if (
                      !window.confirm(
                        `Remove ${target.toUpperCase()} from this Space? They lose access immediately.`,
                      )
                    )
                      return;
                    void (async () => {
                      const { kickSpaceUser } = await import("@/lib/heymama");
                      const ok = await kickSpaceUser(space.id, target);
                      toast[ok ? "success" : "error"](
                        ok ? `${target.toUpperCase()} removed` : "Couldn't remove that user",
                      );
                      if (ok) {
                        setKickInput("");
                        void loadBans();
                      }
                    })();
                  }}
                  className="rounded-lg bg-destructive/10 px-2 py-1 font-semibold text-destructive ring-1 ring-destructive/30 hover:bg-destructive/20"
                >
                  Kick
                </button>
              </div>
              <div>
                <button
                  type="button"
                  onClick={() => void loadBans()}
                  className="text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                >
                  {bansLoading ? "Refreshing…" : `Removed users (${bans.length})`}
                </button>
                {bans.length > 0 && (
                  <ul className="mt-1 space-y-1">
                    {bans.map((b) => (
                      <li
                        key={b.userId}
                        className="flex items-center justify-between gap-2 rounded-lg bg-card px-2 py-1 ring-1 ring-input"
                      >
                        <span className="truncate font-mono text-[10px]">{b.userId}</span>
                        <button
                          type="button"
                          onClick={() => {
                            void (async () => {
                              const { unbanSpaceUser } = await import("@/lib/heymama");
                              const ok = await unbanSpaceUser(space.id, b.userId);
                              toast[ok ? "success" : "error"](
                                ok ? `${b.userId} can rejoin` : "Couldn't unban",
                              );
                              if (ok) void loadBans();
                            })();
                          }}
                          className="shrink-0 font-semibold text-primary hover:underline"
                        >
                          Unban
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      )}

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
            {searchQuery
              ? "No messages matching your search."
              : "No messages yet — send text, images, video, voice notes or documents."}
          </p>
        )}
        {filteredMessages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            mine={m.authorId === userId}
            allMessages={messages}
            currentUserId={userId}
            onPollVote={handlePollVote}
            onForward={onForward}
            onOpenImage={setLightbox}
            onPin={(message) => {
              setPinnedMessage(message);
              toast.success("Message pinned to top");
            }}
            onStar={toggleStar}
            onReply={handleReplyQuote}
            onOpenThread={(message) => setActiveThreadMessage(message)}
            isStarred={starredIds.has(m.id)}
            onEdit={handleStartEdit}
            onDelete={(message) => {
              void handleDeleteForEveryone(message);
            }}
            onDeleteForMe={handleDeleteForMe}
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

      <footer className="border-t border-border bg-sidebar p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="mb-2 hidden items-center justify-between md:flex">
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
                <div className="absolute right-0 bottom-8 z-40 w-64 max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-card p-2 shadow-2xl animate-in zoom-in-95 duration-150 space-y-2">
                  <div className="px-2 py-0.5 text-[10px] uppercase font-bold text-muted-foreground">
                    GIFs & Animated Stickers
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 max-h-48 overflow-y-auto thin-scroll p-1">
                    {[
                      {
                        label: "Party 🎉",
                        url: "https://media.giphy.com/media/l2JIdnF6aJnAqzmy4/giphy.gif",
                      },
                      {
                        label: "Mindblown 🤯",
                        url: "https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif",
                      },
                      {
                        label: "High Five 🙌",
                        url: "https://media.giphy.com/media/3oEJHV0z8S7WM4MwnK/giphy.gif",
                      },
                      {
                        label: "Dance 💃",
                        url: "https://media.giphy.com/media/l3vRlT2k2L35CboWY/giphy.gif",
                      },
                      {
                        label: "Cat Vibe 🐱",
                        url: "https://media.giphy.com/media/GeimqsH0TLDt4tScGw/giphy.gif",
                      },
                      {
                        label: "Applause 👏",
                        url: "https://media.giphy.com/media/g9582DNuQppxC/giphy.gif",
                      },
                      {
                        label: "Cool 😎",
                        url: "https://media.giphy.com/media/l41YkxvU8c7J7Bba0/giphy.gif",
                      },
                      {
                        label: "Shocked 😱",
                        url: "https://media.giphy.com/media/LpLd2NGvOtAXVAkEFz/giphy.gif",
                      },
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
                        <img
                          src={gif.url}
                          alt={gif.label}
                          className="h-16 w-full object-cover rounded-lg group-hover:scale-105 transition-transform"
                        />
                        <span className="mt-0.5 block truncate text-[9px] font-semibold text-center">
                          {gif.label}
                        </span>
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
                <div className="absolute right-0 bottom-8 z-40 w-64 max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-card p-2 shadow-2xl animate-in zoom-in-95 duration-150 space-y-1">
                  <div className="px-2 py-1 text-[10px] uppercase font-bold text-muted-foreground">
                    Quick Templates
                  </div>
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
        {replyTo && !editing && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border-l-2 border-primary bg-secondary px-3 py-2">
            <Reply className="size-3.5 shrink-0 text-primary" />
            <div className="min-w-0 flex-1 text-xs">
              <p className="truncate font-semibold text-primary">
                Replying to @{replyTo.authorName || "User"}
              </p>
              <p className="truncate text-muted-foreground">{replySnippet(replyTo)}</p>
            </div>
            <button
              type="button"
              onClick={() => setReplyTo(null)}
              aria-label="Cancel reply"
              className="flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
        {showMobileEmojis && (
          <div className="mb-2 flex gap-2 overflow-x-auto md:hidden">
            {QUICK_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => setText((value) => value + emoji)}
                className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-card text-lg"
                aria-label={`Insert ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
        {showMobileAttachments && (
          <div className="mb-2 grid grid-cols-3 gap-2 md:hidden">
            {[
              {
                label: "⚡ P2P Direct Share",
                action: () => p2pFileInputRef.current?.click(),
                icon: <Zap className="size-4 text-emerald-400" />,
              },
              {
                label: "Photo or video",
                action: () => mediaInputRef.current?.click(),
                icon: <ImageIcon className="size-4" />,
              },
              {
                label: "Document",
                action: () => fileInputRef.current?.click(),
                icon: <Paperclip className="size-4" />,
              },
              {
                label: "Audio file",
                action: () => audioInputRef.current?.click(),
                icon: <AudioLines className="size-4" />,
              },
              {
                label: "Share location",
                action: handleShareLocation,
                icon: <MapPin className="size-4" />,
              },
              {
                label: "Soundboard",
                action: () => setShowSoundboard((value) => !value),
                icon: <Music className="size-4" />,
              },
              {
                label: "Create poll",
                action: () => setShowPollModal(true),
                icon: <BarChart2 className="size-4" />,
              },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  setShowMobileAttachments(false);
                  item.action();
                }}
                className="flex min-h-12 items-center gap-2 rounded-xl border border-border bg-card px-3 text-center text-[11px] font-medium leading-tight break-words"
              >
                {item.icon}
                <span className="min-w-0 flex-1">{item.label}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="hidden shrink-0 flex-wrap gap-1 md:flex">
            <IconBtn label="⚡ P2P Direct Share" onClick={() => p2pFileInputRef.current?.click()}>
              <Zap className="size-4 text-emerald-400" />
            </IconBtn>
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
            <IconBtn label="Soundboard FX" onClick={() => setShowSoundboard((v) => !v)}>
              <Music className="size-4 text-purple-400" />
            </IconBtn>
            <IconBtn label="Create Poll" onClick={() => setShowPollModal(true)}>
              <BarChart2 className="size-4" />
            </IconBtn>
          </div>
          <button
            type="button"
            onClick={() => setShowMobileEmojis((value) => !value)}
            aria-label="Show emoji picker"
            aria-expanded={showMobileEmojis}
            className="mobile-icon-button size-11 shrink-0 md:hidden"
          >
            <Smile className="size-5" />
          </button>
          <button
            type="button"
            onClick={() => setShowMobileAttachments((value) => !value)}
            aria-label="Show attachment options"
            aria-expanded={showMobileAttachments}
            className="mobile-icon-button size-11 shrink-0 md:hidden"
          >
            <Plus className="size-5" />
          </button>
          <textarea
            ref={composerRef}
            value={text}
            onChange={(e) => handleTyping(e.target.value)}
            onPaste={handleComposerPaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submitText();
              }
            }}
            rows={1}
            disabled={readOnlyForMe}
            placeholder={
              readOnlyForMe
                ? "Read-only — only the host can post"
                : editing
                  ? "Edit message..."
                  : replyTo
                    ? `Replying to ${replyTo.authorName || "User"}...`
                    : "Message..."
            }
            aria-label={editing ? "Edit message" : "Message"}
            className="thin-scroll min-w-0 max-h-32 min-h-11 flex-1 basis-24 resize-none overflow-hidden rounded-xl bg-card px-3 py-2.5 text-sm leading-relaxed outline-none ring-1 ring-input focus:ring-primary"
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
            disabled={readOnlyForMe}
            className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-transform hover:scale-105 disabled:opacity-40"
          >
            <Send className="size-4" />
          </button>
        </div>
        <input
          ref={mediaInputRef}
          type="file"
          accept={ACCEPT_IMAGE_VIDEO}
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
          accept={ACCEPT_AUDIO}
          hidden
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_DOCUMENT}
          multiple
          hidden
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={p2pFileInputRef}
          type="file"
          accept={`${ACCEPT_IMAGE_VIDEO},${ACCEPT_AUDIO},${ACCEPT_DOCUMENT}`}
          multiple
          hidden
          onChange={(e) => {
            void handleP2PFileShare(e.target.files);
            e.target.value = "";
          }}
        />
      </footer>

      {/* PIN Setup Modal */}
      {showPinSetup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="w-full max-w-xs max-h-[90dvh] overflow-y-auto thin-scroll rounded-3xl bg-card border border-border p-5 shadow-2xl flex flex-col items-center text-center space-y-4">
            <div className="flex size-12 items-center justify-center rounded-full bg-primary/15 text-primary">
              <KeyRound className="size-6" />
            </div>
            <div>
              <h3 className="font-bold text-sm">Space Lock PIN</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Protect this Space with a 4-digit code
              </p>
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
                <h3 className="font-bold text-sm">
                  Space Media Gallery ({filteredGallery.length})
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowGalleryModal(false)}
                className="rounded-full p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="flex gap-1 overflow-x-auto thin-scroll border-b border-border py-2 text-xs">
              {(["all", "image", "video", "audio", "file"] as MediaTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveMediaTab(tab)}
                  className={
                    "rounded-lg px-3 py-1.5 capitalize font-medium transition-colors shrink-0 " +
                    (activeMediaTab === tab
                      ? "bg-primary text-primary-foreground font-bold"
                      : "text-muted-foreground hover:bg-secondary")
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
                    <div
                      key={m.id}
                      className="relative group rounded-xl border border-border bg-background p-2 flex flex-col justify-between"
                    >
                      {m.kind === "image" && m.dataUrl && (
                        <img
                          src={m.dataUrl}
                          alt={m.fileName || "Shared photo"}
                          onClick={() => m.dataUrl && setLightbox(m.dataUrl)}
                          className="h-28 w-full object-cover rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
                        />
                      )}
                      {m.kind === "video" && (
                        <video
                          src={m.dataUrl}
                          controls
                          className="h-28 w-full object-cover rounded-lg bg-black"
                        />
                      )}
                      {m.kind === "audio" && (
                        <div className="p-3 flex flex-col items-center justify-center gap-2 bg-secondary/50 rounded-lg h-28 text-center">
                          <AudioLines className="size-8 text-primary" />
                          <span className="text-[10px] font-semibold truncate w-full">
                            {m.fileName || "Voice Note"}
                          </span>
                        </div>
                      )}
                      {m.kind === "file" && (
                        <div className="p-3 flex flex-col items-center justify-center gap-2 bg-secondary/50 rounded-lg h-28 text-center">
                          <FileText className="size-8 text-primary" />
                          <span className="text-[10px] font-semibold truncate w-full">
                            {m.fileName || "Document"}
                          </span>
                        </div>
                      )}
                      <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
                        <span className="truncate">{m.authorName}</span>
                        <button
                          type="button"
                          onClick={() => void handleSaveAttachment(m.dataUrl, m.fileName)}
                          className="flex items-center gap-1 text-primary hover:underline font-semibold"
                        >
                          <Download className="size-3" /> Save
                        </button>
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
                <h3 className="font-bold text-sm">
                  Starred Messages ({starredMessagesList.length})
                </h3>
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
                  No starred messages yet. Hover over any message and click the Star icon to
                  bookmark it!
                </p>
              ) : (
                starredMessagesList.map((m) => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    mine={m.authorId === userId}
                    allMessages={messages}
                    currentUserId={userId}
                    onPollVote={handlePollVote}
                    onForward={onForward}
                    onOpenImage={setLightbox}
                    onPin={(message) => {
                      setPinnedMessage(message);
                      setShowStarredModal(false);
                      toast.success("Message pinned to top");
                    }}
                    onStar={toggleStar}
                    onReply={(message) => {
                      // Close the overlay first so the reply chip + composer are visible.
                      setShowStarredModal(false);
                      handleReplyQuote(message);
                    }}
                    isStarred={true}
                    onEdit={(message) => {
                      setShowStarredModal(false);
                      handleStartEdit(message);
                    }}
                    onDelete={(message) => {
                      void handleDeleteForEveryone(message);
                    }}
                    onDeleteForMe={handleDeleteForMe}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {showDeleteSpaceModal && space && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-space-title"
            className="w-full max-w-sm space-y-4 rounded-2xl border border-border bg-card p-5 shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
                <Trash2 className="size-5" />
              </span>
              <div>
                <h3 id="delete-space-title" className="font-bold">
                  Delete “{space.name}”?
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose whether to remove it just from your list or for everyone.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3">
                <input
                  type="radio"
                  name="delete-space-mode"
                  value="me"
                  checked={deleteSpaceMode === "me"}
                  onChange={() => setDeleteSpaceMode("me")}
                  className="mt-0.5 accent-primary"
                />
                <span>
                  <span className="block text-sm font-semibold">Delete for me</span>
                  <span className="block text-xs text-muted-foreground">
                    Removes this space and its messages from your device. Others keep access.
                  </span>
                </span>
              </label>

              <label
                className={`flex items-start gap-3 rounded-xl border border-border p-3 ${space.ownerId === userId ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}
              >
                <input
                  type="radio"
                  name="delete-space-mode"
                  value="everyone"
                  checked={deleteSpaceMode === "everyone"}
                  onChange={() => setDeleteSpaceMode("everyone")}
                  disabled={space.ownerId !== userId}
                  className="mt-0.5 accent-destructive"
                />
                <span>
                  <span className="block text-sm font-semibold">Delete for everyone</span>
                  <span className="block text-xs text-muted-foreground">
                    Permanently deletes the space and all its messages for every member.
                  </span>
                </span>
              </label>
              {space.ownerId !== userId && (
                <p className="px-1 text-[11px] text-muted-foreground">
                  Only the owner can delete for everyone. This space may have been created before
                  ownership tracking was added.
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowDeleteSpaceModal(false)}
                disabled={deletingSpace}
                className="rounded-xl px-4 py-2.5 text-sm font-semibold text-muted-foreground hover:bg-secondary disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteSpace()}
                disabled={deletingSpace}
                className="rounded-xl bg-destructive px-4 py-2.5 text-sm font-semibold text-destructive-foreground hover:opacity-90 disabled:opacity-50"
              >
                {deletingSpace ? "Deleting…" : "Delete space"}
              </button>
            </div>
          </section>
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

            <div className="flex flex-col items-center rounded-2xl border border-border bg-white p-4 shadow-inner">
              <QRCodeSVG
                value={inviteUrl || space.code}
                size={224}
                level="M"
                includeMargin
                title={inviteUrl ? `Join ${space.name}` : `Space code ${space.code}`}
              />
              <p className="mt-2 text-xs font-mono font-bold text-slate-800 tracking-wider">
                SPACE CODE: {space.code}
              </p>
            </div>

            <div>
              <h4 className="font-bold text-sm text-foreground">{space.name}</h4>
              <p className="text-xs text-muted-foreground mt-0.5">
                {inviteUrl
                  ? "Scan to open the invite and join this Space."
                  : "Scan the code, then enter this Space number in the app to join."}
              </p>
            </div>

            <button
              type="button"
              onClick={() => void copyInviteLink()}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 text-xs font-bold text-primary-foreground transition-transform hover:scale-102"
            >
              {copiedInvite ? <Check className="size-4" /> : <Copy className="size-4" />}
              <span>
                {copiedInvite ? "Copied!" : inviteUrl ? "Copy Invite Link" : "Copy Space Code"}
              </span>
            </button>
          </div>
        </div>
      )}

      {showPollModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="w-full max-w-md max-h-[90dvh] overflow-y-auto thin-scroll rounded-2xl bg-card border border-border p-5 shadow-2xl space-y-4">
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
          <div className="absolute right-5 top-5 flex max-w-[calc(100vw-2.5rem)] flex-wrap items-center justify-end gap-2 overflow-x-auto">
            <div
              className="flex items-center gap-1 rounded-full bg-card px-2 py-1 shadow-xl border border-border"
              onClick={(e) => e.stopPropagation()}
            >
              <Sliders className="size-3.5 text-primary ml-1" />
              {(["none", "grayscale", "sepia", "vintage", "neon"] as PhotoFilter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setActivePhotoFilter(f)}
                  className={
                    "rounded-full px-2 py-0.5 text-[10px] font-medium capitalize transition-colors " +
                    (activePhotoFilter === f
                      ? "bg-primary text-primary-foreground font-bold"
                      : "text-muted-foreground hover:text-foreground")
                  }
                >
                  {f}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void handleSaveAttachment(lightbox, `space-connect-photo-${Date.now()}.jpg`);
              }}
              className="flex items-center gap-1.5 rounded-full bg-card px-4 py-2 text-xs font-semibold text-foreground shadow-xl hover:text-primary transition-colors"
            >
              <Download className="size-4" />
              <span>Download Photo</span>
            </button>
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
      {showSoundboard && (
        <div className="fixed bottom-24 left-4 z-40 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-card p-3 shadow-2xl animate-in zoom-in-95 duration-150">
          <div className="flex items-center justify-between border-b border-border pb-2 mb-2">
            <div className="flex items-center gap-1.5 font-bold text-xs">
              <Music className="size-4 text-purple-400" />
              <span>Synthesized Soundboard FX</span>
            </div>
            <button
              type="button"
              onClick={() => setShowSoundboard(false)}
              className="rounded-full p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: "Cheer 👏", fx: "cheer" },
              { label: "Airhorn 🎺", fx: "airhorn" },
              { label: "Party 🥳", fx: "party" },
              { label: "Chime ✨", fx: "chime" },
              { label: "Buzzer 🚨", fx: "buzzer" },
            ].map((item) => (
              <button
                key={item.fx}
                type="button"
                onClick={() => sendSoundFX(item.label, item.fx)}
                className="flex items-center justify-center rounded-xl border border-border bg-secondary/60 py-2.5 text-xs font-semibold hover:bg-primary hover:text-primary-foreground transition-all"
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {activeThreadMessage && (
        <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-background shadow-2xl animate-in slide-in-from-right duration-200">
          <div className="flex items-center justify-between border-b border-border p-4">
            <div className="flex items-center gap-2">
              <MessageSquare className="size-5 text-amber-400" />
              <h3 className="font-bold text-sm">Thread Replies</h3>
            </div>
            <button
              type="button"
              onClick={() => setActiveThreadMessage(null)}
              className="rounded-full p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4 thin-scroll">
            <div className="rounded-2xl bg-card border border-border p-3 space-y-1">
              <p className="text-[10px] font-bold text-primary">{activeThreadMessage.authorName}</p>
              <p className="text-xs">
                {activeThreadMessage.text || activeThreadMessage.fileName || "Parent message"}
              </p>
            </div>

            <div className="space-y-3 pt-2">
              {messages
                .filter((m) => m.threadParentId === activeThreadMessage.id)
                .map((m) => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    mine={m.authorId === userId}
                    allMessages={messages}
                    currentUserId={userId}
                    onPollVote={handlePollVote}
                    onForward={onForward}
                    onOpenImage={(url) => setLightbox(url)}
                    onPin={() => setPinnedMessage(m)}
                    onStar={(msg) => toggleStar(msg)}
                    onReply={(msg) => {
                      // Replying from inside a thread targets the main composer,
                      // so close the drawer first (it covers the composer).
                      setActiveThreadMessage(null);
                      handleReplyQuote(msg);
                    }}
                    isStarred={starredIds.has(m.id)}
                    onEdit={(msg) => {
                      setActiveThreadMessage(null);
                      handleStartEdit(msg);
                    }}
                    onDelete={(msg) => void handleDeleteForEveryone(msg)}
                    onDeleteForMe={handleDeleteForMe}
                  />
                ))}
            </div>
          </div>

          <div className="border-t border-border p-3 flex items-center gap-2">
            <input
              type="text"
              value={threadText}
              onChange={(e) => setThreadText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && threadText.trim()) {
                  void push("text", {
                    text: threadText.trim(),
                    threadParentId: activeThreadMessage.id,
                  });
                  setThreadText("");
                }
              }}
              placeholder="Reply in thread..."
              className="flex-1 rounded-xl bg-card px-3 py-2 text-xs outline-none ring-1 ring-input focus:ring-primary"
            />
            <button
              type="button"
              onClick={() => {
                if (threadText.trim()) {
                  void push("text", {
                    text: threadText.trim(),
                    threadParentId: activeThreadMessage.id,
                  });
                  setThreadText("");
                }
              }}
              className="rounded-xl bg-primary p-2 text-primary-foreground font-semibold text-xs"
            >
              <Send className="size-4" />
            </button>
          </div>
        </div>
      )}

      {showStorageManager && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="flex h-[80vh] w-full max-w-2xl flex-col rounded-3xl bg-card border border-border p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <HardDrive className="size-5 text-amber-400" />
                <h3 className="font-bold text-sm">Space Media & Storage Manager</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowStorageManager(false)}
                className="rounded-full p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-xl bg-secondary/70 p-3 text-center">
                <p className="text-[10px] uppercase font-bold text-muted-foreground">Total Files</p>
                <p className="text-lg font-bold font-mono text-primary mt-0.5">
                  {messages.filter((m) => m.dataUrl).length}
                </p>
              </div>
              <div className="rounded-xl bg-secondary/70 p-3 text-center">
                <p className="text-[10px] uppercase font-bold text-muted-foreground">
                  Total Storage
                </p>
                <p className="text-lg font-bold font-mono text-emerald-400 mt-0.5">
                  {formatBytes(messages.reduce((acc, m) => acc + (m.fileSize || 0), 0))}
                </p>
              </div>
              <div className="rounded-xl bg-secondary/70 p-3 text-center">
                <p className="text-[10px] uppercase font-bold text-muted-foreground">
                  Photos & Videos
                </p>
                <p className="text-lg font-bold font-mono text-sky-400 mt-0.5">
                  {messages.filter((m) => m.kind === "image" || m.kind === "video").length}
                </p>
              </div>
              <div className="rounded-xl bg-secondary/70 p-3 text-center">
                <p className="text-[10px] uppercase font-bold text-muted-foreground">
                  Audio & Docs
                </p>
                <p className="text-lg font-bold font-mono text-purple-400 mt-0.5">
                  {messages.filter((m) => m.kind === "audio" || m.kind === "file").length}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
              <div className="flex items-center gap-1">
                {(["all", "image", "video", "audio", "file"] as const).map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setStorageCategory(cat)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-semibold capitalize transition-colors ${
                      storageCategory === cat
                        ? "bg-primary text-primary-foreground shadow-xs"
                        : "bg-secondary text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={storageSearch}
                onChange={(e) => setStorageSearch(e.target.value)}
                placeholder="Search storage files..."
                className="rounded-xl bg-background px-3 py-1.5 text-xs outline-none ring-1 ring-input focus:ring-primary w-48"
              />
            </div>

            <div className="flex-1 overflow-y-auto thin-scroll space-y-2">
              {messages
                .filter((m) => m.dataUrl)
                .filter((m) => (storageCategory === "all" ? true : m.kind === storageCategory))
                .filter((m) =>
                  storageSearch.trim()
                    ? (m.fileName || m.text || "")
                        .toLowerCase()
                        .includes(storageSearch.toLowerCase())
                    : true,
                )
                .map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center justify-between rounded-xl bg-secondary/50 p-2.5 border border-border"
                  >
                    <div className="min-w-0 flex-1 pr-3">
                      <p className="truncate text-xs font-semibold text-foreground">
                        {m.fileName || `${m.kind} attachment`}
                      </p>
                      <p className="text-[10px] text-muted-foreground font-mono">
                        {m.fileSize ? formatBytes(m.fileSize) : "Unknown size"} •{" "}
                        {new Date(m.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    {m.dataUrl && (
                      <button
                        type="button"
                        onClick={() => void handleSaveAttachment(m.dataUrl, m.fileName)}
                        className="flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground shadow-xs"
                      >
                        <Download className="size-3" /> Save
                      </button>
                    )}
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      <Suspense fallback={null}>
        <InAppCall
          spaceCode={space.code}
          userId={userId}
          requestedMode={callMode}
          onClose={() => setCallMode(null)}
        />
      </Suspense>
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
  onClick: () => void | Promise<void>;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => void onClick()}
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
