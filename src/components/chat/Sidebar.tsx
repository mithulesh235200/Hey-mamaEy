import { useEffect, useState } from "react";
import {
  Copy,
  Hash,
  LogOut,
  Palette,
  Pin,
  Plus,
  RefreshCw,
  Smile,
  Users,
  Check,
  Settings,
  Sliders,
} from "lucide-react";
import { toast } from "sonner";
import {
  createSpace,
  joinSpace,
  leaveSpace,
  regenerateId,
  restoreFromPermanentKey,
  setDisplayName,
  setActiveSpace,
  signInWithId,
  togglePin,
  useChatState,
  getUnreadCount,
  markSpaceAsRead,
  type Message,
  type Space,
} from "@/lib/heymama";
import { isBackupToken, validatePermanentAccessKey } from "@/lib/accessKey";
import {
  ACCENTS,
  PREFERENCES_EVENT,
  THEMES,
  applyAccent,
  applyTheme,
  loadAccent,
  loadTheme,
  type Accent,
  type Theme,
} from "@/lib/theme";
import { People } from "./People";

const USER_STATUSES = ["🚀 Coding", "🎧 Music", "☕ Break", "💤 Away", "✨ Online"];

export function Sidebar({
  userId,
  displayName,
  spaces,
  activeSpaceId,
  messages,
  onNavigate,
  onOpenSettings,
}: {
  userId: string;
  displayName: string;
  spaces: Space[];
  activeSpaceId: string | null;
  messages: Message[];
  onNavigate?: () => void;
  onOpenSettings?: () => void;
}) {
  const chatState = useChatState();
  const [joinCode, setJoinCode] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newMode, setNewMode] = useState<"quick" | "private">("private");
  const [restoreId, setRestoreId] = useState("");
  const [restoreToken, setRestoreToken] = useState("");
  const [showRestore, setShowRestore] = useState(false);
  const [userStatus, setUserStatus] = useState<string>(() => {
    if (typeof window === "undefined") return "✨ Online";
    try {
      return localStorage.getItem("heymamaey.userStatus") || "✨ Online";
    } catch {
      return "✨ Online";
    }
  });
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [busy, setBusy] = useState(false);

  const [theme, setTheme] = useState<Theme>(() => loadTheme());

  const [accent, setAccent] = useState<Accent>(() => loadAccent());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    applyAccent(accent);
  }, [accent]);

  useEffect(() => {
    const syncAppearance = () => {
      setTheme(loadTheme());
      setAccent(loadAccent());
    };
    window.addEventListener(PREFERENCES_EVENT, syncAppearance);
    return () => window.removeEventListener(PREFERENCES_EVENT, syncAppearance);
  }, []);

  const selectStatus = (st: string) => {
    setUserStatus(st);
    localStorage.setItem("heymamaey.userStatus", st);
    setShowStatusMenu(false);
    toast.success(`Status updated to ${st}`);
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(userId);
      toast.success("ID copied", { description: userId });
    } catch {
      toast.error("Couldn't copy — select it manually");
    }
  };

  const handleCreate = async () => {
    if (busy) return;
    if (!displayName.trim() || displayName === "You") {
      toast.error("Add your name first", { description: "Your name is shown in the Space." });
      return;
    }
    if (newPassword.trim() && newPassword.trim().length < 4) {
      toast.error("Password too short", {
        description: "Room password must be 4+ characters, or empty for an open room.",
      });
      return;
    }
    setBusy(true);
    try {
      const space = await createSpace(newName || `Space of ${userId.slice(0, 9)}`, {
        ...(newPassword.trim() && { password: newPassword.trim() }),
        mode: newMode,
      });
      if (!space) return;
      setNewName("");
      setNewPassword("");
      toast.success(
        newMode === "quick"
          ? `Quick Space created — code ${space.code}`
          : `Private Space created — code ${space.code}`,
        {
          description:
            newMode === "quick"
              ? "8-digit code: fast to share, easier to guess. Add a password for extra safety."
              : "Text messages are end-to-end encrypted in your browser before upload.",
        },
      );
      onNavigate?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Supabase error";
      toast.error("Couldn't create the Space", {
        description:
          message.includes("PGRST202") || message.includes("schema cache")
            ? "Supabase migrations are not applied to this project yet."
            : message,
      });
      return;
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async () => {
    if (busy) return;
    if (!displayName.trim() || displayName === "You") {
      toast.error("Add your name first", { description: "Your name is shown in the Space." });
      return;
    }
    const cleanCode = joinCode.trim();
    if (!cleanCode) {
      toast.error("Enter a Space Code", { description: "Type a Space Code to join." });
      return;
    }
    setBusy(true);
    try {
      const space = await joinSpace(cleanCode, joinPassword.trim());
      if (!space || !space.id || !space.code) {
        toast.error("Invalid Space Code", {
          description:
            "No Space exists with that code. Check the code (legacy 6/8-digit or new XXXX-XXXX-XXXX token) and try again.",
        });
        return;
      }
      setJoinCode("");
      setJoinPassword("");
      markSpaceAsRead(space.id);
      toast.success(`Joined ${space.name}`);
      onNavigate?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("SPACE_PASSWORD_REQUIRED")) {
        toast.error("Password required", {
          description: "This room is password-protected — enter its password.",
        });
        return;
      }
      if (msg.includes("SPACE_PASSWORD_INVALID")) {
        toast.error("Wrong password", { description: "The room password is incorrect." });
        return;
      }
      if (msg.includes("SPACE_LOCKED")) {
        toast.error("Room is locked", {
          description: "The host locked this room — no new guests right now.",
        });
        return;
      }
      if (msg.includes("SPACE_USER_BANNED")) {
        toast.error("You were removed", {
          description: "The host removed this ID from the Space.",
        });
        return;
      }
      toast.error("Invalid Space Code", {
        description: "No Space exists with that code. Please check the code and try again.",
      });
    } finally {
      setBusy(false);
    }
  };

  const lastOf = (spaceId: string) => {
    const list = messages.filter((m) => m.spaceId === spaceId);
    const last = list[list.length - 1];
    if (!last) return "No messages yet";
    if (last.locked) return "🔒 Encrypted message";
    if (last.text?.startsWith("__enc1__.")) return "🔒 Encrypted message";
    if (last.kind === "text") return last.text ?? "";
    if (last.kind === "location") return "📍 Location shared";
    if (last.kind === "p2p_file") return "⚡ P2P file shared";
    return `${last.kind === "file" ? "Document" : last.kind} shared`;
  };

  // MY ROOMS: pinned rooms first, then the most recently opened ones. Both
  // lists live in localStorage keyed by space CODE, so they survive reloads,
  // tab closes and even a cleared spaces list (the code is a re-join handle).
  const pinnedSet = new Set(chatState.pinnedCodes);
  const pinnedSpaces = spaces.filter((s) => pinnedSet.has(s.code));
  const shownCodes = new Set(pinnedSpaces.map((s) => s.code));
  const recentSpaces: Space[] = [];
  for (const recent of chatState.recents) {
    if (recentSpaces.length >= 5) break;
    if (shownCodes.has(recent.code)) continue;
    const match = spaces.find((s) => s.code === recent.code);
    if (!match) continue;
    recentSpaces.push(match);
    shownCodes.add(match.code);
  }
  const otherSpaces = spaces.filter((s) => !shownCodes.has(s.code));

  const handleTogglePin = (s: Space) => {
    const pinned = togglePin(s.code);
    toast.success(pinned ? `Pinned “${s.name}” to My Rooms` : `Unpinned “${s.name}”`);
  };

  const renderSpaceRow = (s: Space) => {
    const unread = getUnreadCount(s.id, messages, userId, chatState.readTimestamps);
    const pinned = pinnedSet.has(s.code);

    return (
      <div
        key={s.id}
        className={
          "group mb-1 flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors " +
          (s.id === activeSpaceId
            ? "bg-primary/10 text-foreground glow-ring"
            : "text-muted-foreground hover:bg-card hover:text-foreground")
        }
      >
        <button
          type="button"
          onClick={() => {
            setActiveSpace(s.id);
            markSpaceAsRead(s.id);
            onNavigate?.();
          }}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <div
            className={
              "flex size-9 shrink-0 items-center justify-center rounded-xl text-xs font-bold transition-colors " +
              (s.id === activeSpaceId
                ? "bg-primary text-primary-foreground"
                : "bg-card text-muted-foreground group-hover:text-foreground")
            }
          >
            <Hash className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center justify-between gap-1">
              <p className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                {s.name}
              </p>
              <span className="shrink-0 font-mono text-[10px] text-primary">
                {`${s.hasPassword ? "🔒 " : ""}${s.isLocked ? "🚫 " : ""}${s.isReadonly ? "📖 " : ""}${s.code}`}
              </span>
            </div>
            <p className="truncate text-[11px] text-muted-foreground">{lastOf(s.id)}</p>
          </div>
          {unread > 0 && (
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary font-mono text-[10px] font-bold text-primary-foreground shadow-sm">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => handleTogglePin(s)}
          aria-label={pinned ? `Unpin ${s.name}` : `Pin ${s.name}`}
          title={pinned ? "Unpin from My Rooms" : "Pin to My Rooms"}
          className={
            "inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg p-1.5 transition-opacity focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 " +
            (pinned
              ? "text-primary opacity-100 hover:bg-primary/10"
              : "text-muted-foreground hover:bg-card hover:text-foreground")
          }
        >
          <Pin className={"size-3.5 " + (pinned ? "fill-current" : "")} />
        </button>
        <button
          type="button"
          onClick={async () => {
            if (!window.confirm(`Leave "${s.name}"?`)) return;
            const ok = await leaveSpace(s.id);
            toast[ok ? "success" : "error"](ok ? `Left ${s.name}` : "Couldn't leave Space");
          }}
          aria-label={`Leave ${s.name}`}
          className="opacity-100 focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 rounded-lg p-1.5 text-muted-foreground transition-opacity hover:bg-destructive/10 hover:text-destructive min-h-9 min-w-9 inline-flex items-center justify-center"
        >
          <LogOut className="size-3.5" />
        </button>
      </div>
    );
  };

  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-sidebar">
      <div className="border-b border-border p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img
              src="/heymama.jpeg"
              alt="Hey Mama"
              className="size-10 shrink-0 rounded-xl object-cover shadow-sm"
            />
            <div>
              <h1 className="text-lg font-bold tracking-tight leading-tight">
                Hey<span className="text-primary">Mama</span>Ey
              </h1>
              <p className="text-[10px] text-muted-foreground">Codes only. No phone, no email.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Open settings"
            title="Settings"
            className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-card text-muted-foreground transition-colors hover:bg-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Settings className="size-4" />
          </button>
        </div>

        {/* Theme & Accent Customizer */}
        <div className="mt-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              <Palette className="size-3" />
              <span>Theme & Accent</span>
            </div>
            <div className="flex items-center gap-1">
              {ACCENTS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setAccent(a.id)}
                  title={`Accent: ${a.label}`}
                  className={
                    "size-4 rounded-full transition-transform " +
                    (accent === a.id
                      ? "scale-125 ring-2 ring-primary ring-offset-1 ring-offset-background"
                      : "hover:scale-110 opacity-75")
                  }
                  style={{ backgroundColor: a.color }}
                />
              ))}
            </div>
          </div>

          <div className="grid grid-cols-5 gap-1 rounded-xl bg-card p-1 border border-border">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTheme(t.id)}
                className={
                  "flex min-h-10 items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-medium transition-all " +
                  (theme === t.id
                    ? "bg-primary text-primary-foreground font-semibold shadow-sm scale-102"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/50")
                }
                title={t.shortLabel}
              >
                <span>{t.emoji}</span>
                <span className="hidden sm:inline text-[10px]">{t.shortLabel}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 rounded-xl bg-card p-3 glow-ring">
          <div className="flex items-center justify-between">
            <label
              htmlFor="display-name"
              className="text-[10px] uppercase tracking-wider text-muted-foreground"
            >
              Your name
            </label>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowStatusMenu((v) => !v)}
                className="inline-flex items-center gap-1 rounded-full bg-secondary/80 px-2 py-0.5 text-[10px] font-semibold text-primary transition-colors hover:bg-secondary"
              >
                <Smile className="size-3" />
                <span>{userStatus}</span>
              </button>
              {showStatusMenu && (
                <div className="absolute right-0 top-6 z-30 w-32 rounded-xl border border-border bg-card p-1 shadow-2xl animate-in zoom-in-95 duration-150">
                  {USER_STATUSES.map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => selectStatus(st)}
                      className="flex w-full items-center rounded-lg px-2 py-1 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                    >
                      {st}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <input
            id="display-name"
            value={displayName === "You" ? "" : displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Name shown in Spaces"
            maxLength={40}
            className="mt-1 w-full rounded-lg bg-background px-2.5 py-2 text-sm outline-none ring-1 ring-input focus:ring-primary"
          />
          <p className="mt-2 text-[10px] uppercase tracking-wider text-muted-foreground">Your ID</p>
          <p
            className="mt-0.5 truncate font-mono text-sm font-semibold text-primary"
            title={userId}
          >
            {userId}
          </p>
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
            <div className="mt-2 space-y-1.5">
              <input
                value={restoreId}
                onChange={(e) => setRestoreId(e.target.value)}
                placeholder="Access key or ID (XXXXX-… / MAMA-…)"
                aria-label="Permanent access key or identity code"
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-lg bg-background px-2 py-1.5 font-mono text-xs outline-none ring-1 ring-input focus:ring-primary"
              />
              <div className="flex gap-2">
                <input
                  value={restoreToken}
                  onChange={(e) => setRestoreToken(e.target.value)}
                  placeholder="Backup token (optional)"
                  aria-label="Backup token"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-lg bg-background px-2 py-1.5 font-mono text-xs outline-none ring-1 ring-input focus:ring-primary"
                />
                <button
                  type="button"
                  onClick={() => {
                    const value = restoreId.trim();
                    const tokenValue = restoreToken.trim();
                    if (!value && !tokenValue) return;
                    void (async () => {
                      // Backup tokens & valid access keys restore identity + spaces;
                      // legacy MAMA- IDs just switch the local identity. Encrypted
                      // (HEYMAMA_KEY2_) tokens need the access key in the first field.
                      const tokenPasted = isBackupToken(value) || isBackupToken(tokenValue);
                      const keyPasted = validatePermanentAccessKey(value).valid;
                      if (tokenPasted || keyPasted) {
                        const result = await restoreFromPermanentKey(value, tokenValue);
                        toast[result.success ? "success" : "error"](
                          result.success ? "Identity restored" : "Restore failed",
                          { description: result.message },
                        );
                        if (!result.success) return;
                      } else {
                        signInWithId(value);
                        toast.success("Identity restored");
                      }
                      setRestoreId("");
                      setRestoreToken("");
                      setShowRestore(false);
                    })();
                  }}
                  className="rounded-lg bg-accent px-2.5 text-xs font-semibold text-accent-foreground"
                >
                  Use
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-3 border-b border-border p-4">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Create a Space
          </label>
          <div className="mt-1.5 grid grid-cols-2 gap-1 rounded-lg bg-background p-1 ring-1 ring-input">
            <button
              type="button"
              onClick={() => setNewMode("quick")}
              title="8-digit numeric code — fast to dictate and type, easier to guess"
              className={
                "rounded-md px-2 py-1.5 text-[11px] font-semibold transition-colors " +
                (newMode === "quick"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              ⚡ Quick <span className="font-normal opacity-75">8-digit</span>
            </button>
            <button
              type="button"
              onClick={() => setNewMode("private")}
              title="12-char token + E2E encryption — best for private chats"
              className={
                "rounded-md px-2 py-1.5 text-[11px] font-semibold transition-colors " +
                (newMode === "private"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              🔒 Private <span className="font-normal opacity-75">secure</span>
            </button>
          </div>
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
          <input
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder="Room password (optional, 4+ chars)"
            type="password"
            autoComplete="new-password"
            maxLength={64}
            className="mt-1.5 w-full rounded-lg bg-background px-2.5 py-2 text-xs outline-none ring-1 ring-input focus:ring-primary"
          />
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
              placeholder="8-digit or XXXX-XXXX-XXXX"
              autoComplete="off"
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
          <input
            value={joinPassword}
            onChange={(e) => setJoinPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleJoin()}
            placeholder="Room password (if protected)"
            type="password"
            autoComplete="off"
            maxLength={64}
            className="mt-1.5 w-full rounded-lg bg-background px-2.5 py-2 text-xs outline-none ring-1 ring-input focus:ring-accent"
          />
        </div>
      </div>

      <People userId={userId} variant="desktop" onDone={onNavigate} />

      <div className="thin-scroll flex-1 overflow-y-auto p-2">
        {spaces.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No Spaces yet. Create one or join with a Space Number.
          </p>
        )}
        {(pinnedSpaces.length > 0 || recentSpaces.length > 0) && (
          <div className="mb-2">
            <p className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              My Rooms
            </p>
            {[...pinnedSpaces, ...recentSpaces].map(renderSpaceRow)}
          </div>
        )}
        {otherSpaces.map(renderSpaceRow)}
      </div>
    </aside>
  );
}
