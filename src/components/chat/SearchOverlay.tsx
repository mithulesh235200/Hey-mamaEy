import { useEffect, useRef, useState } from "react";
import { Hash, MessageSquare, Search, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import { globalSearch, type Message, type Space } from "@/lib/heymama";
import { chatTitleFor, openDirectChat, useContacts, type Contact } from "@/lib/contacts";

type SearchOverlayProps = {
  onClose: () => void;
  spaces: Space[];
  /** Open a Space (optionally jumping to one of its messages) + close. */
  onNavigate: (spaceId: string, messageId?: string) => void;
};

/** Compact result timestamp: time for today, date otherwise. */
function formatWhen(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * WhatsApp-style global search: one box over chats, people and messages
 * across every Space this identity belongs to. Messages come from the
 * search_messages RPC merged with decrypted in-memory copies (see
 * globalSearch); results jump straight into the chat with a flash highlight.
 */
export function SearchOverlay({ onClose, spaces, onNavigate }: SearchOverlayProps) {
  const contacts = useContacts();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Message[] | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

  // Autofocus + Escape closes.
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Debounced search (250 ms); the sequence number drops stale responses.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      seqRef.current += 1;
      setResults(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const seq = ++seqRef.current;
    const timer = window.setTimeout(() => {
      void globalSearch(q).then((hits) => {
        if (seq !== seqRef.current) return;
        setResults(hits);
        setLoading(false);
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const q = query.trim().toLowerCase();
  const active = q.length >= 2;
  const matchedSpaces = active
    ? spaces
        .filter((s) => s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q))
        .slice(0, 5)
    : [];
  const matchedContacts = active
    ? contacts
        .filter((c) => c.nickname.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
        .slice(0, 5)
    : [];
  const messageHits = active ? (results ?? []) : [];
  const nothingYet =
    active && !loading && !matchedSpaces.length && !matchedContacts.length && !messageHits.length;

  const openContact = (c: Contact) => {
    void openDirectChat(c.id).then((s) => {
      if (s) onNavigate(s.id);
      else toast.error("Could not open chat", { description: "Try again from People." });
      onClose();
    });
  };

  const sectionTitle = (title: string) => (
    <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {title}
    </p>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/75 p-3 pt-[8vh] backdrop-blur-sm sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Search all chats"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        {/* Query row */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats, people & messages"
            aria-label="Search all chats"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            autoComplete="off"
            spellCheck={false}
          />
          {loading && (
            <span
              className="size-4 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
              role="status"
              aria-label="Searching"
            />
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            title="Close"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        {/* Results */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {!active && (
            <p className="px-4 py-8 text-center text-sm leading-relaxed text-muted-foreground">
              Type at least 2 characters to search your chats, people and messages.
            </p>
          )}
          {nothingYet && (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No results for “{query.trim()}”.
            </p>
          )}

          {matchedSpaces.length > 0 && (
            <>
              {sectionTitle("Chats")}
              {matchedSpaces.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onNavigate(s.id)}
                  aria-label={`Search result chat ${s.name}`}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                    <Hash className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {chatTitleFor(s, contacts)}
                  </span>
                </button>
              ))}
            </>
          )}

          {matchedContacts.length > 0 && (
            <>
              {sectionTitle("People")}
              {matchedContacts.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => openContact(c)}
                  aria-label={`Search result person ${c.nickname}`}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                    <UserRound className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {c.nickname}
                  </span>
                  <span className="shrink-0 truncate text-[11px] text-muted-foreground">
                    {c.id}
                  </span>
                </button>
              ))}
            </>
          )}

          {messageHits.length > 0 && (
            <>
              {sectionTitle("Messages")}
              {messageHits.map((m) => {
                const space = spaces.find((s) => s.id === m.spaceId);
                const label = space ? chatTitleFor(space, contacts) : "Chat";
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => onNavigate(m.spaceId, m.id)}
                    aria-label={`Search result message in ${label}`}
                    className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                      <MessageSquare className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-semibold">{label}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {formatWhen(m.createdAt)}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {m.text}
                      </span>
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
