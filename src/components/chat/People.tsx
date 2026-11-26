// People: friends list by Unique Identity Code (WhatsApp-like, no phone number).
// Add a friend once with their code, then chat without sharing space links.
// Two variants: "desktop" (Sidebar tailwind) and "mobile" (mobile-* classes).

import { useEffect, useState } from "react";
import { Check, Copy, Inbox, MessageCircle, Send, Trash2, UserPlus, Users, X } from "lucide-react";
import { toast } from "sonner";
import {
  addContact,
  chatTitleFor,
  linkContactSpace,
  openDirectChat,
  removeContact,
  sendDmRequestPush,
  sendFriendInvite,
  useContacts,
  type Contact,
} from "@/lib/contacts";
import {
  refreshDmRequests,
  respondDmRequest,
  useDmRequests,
  type DmRequest,
} from "@/lib/dmRequests";

type PeopleProps = {
  userId: string;
  variant: "desktop" | "mobile";
  /** Called after opening a chat (close panel / navigate). */
  onDone?: (() => void) | undefined;
};

export function People({ userId, variant, onDone }: PeopleProps) {
  const contacts = useContacts();
  const dmRequests = useDmRequests();
  const [friendId, setFriendId] = useState("");
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const isMobile = variant === "mobile";

  // The inbox is polled app-wide (routes/index.tsx); refresh on mount too so
  // opening People is always current.
  useEffect(() => {
    void refreshDmRequests(true);
  }, []);

  const copyOwnCode = async () => {
    try {
      await navigator.clipboard.writeText(userId);
      toast.success("Your code copied — share it once with friends");
    } catch {
      toast.error("Couldn't copy — select it manually");
    }
  };

  const handleAdd = () => {
    const res = addContact(friendId, nickname, userId);
    if (!res.ok) {
      toast.error("Couldn't add friend", { description: res.error });
      return;
    }
    setFriendId("");
    setNickname("");
    toast.success(`Added ${nickname.trim()}`);
  };

  const handleChat = async (contact: Contact) => {
    if (busy) return;
    setBusy(`chat:${contact.id}`);
    try {
      const result = await openDirectChat(contact.id);
      if (!result) {
        toast.error("Couldn't open chat", { description: "Check your connection." });
        return;
      }
      if (result.status === "requested") {
        // Stranger gate: no room exists yet — their side must approve first.
        toast.info(`Request sent to ${contact.nickname}`, {
          description:
            "They'll review it under People → Requests and can accept to start chatting.",
          duration: 6000,
        });
        void sendDmRequestPush(contact.id).catch(() => undefined);
        return;
      }
      onDone?.();
    } finally {
      setBusy(null);
    }
  };

  const handleInvite = async (contact: Contact) => {
    if (busy) return;
    setBusy(`invite:${contact.id}`);
    let spaceCode: string | undefined;
    try {
      // Ensure a 1:1 space exists (creates + links one on first invite).
      const result = await openDirectChat(contact.id);
      if (!result) {
        toast.error("Couldn't prepare invite", { description: "Check your connection." });
        return;
      }
      if (result.status === "requested") {
        // Not approved yet: notify them of the request instead of a room invite.
        try {
          await sendDmRequestPush(contact.id);
          toast.success(`Request sent to ${contact.nickname} 🎉`, {
            description: "They'll review it under People → Requests.",
            duration: 6000,
          });
        } catch {
          toast.info(`Request queued for ${contact.nickname}`, {
            description: "No push device reachable — they'll still see it in People → Requests.",
            duration: 6000,
          });
        }
        onDone?.();
        return;
      }
      const space = result.space;
      spaceCode = space.code;
      linkContactSpace(contact.id, space.code);
      const { sent } = await sendFriendInvite({
        targetUserId: contact.id,
        spaceCode: space.code,
        spaceName: chatTitleFor(space, contacts),
      });
      if (sent > 0) {
        toast.success(`Invite sent to ${contact.nickname} 🎉`);
      } else {
        toast.info(`${contact.nickname} has no push device yet`, {
          description: `Share this space code instead: ${space.code}`,
          duration: 8000,
        });
      }
      onDone?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Check your connection.";
      const kind = (e as { kind?: string })?.kind;
      if (spaceCode) {
        // Edge Function unreachable (not deployed / no push configured): still
        // lets the user chat, and offers a manual space-code fallback.
        if (kind === "network") {
          toast.error("Push invite unavailable", {
            description:
              "The invite Edge Function isn't deployed yet. You can still chat — share this space code manually: " +
              spaceCode,
            duration: 10000,
          });
        } else {
          toast.error("Push invite unavailable", {
            description: `You can still chat. Share this space code manually: ${spaceCode}`,
            duration: 8000,
          });
        }
      } else {
        toast.error("Invite failed", { description: message });
      }
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = (contact: Contact) => {
    if (!window.confirm(`Remove ${contact.nickname} from your people?`)) return;
    removeContact(contact.id);
    toast.success(`Removed ${contact.nickname}`);
  };

  const requestLabel = (req: DmRequest) => req.name || req.requester;

  const handleAccept = async (req: DmRequest) => {
    if (busy) return;
    setBusy(`accept:${req.requester}`);
    try {
      const res = await respondDmRequest(req, true, true);
      if (res.status === "open") {
        toast.success(`You're now connected with ${requestLabel(req)}`);
        onDone?.();
      } else if (res.status === "none") {
        toast.info("That request is no longer pending");
        void refreshDmRequests(true);
      } else {
        toast.error("Couldn't accept request", { description: "Check your connection." });
      }
    } finally {
      setBusy(null);
    }
  };

  const handleDecline = async (req: DmRequest) => {
    if (busy) return;
    setBusy(`decline:${req.requester}`);
    try {
      const res = await respondDmRequest(req, false);
      if (res.status === "declined") {
        toast.success("Request declined");
      } else if (res.status === "none") {
        toast.info("That request is no longer pending");
      } else {
        toast.error("Couldn't decline request", { description: "Check your connection." });
      }
      void refreshDmRequests(true);
    } finally {
      setBusy(null);
    }
  };

  const actionBusy = busy !== null;

  if (isMobile) {
    return (
      <div className="mobile-home-content">
        <section className="mobile-profile-summary" aria-label="Your identity code">
          <div className="flex min-w-0 items-center gap-3">
            <div className="mobile-avatar">
              <Users className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="truncate font-mono text-sm font-semibold">{userId}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Share once — friends add you, no links needed.
              </p>
            </div>
          </div>
          <button type="button" onClick={() => void copyOwnCode()} className="mobile-subtle-button">
            <Copy className="size-4" aria-hidden="true" /> Copy
          </button>
        </section>

        <section className="mobile-action-section" aria-labelledby="mobile-add-title">
          <div className="mobile-section-heading">
            <div className="mobile-section-icon bg-primary/12 text-primary">
              <UserPlus className="size-5" aria-hidden="true" />
            </div>
            <div>
              <h2 id="mobile-add-title">Add a friend</h2>
              <p>Enter their identity code once.</p>
            </div>
          </div>
          <div className="mobile-form-card">
            <label htmlFor="mobile-friend-name" className="mobile-field-label">
              Nickname
            </label>
            <input
              id="mobile-friend-name"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="e.g. Amma"
              maxLength={40}
              autoComplete="off"
              className="mobile-input"
            />
            <label htmlFor="mobile-friend-id" className="mobile-field-label mt-2">
              Identity code
            </label>
            <div className="mobile-field-row">
              <input
                id="mobile-friend-id"
                value={friendId}
                onChange={(e) => setFriendId(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                placeholder="MAMA-1234-EYAB"
                autoComplete="off"
                maxLength={64}
                className="mobile-input font-mono tracking-wider"
              />
              <button
                type="button"
                onClick={handleAdd}
                disabled={actionBusy}
                className="mobile-primary-button"
              >
                <Check className="size-4" aria-hidden="true" /> Add
              </button>
            </div>
          </div>
        </section>

        {dmRequests.length > 0 && (
          <section
            className="mobile-action-section"
            aria-labelledby="mobile-requests-title"
            data-testid="dm-requests"
          >
            <div className="mobile-section-heading">
              <div className="mobile-section-icon bg-amber-500/12 text-amber-500">
                <Inbox className="size-5" aria-hidden="true" />
              </div>
              <div>
                <h2 id="mobile-requests-title">Requests ({dmRequests.length})</h2>
                <p>Review who wants to chat with you.</p>
              </div>
            </div>
            <div className="mobile-space-list">
              {dmRequests.map((req) => (
                <div key={`${req.pairKey}:${req.requester}`} className="mobile-space-card">
                  <span className="mobile-space-avatar">
                    <Inbox className="size-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-semibold">
                      {requestLabel(req)}
                    </span>
                    <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
                      {req.requester}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                      Wants to start a chat
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void handleAccept(req)}
                      disabled={actionBusy}
                      aria-label={`Accept request from ${requestLabel(req)}`}
                      title="Accept"
                      className="mobile-icon-button text-emerald-400"
                    >
                      <Check className="size-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDecline(req)}
                      disabled={actionBusy}
                      aria-label={`Decline request from ${requestLabel(req)}`}
                      title="Decline"
                      className="mobile-icon-button text-destructive"
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="mobile-spaces-section" aria-labelledby="mobile-people-title">
          <div className="mobile-spaces-heading">
            <div className="min-w-0 flex-1">
              <h2 id="mobile-people-title" className="truncate">
                Your people
              </h2>
              <p>{contacts.length === 1 ? "1 friend" : `${contacts.length} friends`}</p>
            </div>
          </div>
          {contacts.length === 0 ? (
            <div className="mobile-empty-state">
              <div className="mobile-empty-icon">
                <Users className="size-6" aria-hidden="true" />
              </div>
              <h3>No friends yet</h3>
              <p>Add someone with their identity code — chat ever after, no links.</p>
            </div>
          ) : (
            <div className="mobile-space-list">
              {contacts.map((c) => (
                <div key={c.id} className="mobile-space-card">
                  <span className="mobile-space-avatar">
                    <MessageCircle className="size-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-semibold">{c.nickname}</span>
                    <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
                      {c.id}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px]">
                      {c.keyChanged ? (
                        <span className="font-semibold text-destructive">
                          ⚠ Security key changed — confirm it's them
                        </span>
                      ) : c.keyprint ? (
                        <span className="text-emerald-400">
                          ✓ Verified key {c.keyprint.slice(0, 9)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Key not verified yet</span>
                      )}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void handleChat(c)}
                      disabled={actionBusy}
                      aria-label={`Chat with ${c.nickname}`}
                      title="Chat"
                      className="mobile-icon-button"
                    >
                      <MessageCircle className="size-4 text-primary" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleInvite(c)}
                      disabled={actionBusy}
                      aria-label={`Invite ${c.nickname}`}
                      title="Send invite"
                      className="mobile-icon-button"
                    >
                      <Send className="size-4 text-emerald-400" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemove(c)}
                      aria-label={`Remove ${c.nickname}`}
                      title="Remove"
                      className="mobile-icon-button"
                    >
                      <Trash2 className="size-4 text-destructive" aria-hidden="true" />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="border-b border-border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          <Users className="size-3" />
          <span>People{contacts.length > 0 ? ` (${contacts.length})` : ""}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => void copyOwnCode()}
        title="Copy your identity code"
        className="mt-2 flex w-full items-center justify-between gap-2 rounded-lg bg-background px-2.5 py-2 ring-1 ring-input hover:ring-accent"
      >
        <span className="min-w-0">
          <span className="block text-left text-[10px] text-muted-foreground">
            Your code — share once
          </span>
          <span className="block truncate text-left font-mono text-xs font-semibold tracking-widest">
            {userId}
          </span>
        </span>
        <Copy className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      <div className="mt-2 flex gap-1.5">
        <input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="Nickname"
          maxLength={40}
          autoComplete="off"
          aria-label="Friend nickname"
          className="min-w-0 w-24 shrink-0 rounded-lg bg-background px-2.5 py-2 text-xs outline-none ring-1 ring-input focus:ring-accent"
        />
        <input
          value={friendId}
          onChange={(e) => setFriendId(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder="MAMA-1234-EYAB"
          autoComplete="off"
          maxLength={64}
          aria-label="Friend identity code"
          className="min-w-0 flex-1 rounded-lg bg-background px-2.5 py-2 font-mono text-xs tracking-widest outline-none ring-1 ring-input focus:ring-accent"
        />
        <button
          type="button"
          onClick={handleAdd}
          disabled={actionBusy}
          aria-label="Add friend"
          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-accent px-2.5 text-xs font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <UserPlus className="size-3.5" />
        </button>
      </div>
      {dmRequests.length > 0 && (
        <div className="mt-3" data-testid="dm-requests">
          <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Inbox className="size-3" />
            <span>Requests ({dmRequests.length})</span>
          </p>
          <div className="mt-1.5 space-y-1">
            {dmRequests.map((req) => (
              <div
                key={`${req.pairKey}:${req.requester}`}
                className="flex items-center gap-2 rounded-xl bg-background px-2 py-1.5 ring-1 ring-input"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-foreground">
                    {requestLabel(req)}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">
                    {req.requester}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void handleAccept(req)}
                  disabled={actionBusy}
                  aria-label={`Accept request from ${requestLabel(req)}`}
                  title="Accept"
                  className="shrink-0 rounded-lg bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  Accept
                </button>
                <button
                  type="button"
                  onClick={() => void handleDecline(req)}
                  disabled={actionBusy}
                  aria-label={`Decline request from ${requestLabel(req)}`}
                  title="Decline"
                  className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
                >
                  Decline
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {contacts.length > 0 && (
        <div className="thin-scroll mt-2 max-h-56 space-y-1 overflow-y-auto">
          {contacts.map((c) => (
            <div
              key={c.id}
              className="group flex items-center gap-2 rounded-xl px-2 py-1.5 text-muted-foreground hover:bg-card hover:text-foreground"
            >
              <button
                type="button"
                onClick={() => void handleChat(c)}
                disabled={actionBusy}
                className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-foreground">
                    {c.nickname}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">
                    {c.id}
                  </span>
                  <span className="block truncate text-[10px]">
                    {c.keyChanged ? (
                      <span className="font-semibold text-destructive">⚠ Key changed</span>
                    ) : c.keyprint ? (
                      <span className="text-emerald-400">✓ {c.keyprint.slice(0, 9)}</span>
                    ) : (
                      <span className="text-muted-foreground">Unverified</span>
                    )}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => void handleChat(c)}
                disabled={actionBusy}
                aria-label={`Chat with ${c.nickname}`}
                title="Chat"
                className="rounded-lg p-1.5 transition-colors hover:bg-secondary hover:text-primary disabled:opacity-50"
              >
                <MessageCircle className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void handleInvite(c)}
                disabled={actionBusy}
                aria-label={`Invite ${c.nickname}`}
                title="Send invite push"
                className="rounded-lg p-1.5 transition-colors hover:bg-secondary hover:text-emerald-400 disabled:opacity-50"
              >
                <Send className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => handleRemove(c)}
                aria-label={`Remove ${c.nickname}`}
                title="Remove"
                className="rounded-lg p-1.5 transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
