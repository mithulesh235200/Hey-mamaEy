import { useState } from "react";
import {
  Check,
  CheckCheck,
  Copy,
  Download,
  FileText,
  Forward,
  MoreVertical,
  Pencil,
  Pin,
  Heart,
  Smile,
  Star,
  Trash2,
  Reply,
  Volume2,
} from "lucide-react";
import { toast } from "sonner";
import { formatBytes, type Message } from "@/lib/heymama";
import { AudioMessage } from "./AudioMessage";

const REACTION_EMOJIS = ["❤️", "👍", "😂", "🔥", "😮", "😢"];

export function MessageBubble({
  message,
  mine,
  onForward,
  onOpenImage,
  onPin,
  onStar,
  onReply,
  isStarred,
  onEdit,
  onDelete,
}: {
  message: Message;
  mine: boolean;
  onForward: (m: Message) => void;
  onOpenImage: (url: string) => void;
  onPin: (m: Message) => void;
  onStar: (m: Message) => void;
  onReply: (m: Message) => void;
  isStarred?: boolean;
  onEdit: (m: Message) => void;
  onDelete: (m: Message) => void;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const [reactions, setReactions] = useState<Record<string, number>>({});
  const [speaking, setSpeaking] = useState(false);

  const copyText = async () => {
    if (!message.text) return;
    try {
      await navigator.clipboard.writeText(message.text);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Could not copy");
    }
    setShowMenu(false);
  };

  const toggleReaction = (emoji: string) => {
    setReactions((prev) => {
      const current = prev[emoji] || 0;
      return { ...prev, [emoji]: current > 0 ? 0 : 1 };
    });
    setShowReactions(false);
  };

  const speakText = () => {
    if (!message.text) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      toast.error("Speech synthesis not supported in this browser");
      return;
    }
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message.text);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
    toast.info("Reading message aloud...");
  };

  const timeStr = new Date(message.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className={`group flex flex-col ${mine ? "items-end" : "items-start"}`}>
      {!mine && (
        <span className="mb-1 px-1 text-[11px] font-semibold text-muted-foreground">
          {message.authorName || "User"}
        </span>
      )}

      <div className="relative flex max-w-[85%] items-end gap-1 sm:max-w-[75%]">
        <div
          className={`relative rounded-2xl p-3 shadow-md transition-all ${
            mine
              ? "rounded-br-xs bg-primary text-primary-foreground font-medium"
              : "rounded-bl-xs border border-border bg-card text-card-foreground font-medium"
          }`}
        >
          {message.kind === "text" && message.text && (
            <div className="whitespace-pre-wrap break-words text-xs leading-relaxed sm:text-sm font-medium">
              {message.text}
            </div>
          )}

          {message.kind === "image" && message.dataUrl && (
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => onOpenImage(message.dataUrl!)}
                className="overflow-hidden rounded-xl focus:outline-none"
              >
                <img
                  src={message.dataUrl}
                  alt={message.fileName || "Shared image"}
                  className="max-h-64 w-full object-cover transition-transform hover:scale-102"
                />
              </button>
              <a
                href={message.dataUrl}
                download={message.fileName || `heymama-photo-${Date.now()}`}
                className={`flex items-center gap-1 text-[11px] font-semibold hover:underline ${
                  mine ? "text-primary-foreground underline-offset-2" : "text-primary"
                }`}
              >
                <Download className="size-3" /> Save Photo
              </a>
            </div>
          )}

          {message.kind === "video" && message.dataUrl && (
            <div className="space-y-1">
              <video
                src={message.dataUrl}
                controls
                className="max-h-64 w-full rounded-xl bg-black"
              />
              <a
                href={message.dataUrl}
                download={message.fileName || `heymama-video-${Date.now()}`}
                className={`flex items-center gap-1 text-[11px] font-semibold hover:underline ${
                  mine ? "text-primary-foreground underline-offset-2" : "text-primary"
                }`}
              >
                <Download className="size-3" /> Download Video
              </a>
            </div>
          )}

          {message.kind === "audio" && message.dataUrl && (
            <AudioMessage dataUrl={message.dataUrl} mine={mine} />
          )}

          {message.kind === "file" && (
            <div className="flex items-center gap-3">
              <div
                className={`flex size-10 items-center justify-center rounded-xl ${
                  mine ? "bg-primary-foreground/20 text-primary-foreground" : "bg-secondary text-primary"
                }`}
              >
                <FileText className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold">{message.fileName || "File"}</p>
                <p className="text-[10px] opacity-90 font-medium">
                  {message.fileSize ? formatBytes(message.fileSize) : "Attachment"}
                </p>
              </div>
              {message.dataUrl && (
                <a
                  href={message.dataUrl}
                  download={message.fileName || "download"}
                  className={`rounded-lg p-2 transition-colors ${
                    mine ? "hover:bg-primary-foreground/20 text-primary-foreground" : "hover:bg-secondary text-foreground"
                  }`}
                  aria-label="Download file"
                >
                  <Download className="size-4" />
                </a>
              )}
            </div>
          )}

          {Object.entries(reactions).some(([, count]) => count > 0) && (
            <div className="mt-1 flex flex-wrap gap-1 pt-1">
              {Object.entries(reactions).map(([emoji, count]) =>
                count > 0 ? (
                  <span
                    key={emoji}
                    onClick={() => toggleReaction(emoji)}
                    className="inline-flex cursor-pointer items-center gap-0.5 rounded-full bg-background/90 px-1.5 py-0.5 text-[10px] font-semibold shadow-xs border border-border"
                  >
                    <span>{emoji}</span>
                  </span>
                ) : null,
              )}
            </div>
          )}

          <div
            className={`mt-1.5 flex items-center justify-end gap-1 text-[10px] font-medium ${
              mine ? "text-primary-foreground/85" : "text-muted-foreground"
            }`}
          >
            <span>{timeStr}</span>
            {isStarred && <Star className="size-3 text-amber-400 fill-amber-400" />}
            {mine && (
              <span title="Delivered">
                <CheckCheck className="size-3 opacity-90" />
              </span>
            )}
          </div>
        </div>

        {/* Message Actions */}
        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 relative">
          {message.text && (
            <button
              type="button"
              onClick={speakText}
              title={speaking ? "Stop reading" : "Read aloud (Text-to-speech)"}
              className={
                "rounded-full bg-card p-1 text-muted-foreground hover:text-primary transition-colors " +
                (speaking ? "text-primary animate-pulse" : "")
              }
            >
              <Volume2 className="size-3.5" />
            </button>
          )}

          <button
            type="button"
            onClick={() => onReply(message)}
            title="Reply quote"
            className="rounded-full bg-card p-1 text-muted-foreground hover:text-primary transition-colors"
          >
            <Reply className="size-3.5" />
          </button>

          <button
            type="button"
            onClick={() => setShowReactions((v) => !v)}
            title="React"
            className="rounded-full bg-card p-1 text-muted-foreground hover:text-primary transition-colors"
          >
            <Smile className="size-3.5" />
          </button>

          <button
            type="button"
            onClick={() => setShowMenu((v) => !v)}
            className="rounded-full bg-card p-1 text-muted-foreground hover:text-foreground"
          >
            <MoreVertical className="size-3.5" />
          </button>

          {showReactions && (
            <div className="absolute bottom-8 right-0 z-40 flex items-center gap-1 rounded-full border border-border bg-card p-1 shadow-xl animate-in zoom-in-95 duration-150">
              {REACTION_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => toggleReaction(emoji)}
                  className="rounded-full p-1 text-base transition-transform hover:scale-125"
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}

          {showMenu && (
            <div className="absolute bottom-8 right-0 z-40 w-36 rounded-xl border border-border bg-card p-1 shadow-xl animate-in zoom-in-95 duration-150">
              {message.text && (
                <button
                  type="button"
                  onClick={() => void copyText()}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  <Copy className="size-3.5" /> Copy
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  onStar(message);
                  setShowMenu(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-amber-400"
              >
                <Star className="size-3.5" /> {isStarred ? "Unstar" : "Star"}
              </button>
              <button
                type="button"
                onClick={() => {
                  onPin(message);
                  setShowMenu(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <Pin className="size-3.5" /> Pin
              </button>
              <button
                type="button"
                onClick={() => {
                  onForward(message);
                  setShowMenu(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <Forward className="size-3.5" /> Forward
              </button>

              {mine && (
                <>
                  {message.kind === "text" && (
                    <button
                      type="button"
                      onClick={() => {
                        onEdit(message);
                        setShowMenu(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                    >
                      <Pencil className="size-3.5" /> Edit
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      onDelete(message);
                      setShowMenu(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="size-3.5" /> Delete
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
