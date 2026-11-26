// Stranger message requests (WhatsApp-style "message requests").
//
// Server-side: a dm_requests row is created when someone tries to open a 1:1
// thread with an identity that never consented (see get_or_create_direct_space
// in 20261126000000_dm_requests.sql). This module polls for requests
// addressed to us, auto-accepts ones from people already saved in our
// contacts (we consented when we added them — also the safety net for
// contacts saved before approval uploads existed), and exposes accept/decline
// plus the reactive inbox list for People.

import { useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getContact } from "./contacts";
import type { Space } from "./heymama";

export type DmRequest = {
  /** Sorted identity pair (a|b). */
  pairKey: string;
  /** The identity asking to chat with us (uppercase code). */
  requester: string;
  /** Their own display name — what we show in the inbox. */
  name: string;
  /** When they asked (epoch ms). */
  createdAt: number;
};

let requests: DmRequest[] = [];
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export const dmRequestStore = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => requests,
};

export function useDmRequests(): DmRequest[] {
  return useSyncExternalStore(dmRequestStore.subscribe, dmRequestStore.get, () => []);
}

type RequestRow = {
  pair_key?: unknown;
  requester?: unknown;
  request_name?: unknown;
  from_name?: unknown;
  created_at?: unknown;
};

let lastRefreshAt = 0;
let inFlight: Promise<DmRequest[]> | null = null;

/**
 * Pull pending requests addressed to us. Throttled (4 s) unless forced;
 * auto-accepts requests from identities already in our contacts. Returns
 * the CURRENT inbox list (post auto-accepts) — never throws.
 */
export function refreshDmRequests(force = false): Promise<DmRequest[]> {
  if (inFlight) return inFlight;
  if (!force && Date.now() - lastRefreshAt < 4000) return Promise.resolve(requests);
  inFlight = (async () => {
    try {
      const hm = await import("./heymama");
      const me = hm.store.get().userId;
      if (!me) return requests;
      const { data, error } = await supabase.rpc("list_dm_requests", { p_me: me });
      if (error || data == null) return requests;
      const rows = (Array.isArray(data) ? data : []) as RequestRow[];
      const parsed: DmRequest[] = rows
        .map((r) => ({
          pairKey: String(r.pair_key ?? ""),
          requester: String(r.requester ?? "").toUpperCase(),
          name: String(r.from_name ?? "").slice(0, 40),
          createdAt: Date.parse(String(r.created_at ?? "")) || Date.now(),
        }))
        .filter((r) => r.pairKey && r.requester);

      // Auto-accept: requests from people WE saved as contacts — we already
      // consented to them, so open the thread without making them wait.
      // Fire-and-forget per request; their side discovers the room through
      // the membership sync, ours on the next poll.
      const mine = parsed.filter((r) => !getContact(r.requester));
      const autoAccepts = parsed.filter((r) => getContact(r.requester));
      if (autoAccepts.length > 0) {
        await Promise.allSettled(autoAccepts.map((r) => respondDmRequest(r, true, false)));
      }

      requests = mine;
      lastRefreshAt = Date.now();
      emit();
      return requests;
    } catch {
      return requests; // offline — keep the last known inbox
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export type RespondResult =
  | { status: "open"; space: Space }
  | { status: "accepted" }
  | { status: "declined" }
  | { status: "none" }
  | { status: "error" };

/**
 * Answer a pending request. Accept records mutual consent and creates THE
 * shared room server-side; with `open` the room is adopted locally and
 * activated (the caller navigates into the chat). Without `open` (the
 * auto-accept path) membership sync adopts it on its next tick instead —
 * never yanking the UI into a chat the user didn't tap.
 * Decline just marks the row. Never throws.
 */
export async function respondDmRequest(
  req: DmRequest,
  accept: boolean,
  open = false,
): Promise<RespondResult> {
  try {
    const hm = await import("./heymama");
    const me = hm.store.get().userId;
    if (!me || !req.requester) return { status: "error" };
    const { data, error } = await supabase.rpc("respond_dm_request", {
      p_me: me,
      p_other: req.requester,
      p_accept: accept,
    });
    if (error) return { status: "error" };
    const payload = (Array.isArray(data) ? data[0] : data) as { status?: string } | null;
    if (!payload) return { status: "error" };
    if (payload.status === "declined" || payload.status === "none") {
      requests = requests.filter((r) => r.pairKey !== req.pairKey || r.requester !== req.requester);
      emit();
      return { status: payload.status === "declined" ? "declined" : "none" };
    }
    if (payload.status !== "open") return { status: "error" };

    // Thread exists now. With `open`, adopt + activate it right away (this
    // is the manual Accept in People — same side effects as opening a chat).
    if (open) {
      const opened = await hm.getOrCreateDirectSpace(req.requester, req.name || "Direct chat");
      if (opened?.status === "open") {
        requests = requests.filter(
          (r) => r.pairKey !== req.pairKey || r.requester !== req.requester,
        );
        emit();
        return { status: "open", space: opened.space };
      }
    }
    requests = requests.filter((r) => r.pairKey !== req.pairKey || r.requester !== req.requester);
    emit();
    return { status: "accepted" };
  } catch {
    return { status: "error" };
  }
}
