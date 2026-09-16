import { useState } from "react";
import { Copy, Hash, LogOut, Plus, RefreshCw, Users } from "lucide-react";
import { Copy, Hash, LogOut, Plus, RefreshCw, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import {
  createSpace,
    deleteSpace,
  joinSpace,
  leaveSpace,
  regenerateId,
  setActiveSpace,
  signInWithId,
  type Message,
  type Space,
} from "@/lib/heymama";

export function Sidebar({
  userId,
  spaces,
  activeSpaceId,
  messages,
  onNavigate,
}: {
  userId: string;
  spaces: Space[];
  activeSpaceId: string | null;
  messages: Message[];
  onNavigate?: () => void;
}) {
  const [joinCode, setJoinCode] = useState("");
  const [newName, setNewName] = useState("");
  const [restoreId, setRestoreId] = useState("");
  const [showRestore, setShowRestore] = useState(false);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(userId);
      toast.success("ID copied", { description: userId });
    } catch {
      toast.error("Couldn't copy — select it manually");
    }
  };

  const handleCreate = async () => {
    try {
      const space = await createSpace(newName || `Space of ${userId.slice(0, 9)}`);
      setNewName("");
      toast.success(`Space created — code ${space.code}`);
      onNavigate?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Supabase error";
      toast.error("Couldn't create the Space", {
        description: message.includes("PGRST202") || message.includes("schema cache")
          ? "Supabase migrations are not applied to this project yet."
          : message,
      });
      return;
    }
  };

  const handleJoin = async () => {

      const handleDeleteSpace = async (space: Space) => {
        if (!window.confirm(`Delete "${space.name}" and all its messages permanently?`)) return;
        const deleted = await deleteSpace(space.id);
        toast[deleted ? "success" : "error"](
          deleted ? "Space and messages deleted" : "Space could not be deleted",
        );
      };
    const space = await joinSpace(joinCode);
    if (!space) {
      toast.error("No Space found with that number", {
        description: "Ask your friend to share their exact 8-digit Space Code.",
      });
      return;
    }
    setJoinCode("");
    toast.success(`Joined ${space.name}`);
    onNavigate?.();
  };

  const lastOf = (spaceId: string) => {
    const list = messages.filter((m) => m.spaceId === spaceId);
    const last = list[list.length - 1];
    if (!last) return "No messages yet";
    if (last.kind === "text") return last.text ?? "";
    return `${last.kind === "file" ? "Document" : last.kind} shared`;
  };

  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-sidebar">
      <div className="border-b border-border p-4">
        <div className="flex items-center gap-2.5">
          <img
            src="/heymama.jpeg"
            alt="Hey Mama"
            className="size-10 shrink-0 rounded-xl object-cover shadow-sm"
          />
          <h1 className="text-lg font-bold tracking-tight">
            Hey<span className="text-primary">Mama</span>Ey
          </h1>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">Codes only. No phone, no email.</p>

        <div className="mt-3 rounded-xl bg-card p-3 glow-ring">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Your ID</p>
          <p className="mt-1 font-mono text-sm font-semibold text-primary">{userId}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={copyId}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-2 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              <Copy className="size-3.5" /> Copy My ID
            </button>
            <button
              type="button"
              onClick={() => {
                regenerateId();
                toast.success("New identity generated");
              }}
              aria-label="Generate a new ID"
              className="flex size-8 items-center justify-center rounded-lg bg-secondary text-muted-foreground transition-colors hover:text-foreground"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => setShowRestore((v) => !v)}
            className="mt-2 text-[11px] text-muted-foreground underline-offset-2 hover:text-accent hover:underline"
          >
            Restore an existing ID
          </button>
          {showRestore && (
            <div className="mt-2 flex gap-2">
              <input
                value={restoreId}
                onChange={(e) => setRestoreId(e.target.value)}
                placeholder="MAMA-0000-EYXX"
                className="min-w-0 flex-1 rounded-lg bg-background px-2 py-1.5 font-mono text-xs outline-none ring-1 ring-input focus:ring-primary"
              />
              <button
                type="button"
                onClick={() => {
                  if (!restoreId.trim()) return;
                  signInWithId(restoreId);
                  setRestoreId("");
                  setShowRestore(false);
                  toast.success("Identity restored");
                }}
                className="rounded-lg bg-accent px-2.5 text-xs font-semibold text-accent-foreground"
              >
                Use
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-3 border-b border-border p-4">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Create a Space
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Space name (optional)"
              className="min-w-0 flex-1 rounded-lg bg-background px-2.5 py-2 text-xs outline-none ring-1 ring-input focus:ring-primary"
            />
            <button
              type="button"
              onClick={handleCreate}
              className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              <Plus className="size-3.5" /> New
            </button>
          </div>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Join Existing Space
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleJoin()}
              placeholder="5509-1234"
              inputMode="numeric"
              className="min-w-0 flex-1 rounded-lg bg-background px-2.5 py-2 font-mono text-xs tracking-widest outline-none ring-1 ring-input focus:ring-accent"
            />
            <button
              type="button"
              onClick={handleJoin}
              className="inline-flex items-center gap-1 rounded-lg bg-accent px-3 text-xs font-semibold text-accent-foreground transition-opacity hover:opacity-90"
            >
              <Users className="size-3.5" /> Join
            </button>
          </div>
        </div>
      </div>

      <div className="thin-scroll flex-1 overflow-y-auto p-2">
        {spaces.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No Spaces yet. Create one or join with a Space Number.
          </p>
        )}
        {spaces.map((s) => (
          <div
            key={s.id}
            className={
              "group mb-1 flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors " +
              (activeSpaceId === s.id ? "bg-secondary" : "hover:bg-secondary/60")
            }
          >
            <button
              type="button"
              onClick={() => {
                setActiveSpace(s.id);
                onNavigate?.();
              }}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                <Hash className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">{s.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-primary">{s.code}</span>
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {lastOf(s.id)}
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => leaveSpace(s.id)}
              aria-label={`Leave ${s.name}`}
              className="opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
            >
              <LogOut className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void handleDeleteSpace(s)}
              aria-label={`Delete ${s.name} and its messages`}
              title="Delete Space and all messages"
              className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
