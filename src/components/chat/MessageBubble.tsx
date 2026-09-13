import { Download, FileArchive, FileText, File as FileIcon, Forward } from "lucide-react";
import type { Message } from "@/lib/heymama";
import { formatBytes, formatTime } from "@/lib/heymama";
import { AudioMessage } from "./AudioMessage";

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
}: {
  message: Message;
  mine: boolean;
  onForward: (m: Message) => void;
  onOpenImage: (src: string) => void;
}) {
  const system = message.authorId === "SYSTEM";

  if (system) {
    return (
      <div className="my-2 flex justify-center">
        <div className="max-w-[80%] rounded-full bg-card px-4 py-1.5 text-center text-xs text-muted-foreground">
          {message.text ? renderMarkdown(message.text) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={"group flex items-end gap-2 " + (mine ? "flex-row-reverse" : "")}>
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
          <button
            type="button"
            onClick={() => onOpenImage(message.dataUrl!)}
            className="block overflow-hidden rounded-xl"
          >
            <img
              src={message.dataUrl}
              alt={message.fileName ?? "Shared image"}
              className="max-h-72 w-full max-w-xs object-cover transition-transform hover:scale-[1.02]"
            />
          </button>
        )}

        {message.kind === "video" && message.dataUrl && (
          <video
            src={message.dataUrl}
            controls
            className="max-h-72 w-full max-w-xs rounded-xl bg-black"
          />
        )}

        {message.kind === "audio" && message.dataUrl && (
          <AudioMessage src={message.dataUrl} id={message.id} label={message.fileName} />
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
            <a
              href={message.dataUrl}
              download={message.fileName}
              aria-label={`Download ${message.fileName}`}
              className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-transform hover:scale-105"
            >
              <Download className="size-4" />
            </a>
          </div>
        )}

        {message.kind !== "text" && message.text ? (
          <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed">
            {renderMarkdown(message.text)}
          </p>
        ) : null}

        <div className="mt-1 text-right text-[10px] text-muted-foreground">
          {formatTime(message.createdAt)}
        </div>
      </div>

      <button
        type="button"
        onClick={() => onForward(message)}
        aria-label="Forward message"
        title="Forward"
        className="mb-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-card text-muted-foreground opacity-0 transition-all hover:text-primary focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Forward className="size-4" />
      </button>
    </div>
  );
}
