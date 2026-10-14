// Friends list: semi-permanent Unique Identity Codes (like phone numbers).
// A contact is a friend's user ID + nickname + the linked 1:1 space code.
// Stored locally per device and included in the access-key backup payload,
// so contacts survive restores. No server directory: invites travel via push.

import { useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";

export type Contact = {
  /** Friend's identity code, normalized uppercase (e.g. MAMA-1234-EYAB). */
  id: string;
  nickname: string;
  /** Linked 1:1 space code (empty until the first chat/invite). */
  spaceCode?: string;
  addedAt: number;
  /** Pinned identity-key fingerprint (trust-on-first-use, Phase 2). */
  keyprint?: string;
  /** True when a verified message arrived under a DIFFERENT pinned key. */
  keyChanged?: boolean;
};

const CONTACTS_KEY = "heymamaey.contacts.v1";
const MAX_CONTACTS = 200;

/** Trim + uppercase. Returns "" when the shape is unusable. */
export function normalizeContactId(input: string): string {
  const clean = (input ?? "").trim().toUpperCase();
  if (clean.length < 3 || clean.length > 64) return "";
  if (!/^[A-Z0-9][A-Z0-9-]*[A-Z0-9]$/.test(clean)) return "";
  return clean;
}

export function isValidContactId(input: string): boolean {
  return normalizeContactId(input) !== "";
}

function loadContacts(): Contact[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CONTACTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: Contact[] = [];
    for (const entry of parsed) {
      const c = entry as Partial<Contact>;
      const id = normalizeContactId(String(c.id ?? ""));
      const nickname = String(c.nickname ?? "")
        .trim()
        .slice(0, 40);
      if (!id || !nickname) continue;
      const spaceCode =
        typeof c.spaceCode === "string" && c.spaceCode.trim() ? c.spaceCode.trim() : undefined;
      const keyprint =
        typeof c.keyprint === "string" && /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/.test(c.keyprint)
          ? c.keyprint
          : undefined;
      out.push({
        id,
        nickname,
        ...(spaceCode !== undefined && { spaceCode }),
        addedAt: typeof c.addedAt === "number" ? c.addedAt : Date.now(),
        ...(keyprint !== undefined && { keyprint }),
        ...(c.keyChanged === true && { keyChanged: true as const }),
      });
      if (out.length >= MAX_CONTACTS) break;
    }
    // De-dupe by id, keep first.
    return [...new Map(out.map((c) => [c.id, c])).values()];
  } catch {
    return [];
  }
}

function saveContacts(next: Contact[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONTACTS_KEY, JSON.stringify(next.slice(0, MAX_CONTACTS)));
  } catch {
    /* storage denied — contacts stay in memory */
  }
}

let contacts: Contact[] = typeof window === "undefined" ? [] : loadContacts();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function set(next: Contact[]) {
  contacts = next;
  saveContacts(next);
  emit();
}

export const contactStore = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => contacts,
};

export function useContacts(): Contact[] {
  return useSyncExternalStore(contactStore.subscribe, contactStore.get, () => []);
}

/** Portable snapshot for the access-key backup payload. */
export function exportContacts(): {
  id: string;
  nickname: string;
  spaceCode?: string;
  keyprint?: string;
}[] {
  return contacts.map((c) => ({
    id: c.id,
    nickname: c.nickname,
    ...(c.spaceCode !== undefined && { spaceCode: c.spaceCode }),
    ...(c.keyprint !== undefined && { keyprint: c.keyprint }),
  }));
}

/** Merge backup contacts in: add missing, fill gaps, never clobber local edits. */
export function mergeContacts(
  incoming: { id?: unknown; nickname?: unknown; spaceCode?: unknown; keyprint?: unknown }[],
): number {
  if (!Array.isArray(incoming) || incoming.length === 0) return 0;
  const byId = new Map(contacts.map((c) => [c.id, c]));
  let added = 0;
  for (const raw of incoming.slice(0, MAX_CONTACTS)) {
    if (!raw || typeof raw !== "object") continue;
    const id = normalizeContactId(String((raw as { id?: unknown }).id ?? ""));
    if (!id) continue;
    const nickname = String((raw as { nickname?: unknown }).nickname ?? "")
      .trim()
      .slice(0, 40);
    const spaceCode =
      typeof (raw as { spaceCode?: unknown }).spaceCode === "string" &&
      ((raw as { spaceCode?: string }).spaceCode ?? "").trim()
        ? ((raw as { spaceCode?: string }).spaceCode ?? "").trim()
        : undefined;
    const keyprint =
      typeof (raw as { keyprint?: unknown }).keyprint === "string" &&
      /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/.test((raw as { keyprint?: string }).keyprint ?? "")
        ? ((raw as { keyprint?: string }).keyprint as string)
        : undefined;
    const existing = byId.get(id);
    if (!existing) {
      if (!nickname) continue;
      byId.set(id, {
        id,
        nickname,
        ...(spaceCode !== undefined && { spaceCode }),
        ...(keyprint !== undefined && { keyprint }),
        addedAt: Date.now(),
      });
      added++;
    } else {
      let updated = existing;
      if (spaceCode && !existing.spaceCode) updated = { ...updated, spaceCode };
      if (keyprint && !existing.keyprint) updated = { ...updated, keyprint };
      byId.set(id, updated);
    }
  }
  set([...byId.values()]);
  return added;
}

