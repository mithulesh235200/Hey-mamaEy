import {
  Clipboard,
  Download,
  Edit3,
  FileArchive,
  FileText,
  File as FileIcon,
  Forward,
  Pin,
  Reply,
  Smile,
  Star,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { Message } from "@/lib/heymama";
import { formatBytes, formatTime } from "@/lib/heymama";
import { AudioMessage } from "./AudioMessage";

const REACTION_EMOJIS = ["❤️", "👍", "😂", "🔥", "😮", "😢"];

function renderMarkdown(text: string) {
  const tokens = text.split(/(\*\*[^*]+\*\*|_[^_]+_|`[^`]+`)/g);
  return tokens.map((t, i) => {
    if (t.startsWith("**") && t.endsWith("**")) return <strong key={i}>{t.slice(2, -2)}</strong>;
    if (t.startsWith("_") && t.endsWith("_") && t.length > 2)
      return <em key={i}>{t.slice(1, -1)}</em>;
    if (t.startsWith("`") && t.endsWith("`") && t.length > 2)
      return (
        <code key={i} className="rounded bg-background/50 px-1 py-0.5 font-mono text-[0.85em]">
          {t.slice(1, -1)}
        </code>
      );
    return <span key={i}>{t}</span>;
  });
}

function fileIcon(name = "", mime = "") {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return <FileArchive className="size-5" />;
  if (["pdf", "doc", "docx", "txt", "md", "rtf"].includes(ext) || mime.includes("text"))
    return <FileText className="size-5" />;
  return <FileIcon className="size-5" />;
}

export function MessageBubble({
  message,
  mine,
  onForward,
  onOpenImage,
  onEdit,
  onDelete,
  onPin,
  onStar,
  onReply,
  isStarred,
}: {
  message: Message;
  mine: boolean;
  onForward: (m: Message) => void;
  onOpenImage: (src: string) => void;
  onEdit: (m: Message) => void;
  onDelete: (m: Message) => void;
  onPin?: (m: Message) => void;
  onStar?: (m: Message) => void;
  onReply?: (m: Message) => void;
  isStarred?: boolean;
}) {
  const system = message.authorId === "SYSTEM";
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [reactions, setReactions] = useState<Record<string, number>>({});

  const copyMessage = async () => {
    const value = message.text ?? message.fileName ?? message.dataUrl;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Couldn’t copy this message");
    }
  };

  const toggleReaction = (emoji: string) => {
    setReactions((prev) => {
      const current = prev[emoji] ?? 0;
      const next = { ...prev };
      if (current > 0) {
        delete next[emoji];
      } else {
        next[emoji] = 1;
      }
      return next;
    });
    setShowEmojiPicker(false);
  };

  const downloadMedia = () => {
    if (!message.dataUrl) return;
    try {
      const a = document.createElement("a");
      a.href = message.dataUrl;
      const ext =
        message.fileName?.split(".").pop() ||
        (message.kind === "image"
          ? "jpg"
          : message.kind === "video"
            ? "mp4"
            : message.kind === "audio"
              ? "mp3"
              : "bin");
      const name = message.fileName || `space-connect-${message.kind}-${Date.now()}.${ext}`;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toast.success(`Downloading ${name}`);
    } catch {
      toast.error("Couldn't download this media file");
    }
  };

  if (system) {
    return (
      <div className="my-2 flex justify-center">
        <div className="max-w-[80%] rounded-full bg-card px-4 py-1.5 text-center text-xs text-muted-foreground">
          {message.text ? renderMarkdown(message.text) : null}
        </div>
      </div>
    );
  }

  const hasReactions = Object.keys(reactions).length > 0;

  return (
    <div className={"group relative flex items-end gap-2 " + (mine ? "flex-row-reverse" : "")}>
      <div
        className={
          "relative max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-lg sm:max-w-[70%] " +
          (mine
            ? "rounded-br-sm bg-bubble-out text-foreground"
            : "rounded-bl-sm bg-bubble-in text-foreground")
        }
      >
        {!mine && (
          <div className="mb-1 text-[11px] font-semibold text-primary">{message.authorName}</div>
        )}
        {message.forwarded && (
          <div className="mb-1 flex items-center gap-1 text-[10px] italic text-muted-foreground">
            <Forward className="size-3" /> Forwarded
          </div>
        )}

        {message.kind === "text" && (
          <p className="whitespace-pre-wrap break-words leading-relaxed">
            {renderMarkdown(message.text ?? "")}
          </p>
        )}

        {message.kind === "image" && message.dataUrl && (
          <div className="relative group/img overflow-hidden rounded-xl">
            <button
              type="button"
              onClick={() => onOpenImage(message.dataUrl!)}
              className="block w-full text-left"
            >
              <img
                src={message.dataUrl}
                alt={message.fileName ?? "Shared image"}
                className="max-h-72 w-full max-w-xs object-cover transition-transform hover:scale-[1.02]"
              />
            </button>
            <button
              type="button"
              onClick={downloadMedia}
              aria-label="Download image"
              title="Download image"
              className="absolute right-2 top-2 flex size-8 items-center justify-center rounded-full bg-background/80 text-foreground backdrop-blur-sm transition-opacity hover:bg-background hover:text-primary shadow-md sm:opacity-0 sm:group-hover/img:opacity-100"
            >
              <Download className="size-4" />
            </button>
          </div>
        )}

        {message.kind === "video" && message.dataUrl && (
          <div className="relative group/vid max-w-xs">
            <video
              src={message.dataUrl}
              controls
              className="max-h-72 w-full rounded-xl bg-black"
            />
            <button
              type="button"
              onClick={downloadMedia}
              aria-label="Download video"
              title="Download video"
              className="absolute right-2 top-2 flex size-8 items-center justify-center rounded-full bg-background/80 text-foreground backdrop-blur-sm transition-opacity hover:bg-background hover:text-primary shadow-md sm:opacity-0 sm:group-hover/vid:opacity-100"
            >
              <Download className="size-4" />
            </button>
          </div>
        )}

        {message.kind === "audio" && message.dataUrl && (
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <AudioMessage src={message.dataUrl} id={message.id} label={message.fileName} />
            </div>
            <button
              type="button"
              onClick={downloadMedia}
              aria-label="Download audio"
              title="Download audio"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-background/50 text-foreground hover:text-primary transition-colors"
            >
              <Download className="size-4" />
            </button>
          </div>
        )}

        {message.kind === "file" && message.dataUrl && (
          <div className="flex w-64 items-center gap-3 rounded-xl bg-background/40 p-2.5 sm:w-72">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
              {fileIcon(message.fileName, message.mimeType)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{message.fileName}</p>
              <p className="text-[10px] text-muted-foreground">{formatBytes(message.fileSize)}</p>
            </div>
            <button
              type="button"
              onClick={downloadMedia}
              aria-label={`Download ${message.fileName}`}
              className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-transform hover:scale-105"
            >
              <Download className="size-4" />
            </button>
          </div>
        )}

        {message.kind !== "text" && message.text ? (
          <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed">
            {renderMarkdown(message.text)}
          </p>
        ) : null}

        <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
          {hasReactions ? (
            <div className="flex flex-wrap gap-1">
              {Object.entries(reactions).map(([emoji, count]) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => toggleReaction(emoji)}
                  className="inline-flex items-center gap-0.5 rounded-full bg-background/60 px-1.5 py-0.5 text-[11px] ring-1 ring-border"
                >
                  <span>{emoji}</span>
                  {count > 1 && <span className="font-mono text-[9px]">{count}</span>}
                </button>
              ))}
            </div>
          ) : (
            <div />
          )}
          <div className="flex items-center gap-1">
            {isStarred && <Star className="size-3 text-amber-400 fill-amber-400" />}
            <span>{formatTime(message.createdAt)}</span>
          </div>
        </div>
      </div>

      {showEmojiPicker && (
        <div
          className={
            "absolute bottom-10 z-30 flex items-center gap-1 rounded-full border border-border bg-card p-1.5 shadow-2xl animate-in zoom-in-95 duration-150 " +
            (mine ? "right-0" : "left-0")
          }
        >
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => toggleReaction(emoji)}
              className="flex size-7 items-center justify-center rounded-full text-base transition-transform hover:scale-125 hover:bg-secondary"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      <div className="mb-1 flex shrink-0 items-center gap-1 rounded-full bg-card p-1 text-muted-foreground opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
        <ActionButton
          label="React with emoji"
          onClick={() => setShowEmojiPicker((v) => !v)}
        >
          <Smile className="size-3.5" />
        </ActionButton>
        {onReply && (
          <ActionButton label="Reply to message" onClick={() => onReply(message)}>
            <Reply className="size-3.5" />
          </ActionButton>
        )}
        {onStar && (
          <ActionButton
            label={isStarred ? "Unstar message" : "Star message"}
            onClick={() => onStar(message)}
          >
            <Star className={"size-3.5 " + (isStarred ? "text-amber-400 fill-amber-400" : "")} />
          </ActionButton>
        )}
        {onPin && (
          <ActionButton label="Pin message" onClick={() => onPin(message)}>
            <Pin className="size-3.5" />
          </ActionButton>
        )}
        {message.dataUrl && (
          <ActionButton label="Download file" onClick={downloadMedia}>
            <Download className="size-3.5" />
          </ActionButton>
        )}
        <ActionButton label="Copy message" onClick={() => void copyMessage()}>
          <Clipboard className="size-3.5" />
        </ActionButton>
        {mine && message.kind === "text" && (
          <ActionButton label="Edit message" onClick={() => onEdit(message)}>
            <Edit3 className="size-3.5" />
          </ActionButton>
        )}
        {mine && (
          <ActionButton label="Delete message" onClick={() => onDelete(message)}>
            <Trash2 className="size-3.5" />
          </ActionButton>
        )}
        <ActionButton label="Forward message" onClick={() => onForward(message)}>
          <Forward className="size-3.5" />
        </ActionButton>
      </div>
    </div>
  );
}

function ActionButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-8 items-center justify-center rounded-full transition-colors hover:bg-secondary hover:text-primary focus-visible:bg-secondary focus-visible:text-primary"
    >
      {children}
    </button>
  );
}
