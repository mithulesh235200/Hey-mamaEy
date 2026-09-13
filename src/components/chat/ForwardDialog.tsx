import { Hash, X } from "lucide-react";
import { toast } from "sonner";
import { forwardMessage, type Message, type Space } from "@/lib/heymama";

export function ForwardDialog({
  message,
  spaces,
  onClose,
}: {
  message: Message | null;
  spaces: Space[];
  onClose: () => void;
}) {
  if (!message) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Forward to Space</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            <X className="size-4 text-muted-foreground" />
          </button>
        </div>
        <div className="thin-scroll max-h-80 overflow-y-auto p-2">
          {spaces.length === 0 && (
            <p className="p-6 text-center text-xs text-muted-foreground">
              Join or create a Space first.
            </p>
          )}
          {spaces.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={async () => {
                const sent = await forwardMessage(message, s.id);
                if (sent) {
                  toast.success(`Forwarded to ${s.name}`);
                  onClose();
                } else {
                  toast.error("Couldn't forward this message — check your connection");
                }
              }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-secondary"
            >
              <span className="flex size-9 items-center justify-center rounded-full bg-primary/15 text-primary">
                <Hash className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{s.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{s.code}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