export function addContact(
  rawId: string,
  nickname: string,
  ownId?: string,
): { ok: boolean; error?: string } {
  const id = normalizeContactId(rawId);
  if (!id) return { ok: false, error: "Enter a valid identity code (e.g. MAMA-1234-EYAB)." };
  const name = (nickname ?? "").trim().slice(0, 40);
  if (!name) return { ok: false, error: "Give this friend a nickname." };
  if (ownId && id === ownId.trim().toUpperCase()) {
    return { ok: false, error: "That's your own code — share it with a friend instead." };
  }
  if (contacts.some((c) => c.id === id)) return { ok: false, error: "Already in your people." };
  if (contacts.length >= MAX_CONTACTS) return { ok: false, error: "People list is full." };
  set([...contacts, { id, nickname: name, addedAt: Date.now() }]);
  return { ok: true };
}

export function removeContact(id: string): boolean {
  const key = normalizeContactId(id);
  if (!key || !contacts.some((c) => c.id === key)) return false;
  set(contacts.filter((c) => c.id !== key));
  return true;
}

export function linkContactSpace(id: string, spaceCode: string): void {
  const key = normalizeContactId(id);
  const code = (spaceCode ?? "").trim();
  if (!key || !code) return;
  set(contacts.map((c) => (c.id === key ? { ...c, spaceCode: code } : c)));
}

export function getContact(id: string): Contact | null {
  const key = normalizeContactId(id);
  return contacts.find((c) => c.id === key) ?? null;
}

/**
 * Trust-on-first-use pinning (Phase 2). Records the fingerprint from the
 * first VERIFIED message; later mismatches flag the contact instead of
 * silently switching trust. Returns "pinned" | "ok" | "changed" | "unknown".
 */
export function pinContactKey(id: string, print: string): "pinned" | "ok" | "changed" | "unknown" {
  const key = normalizeContactId(id);
  const contact = contacts.find((c) => c.id === key);
  if (!contact || !print) return "unknown";
  if (!contact.keyprint) {
    set(contacts.map((c) => (c.id === key ? { ...c, keyprint: print } : c)));
    return "pinned";
  }
  if (contact.keyprint === print) {
    if (contact.keyChanged) {
      set(contacts.map((c) => (c.id === key ? { ...c, keyChanged: false } : c)));
    }
    return "ok";
  }
  set(contacts.map((c) => (c.id === key ? { ...c, keyChanged: true } : c)));
  return "changed";
}

/** Drop the whole people list (fresh identity). */
export function clearContacts(): void {
  set([]);
}

/**
 * Open the 1:1 chat for a friend: reuse the linked space, rejoin it, or
 * create a fresh private space and link it. Never throws (returns null).
 */
export async function openDirectChat(contactId: string) {
  const contact = getContact(contactId);
  if (!contact) return null;
  const hm = await import("./heymama");
  const current = hm.store.get();
  if (contact.spaceCode) {
    const local = current.spaces.find((s) => s.code === contact.spaceCode);
    if (local) {
      hm.setActiveSpace(local.id);
      hm.markSpaceAsRead(local.id);
      return local;
    }
    try {
      const joined = await hm.joinSpace(contact.spaceCode);
      if (joined) return joined;
    } catch {
      /* linked code dead (locked/banned/deleted) — create a fresh one below */
    }
  }
  try {
    const created = await hm.createSpace(`Chat with ${contact.nickname}`, { mode: "private" });
    if (created) linkContactSpace(contact.id, created.code);
    return created;
  } catch {
    return null;
  }
}

export type InviteResult = { sent: number };

/**
 * Deliver a chat invite to a friend's devices via push (server fan-out by
 * user ID). Resolves {sent: n}; n === 0 means the friend has no reachable
 * push device — share the space code manually instead. Throws on bad input
 * or network failure.
 */
export async function sendFriendInvite(opts: {
  targetUserId: string;
  spaceCode: string;
  spaceName: string;
}): Promise<InviteResult> {
  const target = normalizeContactId(opts.targetUserId);
  if (!target) throw new Error("Invalid identity code.");
  const code = (opts.spaceCode ?? "").trim();
  if (!code) throw new Error("No space to invite to yet — chat first.");
  const hm = await import("./heymama");
  const me = hm.store.get();
  if (!me.userId) throw new Error("Identity not ready yet.");
  const { data, error } = await supabase.functions.invoke("invite-friend", {
    body: {
      target_user_id: target,
      from_user_id: me.userId,
      from_name: (me.displayName || "A friend").slice(0, 40),
      space_code: code,
      space_name: (opts.spaceName || "a private chat").slice(0, 60),
    },
  });
  if (error) throw new Error(error.message || "Invite failed to send.");
  const sent = Number((data as { sent?: unknown } | null)?.sent ?? 0);
  return { sent: Number.isFinite(sent) ? sent : 0 };
}
