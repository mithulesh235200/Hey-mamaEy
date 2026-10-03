import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  Hash,
  MessageCircle,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  createSpace,
  getUnreadCount,
  joinSpace,
  markSpaceAsRead,
  setActiveSpace,
  setDisplayName,
  type Message,
  type Space,
} from "@/lib/heymama";

type MobileHomeProps = {
  userId: string;
  displayName: string;
  spaces: Space[];
  messages: Message[];
  activeSpaceId: string | null;
  readTimestamps: Record<string, number>;
  showBottomNav: boolean;
  onOpenSettings: () => void;
  onClose?: () => void;
};

type MobileTab = "spaces" | "profile";

export function MobileHome({
  userId,
  displayName,
  spaces,
  messages,
  activeSpaceId,
  readTimestamps,
  showBottomNav,
  onOpenSettings,
  onClose,
}: MobileHomeProps) {
  const [tab, setTab] = useState<MobileTab>("spaces");
  const [editingName, setEditingName] = useState(displayName === "You" ? "" : displayName);
  const [spaceName, setSpaceName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | null>(null);

  const filteredSpaces = useMemo(() => {
    const value = query.trim().toLocaleLowerCase();
    if (!value) return spaces;
    return spaces.filter((space) =>
      `${space.name} ${space.code}`.toLocaleLowerCase().includes(value),
    );
  }, [query, spaces]);

  const saveName = () => {
    const value = editingName.trim();
    if (!value) {
      toast.error("Enter a name to continue");
      return false;
    }
    setDisplayName(value);
    toast.success("Name saved");
    return true;
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(userId);
      toast.success("Your ID was copied");
    } catch {
      toast.error("Couldn’t copy the ID");
    }
  };

  const handleCreate = async () => {
    if ((!displayName || displayName === "You") && !saveName()) return;
    setBusy("create");
    try {
      await createSpace(spaceName.trim() || `Space of ${userId.slice(0, 9)}`);
      setSpaceName("");
      toast.success("Space created");
      onClose?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Please try again.";
      toast.error("Couldn’t create the Space", { description: message });
    } finally {
      setBusy(null);
    }
  };

  const handleJoin = async () => {
    if ((!displayName || displayName === "You") && !saveName()) return;
    const cleanCode = joinCode.trim();
    const digits = cleanCode.replace(/\D/g, "");
    if (!cleanCode || (digits.length !== 6 && digits.length !== 8)) {
      toast.error("Invalid Space Code", {
        description: "Space code must be a valid 6 or 8 digit number.",
      });
      return;
    }
    setBusy("join");
    try {
      const space = await joinSpace(cleanCode);
      if (!space) {
        toast.error("Invalid Space Code", {
          description: "No Space exists with that code. Please check the code and try again.",
        });
        return;
      }
      markSpaceAsRead(space.id);
      setJoinCode("");
      toast.success(`Joined ${space.name}`);
      onClose?.();
    } catch {
      toast.error("Couldn’t join the Space", {
        description: "Check your connection and try again.",
      });
    } finally {
      setBusy(null);
    }
  };

  const lastMessage = (spaceId: string) => {
    const last = messages.filter((message) => message.spaceId === spaceId).at(-1);
    if (!last) return "No messages yet";
    if (last.kind === "text") return last.text || "Message";
    return `${last.kind === "file" ? "Document" : last.kind} shared`;
  };

  const selectSpace = (space: Space) => {
    markSpaceAsRead(space.id);
    setActiveSpace(space.id);
    onClose?.();
  };

  return (
    <main className="mobile-home md:hidden">
      <header className="mobile-home-header">
        <div className="flex min-w-0 items-center gap-3">
          {tab === "profile" && (
            <button
              type="button"
              onClick={() => setTab("spaces")}
              aria-label="Back to spaces"
              title="Back to spaces"
              className="mobile-icon-button"
            >
              <ArrowLeft className="size-5" aria-hidden="true" />
            </button>
          )}
          <img
            src="/heymama.jpeg"
            alt="HeyMamaEy logo"
            className="size-11 shrink-0 rounded-2xl object-cover shadow-sm"
          />
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              HeyMamaEy
            </p>
            <h1 className="truncate text-lg font-bold leading-tight">
              {tab === "spaces" ? "Your spaces" : "Your profile"}
            </h1>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Return to chat"
              title="Return to chat"
              className="mobile-icon-button"
            >
              <ArrowLeft className="size-5" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Open settings"
            className="mobile-icon-button"
          >
            <Settings className="size-5" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="mobile-home-scroll">
        {tab === "spaces" ? (
          <div className="mobile-home-content">
            <section className="mobile-profile-summary" aria-label="Your identity">
              <div className="flex min-w-0 items-center gap-3">
                <div className="mobile-avatar">
                  <UserRound className="size-5" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">
                    {displayName === "You" ? "Set your display name" : displayName}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Your private identity</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setTab("profile")}
                className="mobile-subtle-button"
              >
                Profile <ChevronRight className="size-4" aria-hidden="true" />
              </button>
            </section>

            <section className="mobile-action-section" aria-labelledby="mobile-start-title">
              <div className="mobile-section-heading">
                <div className="mobile-section-icon bg-primary/12 text-primary">
                  <Plus className="size-5" aria-hidden="true" />
                </div>
                <div>
                  <h2 id="mobile-start-title">Start a conversation</h2>
                  <p>Create a private space or join with a code.</p>
                </div>
              </div>

              <div className="mobile-form-card">
                <label htmlFor="mobile-space-name" className="mobile-field-label">
                  Create a space
                </label>
                <div className="mobile-field-row">
                  <input
                    id="mobile-space-name"
                    value={spaceName}
                    onChange={(event) => setSpaceName(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && void handleCreate()}
                    placeholder="Space name (optional)"
                    maxLength={40}
                    className="mobile-input"
                  />
                  <button
                    type="button"
                    onClick={() => void handleCreate()}
                    disabled={busy !== null}
                    className="mobile-primary-button"
                  >
                    {busy === "create" ? "Creating…" : "Create"}
                  </button>
                </div>
              </div>

              <div className="mobile-form-card">
                <label htmlFor="mobile-join-code" className="mobile-field-label">
                  Join a space
                </label>
                <div className="mobile-field-row">
                  <input
                    id="mobile-join-code"
                    value={joinCode}
                    onChange={(event) => setJoinCode(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && void handleJoin()}
                    placeholder="Enter the space code"
                    inputMode="numeric"
                    autoComplete="off"
                    className="mobile-input font-mono tracking-wider"
                  />
                  <button
                    type="button"
                    onClick={() => void handleJoin()}
                    disabled={busy !== null}
                    className="mobile-secondary-button"
                  >
                    {busy === "join" ? "Joining…" : "Join"}
                  </button>
                </div>
              </div>
            </section>

            <section className="mobile-spaces-section" aria-labelledby="mobile-spaces-title">
              <div className="mobile-spaces-heading">
                <div>
                  <h2 id="mobile-spaces-title">Recent spaces</h2>
                  <p>{spaces.length === 1 ? "1 space" : `${spaces.length} spaces`}</p>
                </div>
                {spaces.length > 0 && (
                  <label className="mobile-search">
                    <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <input
                      aria-label="Search spaces"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search"
                    />
                    {query && (
                      <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>
                        <X className="size-4" aria-hidden="true" />
                      </button>
                    )}
                  </label>
                )}
              </div>

              {filteredSpaces.length ? (
                <div className="mobile-space-list">
                  {filteredSpaces.map((space) => {
                    const unread = getUnreadCount(space.id, messages, userId, readTimestamps);
                    return (
                      <button
                        type="button"
                        key={space.id}
                        onClick={() => selectSpace(space)}
                        className={`mobile-space-card ${space.id === activeSpaceId ? "is-active" : ""}`}
                      >
                        <span className="mobile-space-avatar">
                          <Hash className="size-5" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1 text-left">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-semibold">{space.name}</span>
                            <span className="shrink-0 text-[11px] font-mono text-primary">
                              {space.code}
                            </span>
                          </span>
                          <span className="mt-1 block truncate text-xs text-muted-foreground">
                            {lastMessage(space.id)}
                          </span>
                        </span>
                        {unread > 0 ? (
                          <span className="mobile-unread-badge">
                            {unread > 99 ? "99+" : unread}
                          </span>
                        ) : (
                          <ChevronRight
                            className="size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="mobile-empty-state">
                  <div className="mobile-empty-icon">
                    <MessageCircle className="size-6" aria-hidden="true" />
                  </div>
                  <h3>{query ? "No matching spaces" : "Your spaces will appear here"}</h3>
                  <p>
                    {query
                      ? "Try another name or code."
                      : "Create a space and share its code, or join someone with their code."}
                  </p>
                </div>
              )}
            </section>
          </div>
        ) : (
          <div className="mobile-profile-page">
            <div className="mobile-profile-hero">
              <div className="mobile-avatar size-16 rounded-3xl">
                <UserRound className="size-7" aria-hidden="true" />
              </div>
              <h2>{displayName === "You" ? "Your profile" : displayName}</h2>
              <p>Only your chosen display name is shown in spaces.</p>
            </div>

            <section className="mobile-profile-card">
              <label htmlFor="mobile-profile-name" className="mobile-field-label">
                Display name
              </label>
              <div className="mobile-field-row">
                <input
                  id="mobile-profile-name"
                  value={editingName}
                  onChange={(event) => setEditingName(event.target.value)}
                  maxLength={40}
                  placeholder="Enter your name"
                  className="mobile-input"
                />
                <button type="button" onClick={saveName} className="mobile-primary-button">
                  <Check className="size-4" aria-hidden="true" /> Save
                </button>
              </div>
            </section>

            <section className="mobile-identity-card">
              <div className="mobile-identity-heading">
                <div className="mobile-section-icon bg-emerald-500/12 text-emerald-400">
                  <ShieldCheck className="size-5" aria-hidden="true" />
                </div>
                <div>
                  <h3>Your private ID</h3>
                  <p>Use this code to restore your identity.</p>
                </div>
              </div>
              <div className="mobile-id-code">{userId}</div>
              <button type="button" onClick={() => void copyId()} className="mobile-copy-button">
                <Copy className="size-4" aria-hidden="true" /> Copy ID
              </button>
            </section>

            <button type="button" onClick={onOpenSettings} className="mobile-settings-link">
              <Settings className="size-5 text-primary" aria-hidden="true" />
              <span className="flex-1 text-left">
                <span className="block text-sm font-semibold">Appearance & preferences</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Theme, sound, privacy, and more
                </span>
              </span>
              <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      <nav
        aria-label="Main navigation"
        className={`mobile-bottom-nav ${showBottomNav ? "" : "hidden"}`}
      >
        <button
          type="button"
          aria-current={tab === "spaces" ? "page" : undefined}
          onClick={() => setTab("spaces")}
          className={`mobile-nav-item ${tab === "spaces" ? "is-active" : ""}`}
        >
          <Hash className="size-5" aria-hidden="true" />
          <span>Spaces</span>
        </button>
        <button
          type="button"
          aria-current={tab === "profile" ? "page" : undefined}
          onClick={() => setTab("profile")}
          className={`mobile-nav-item ${tab === "profile" ? "is-active" : ""}`}
        >
          <UserRound className="size-5" aria-hidden="true" />
          <span>Profile</span>
        </button>
        <button type="button" onClick={onOpenSettings} className="mobile-nav-item">
          <Settings className="size-5" aria-hidden="true" />
          <span>Settings</span>
        </button>
      </nav>
    </main>
  );
}
