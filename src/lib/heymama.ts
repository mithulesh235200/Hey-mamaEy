import { useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";

export type MediaKind = "text" | "image" | "video" | "audio" | "file" | "location" | "p2p_file";

export type Message = {
  id: string;
  spaceId: string;
  authorId: string;
  authorName: string;
  kind: MediaKind;
  text?: string;
  dataUrl?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  forwarded?: boolean;
  editedAt?: number;
  isRead?: boolean;
  readAt?: number;
  latitude?: number;
  longitude?: number;
  locationName?: string;
  threadParentId?: string;
  p2pTransferId?: string;
  p2pFileName?: string;
  p2pFileSize?: number;
  p2pMimeType?: string;
  createdAt: number;
};

export type Space = {
  id: string;
  name: string;
  code: string;
  createdAt: number;
  ownerId?: string | null;
};

export type State = {
  userId: string;
  displayName: string;
  spaces: Space[];
  messages: Message[];
  activeSpaceId: string | null;
  typingMap: Record<string, Record<string, string>>; // spaceId -> { userId: userName }
  readTimestamps: Record<string, number>; // spaceId -> lastReadTime
  ready: boolean;
};

const PREFS_KEY = "heymamaey.prefs.v2";

const rand = (n: number) =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");

const alnum = (n: number) => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
};

export const generateUserId = () => `MAMA-${rand(4)}-EY${alnum(2)}`;

export const generateSpaceCode = () => `${rand(4)}-${rand(4)}`;

/* ---------- store ---------- */

// Deterministic initial state so SSR and the first client render match.
const initialState: State = {
  userId: "",
  displayName: "You",
  spaces: [],
  messages: [],
  activeSpaceId: null,
  typingMap: {},
  readTimestamps: {},
  ready: false,
};

let state: State = initialState;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function set(next: Partial<State>) {
  state = { ...state, ...next };
  emit();
}

export const store = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => state,
};

export function useChatState(): State {
  return useSyncExternalStore(store.subscribe, store.get, () => initialState);
}

import {
  generatePermanentAccessKey,
  deriveUserIdFromAccessKey,
  createFullBackupPayload,
  parseBackupInput,
  validatePermanentAccessKey,
} from "./accessKey";

/* ---------- persistence of local prefs ---------- */

type Prefs = {
  userId: string;
  displayName: string;
  codes: string[];
  permanentKey?: string;
};

let prefs: Prefs = { userId: "", displayName: "You", codes: [], permanentKey: "" };

function savePrefs() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

function loadPrefs() {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (raw) prefs = { ...prefs, ...(JSON.parse(raw) as Prefs) };
  } catch {
    /* ignore */
  }

  try {
    // Validate permanent access key; regenerate if missing or invalid
    if (!prefs.permanentKey || !validatePermanentAccessKey(prefs.permanentKey).valid) {
      prefs.permanentKey = generatePermanentAccessKey();
    }

    // Derive deterministic userId from permanent access key if missing
    if (!prefs.userId) {
      prefs.userId = deriveUserIdFromAccessKey(prefs.permanentKey);
    }
  } catch {
    // If derivation throws for any reason, generate a valid key and ID fallback
    prefs.permanentKey = generatePermanentAccessKey();
    prefs.userId = generateUserId();
  }

  savePrefs();
}

/* ---------- wire markers ---------- */

// The `send_space_message` RPC only accepts classic kinds, so location,
// P2P invites and thread links are encoded into the legacy text/file
// columns and decoded back in toMessage. No DB migration required.
const P2P_MARKER = "__p2p__:";
const LOCATION_MARKER = "__location__:";
export const THREAD_MARKER = "\n__thread__:";

/* ---------- mapping ---------- */

type SpaceRow = {
  id: string;
  name: string;
  code: string;
  created_at: string;
  owner_id?: string | null;
};
type MessageRow = {
  id: string;
  space_id: string;
  author_id: string;
  author_name: string;
  kind: string;
  text: string | null;
  data_url: string | null;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  forwarded: boolean;
  read_at?: string | null;
  created_at: string;
};

const toSpace = (r: SpaceRow): Space => ({
  id: r.id,
  name: r.name,
  code: r.code,
  createdAt: new Date(r.created_at).getTime(),
  ...(r.owner_id !== undefined && { ownerId: r.owner_id }),
});

const toMessage = (r: MessageRow): Message => {
  // Wire decoding: location & P2P invites travel inside the legacy
  // text/file columns because the `send_space_message` RPC only accepts the
  // classic kinds (text/image/video/audio/file). See insertMessage below.
  let kind = r.kind as MediaKind;
  let text: string | undefined = r.text ?? undefined;
  let fileName: string | undefined = r.file_name ?? undefined;
  let fileSize: number | undefined = r.file_size != null ? Number(r.file_size) : undefined;
  let threadParentId: string | undefined;

  if (text && text.includes(THREAD_MARKER)) {
    const idx = text.lastIndexOf(THREAD_MARKER);
    threadParentId = text.slice(idx + THREAD_MARKER.length).trim() || undefined;
    text = text.slice(0, idx) || undefined;
  }

  let latitude: number | undefined;
  let longitude: number | undefined;
  let locationName: string | undefined;
  if (kind === "text" && text?.startsWith(LOCATION_MARKER)) {
    const payload = text.slice(LOCATION_MARKER.length);
    const [coords, ...nameParts] = payload.split("|");
    const [latStr, lngStr] = (coords ?? "").split(",");
    const lat = Number(latStr);
    const lng = Number(lngStr);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      kind = "location";
      latitude = lat;
      longitude = lng;
      locationName = nameParts.join("|") || undefined;
      text = undefined;
    }
  }

  let p2pTransferId: string | undefined;
  let p2pFileName: string | undefined;
  let p2pFileSize: number | undefined;
  let p2pMimeType: string | undefined;
  if (kind === "file" && text?.startsWith(P2P_MARKER)) {
    const payload = text.slice(P2P_MARKER.length);
    const [transferId, sizeStr, ...mimeParts] = payload.split("|");
    if (transferId) {
      kind = "p2p_file";
      p2pTransferId = transferId;
      const size = Number(sizeStr);
      p2pFileSize = Number.isFinite(size) ? size : undefined;
      p2pMimeType = mimeParts.join("|") || undefined;
      p2pFileName = fileName;
      text = undefined;
      // P2P bytes never touch the server, so keep server fileSize empty.
      fileSize = undefined;
    }
  }

  return {
    id: r.id,
    spaceId: r.space_id,
    authorId: r.author_id,
    authorName: r.author_name,
    kind,
    ...(text !== undefined && { text }),
    ...(r.data_url !== null && { dataUrl: r.data_url }),
    ...(fileName !== undefined && kind !== "p2p_file" && { fileName }),
    ...(fileSize !== undefined && kind !== "p2p_file" && { fileSize }),
    ...(r.mime_type !== null && { mimeType: r.mime_type }),
    forwarded: r.forwarded,
    ...(r.read_at != null && { isRead: true, readAt: new Date(r.read_at).getTime() }),
    ...(latitude !== undefined && { latitude }),
    ...(longitude !== undefined && { longitude }),
    ...(locationName !== undefined && { locationName }),
    ...(threadParentId !== undefined && { threadParentId }),
    ...(p2pTransferId !== undefined && { p2pTransferId }),
    ...(p2pFileName !== undefined && { p2pFileName }),
    ...(p2pFileSize !== undefined && { p2pFileSize }),
    ...(p2pMimeType !== undefined && { p2pMimeType }),
    createdAt: new Date(r.created_at).getTime(),
  };
};

/* ---------- hydrate + polling ---------- */

const POLL_MS = 10000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchSpace(code: string) {
  try {
    const { data, error } = await supabase.rpc("get_space_by_code", {
      p_code: code,
    });
    if (error) return null;
    const row = (Array.isArray(data) ? data[0] : data) as SpaceRow | null;
    if (!row || !row.id || !row.code) return null;
    return toSpace(row);
  } catch {
    return null;
  }
}

async function fetchMessages(code: string): Promise<Message[]> {
  try {
    const { data, error } = await supabase.rpc("get_space_messages", {
      p_code: code,
    });
    return error ? [] : ((data ?? []) as MessageRow[]).map(toMessage);
  } catch {
    return [];
  }
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function filterRetained(messages: Message[]): Message[] {
  const cutoff = Date.now() - RETENTION_MS;
  return messages.filter((m) => m.createdAt >= cutoff);
}

export async function syncUserSpacesFromCloud(userId: string): Promise<string[]> {
  if (!userId) return [];
  try {
    const { data, error } = await supabase.rpc("get_user_spaces", {
      p_user_id: userId,
    });
    const rows = !error && data && Array.isArray(data) ? (data as unknown as SpaceRow[]) : [];
    const cloudCodes = rows.map((s) => s.code).filter((c: string): c is string => Boolean(c));
    // Explicit memberships cover silent + legacy spaces (never messaged, no owner).
    const memberCodes = await fetchMemberCodes(userId);

    const merged = [...new Set([...prefs.codes, ...cloudCodes, ...memberCodes])];
    if (merged.length !== prefs.codes.length) {
      prefs.codes = merged;
      savePrefs();
    }
    return merged;
  } catch {
    return [];
  }
}

/** Best-effort membership registration (no-op until the migration is applied). */
async function registerMembership(code: string, userId: string): Promise<void> {
  if (!code || !userId) return;
  try {
    await supabase.rpc("register_space_member", { p_code: code, p_user_id: userId });
  } catch {
    /* ignore — membership simply isn't tracked yet */
  }
}

/** Backfills memberships for all locally known codes (legacy/silent spaces). */
function backfillMemberships() {
  const userId = prefs.userId;
  if (!userId) return;
  for (const code of prefs.codes) {
    void registerMembership(code, userId);
  }
}

async function fetchMemberCodes(userId: string): Promise<string[]> {
  if (!userId) return [];
  try {
    const { data, error } = await supabase.rpc("get_member_space_codes", {
      p_user_id: userId,
    });
    if (error || !data) return [];
    return (data as { code: string }[]).map((r) => r.code).filter(Boolean);
  } catch {
    return [];
  }
}

async function loadSpaces() {
  // Local identity is already hydrated from storage. Render the app before
  // waiting on Supabase so a slow or unavailable network cannot trap mobile
  // users on the startup screen.
  set({ ready: true });

  // Advertise the memberships this device knows about (heals legacy/silent
  // spaces for future restores on other devices). Fire-and-forget.
  backfillMemberships();

  if (prefs.userId && prefs.codes.length === 0) {
    await syncUserSpacesFromCloud(prefs.userId);
  }

  if (prefs.codes.length === 0) {
    set({ spaces: [], messages: [] });
    return;
  }

  try {
    const results = await Promise.all(prefs.codes.map(fetchSpace));
    const spaces = results.filter(
      (s): s is Space => s !== null && Boolean(s.id) && Boolean(s.code),
    );
    const ids = spaces.map((s) => s.id);
    const messageLists = await Promise.all(spaces.map((s) => fetchMessages(s.code)));
    const validMessages = filterRetained(messageLists.flat());

    set({
      spaces,
      messages: validMessages,
      // Never auto-open a Space on app launch. The user must tap a Space.
      // Only keep the current selection if it is still valid.
      activeSpaceId:
        state.activeSpaceId && ids.includes(state.activeSpaceId) ? state.activeSpaceId : null,
    });
  } catch {
    // Keep the application usable if a network request is interrupted.
    set({ ready: true });
  }
}

async function refreshActiveSpace() {
  const active = state.spaces.find((s) => s.id === state.activeSpaceId);
  if (!active) return;
  const currentRetained = filterRetained(state.messages);
  const fresh = filterRetained(await fetchMessages(active.code));
  set({
    messages: [...currentRetained.filter((message) => message.spaceId !== active.id), ...fresh],
  });
}

export function hydrate() {
  if (typeof window === "undefined") return;

  // Fail-safe timeout: ensure ready is NEVER trapped at false on mobile devices
  setTimeout(() => {
    if (!state.ready) {
      set({ ready: true });
    }
  }, 1000);

  if (hydrated) {
    set({ ready: true });
    return;
  }
  hydrated = true;

  try {
    loadPrefs();
    set({ userId: prefs.userId, displayName: prefs.displayName, ready: true });
    void (async () => {
      try {
        await loadSpaces();
      } catch {
        set({ ready: true });
      }
      const inviteCode = new URLSearchParams(window.location.search).get("space");
      if (!inviteCode) return;

      const joined = await joinSpace(inviteCode);
      if (joined) {
        window.history.replaceState({}, "", window.location.pathname);
      }
    })();
  } catch {
    set({ ready: true });
  }

  if (!pollTimer) {
    pollTimer = setInterval(() => {
      void refreshActiveSpace();
    }, POLL_MS);
  }
}

/* ---------- actions ---------- */

export function signInWithId(id: string) {
  prefs.userId = id.trim().toUpperCase();
  savePrefs();
  set({ userId: prefs.userId });
}

export function regenerateId() {
  // A fresh identity needs a fresh permanent key: the userId is derived from
  // the key, so generating a random ID alone would orphan the key and break
  // cross-device restore.
  prefs.permanentKey = generatePermanentAccessKey();
  prefs.userId = deriveUserIdFromAccessKey(prefs.permanentKey);
  savePrefs();
  set({ userId: prefs.userId });
}

export function setDisplayName(name: string) {
  prefs.displayName = name || "You";
  savePrefs();
  set({ displayName: prefs.displayName });
}

function rememberCode(code: string) {
  if (!code) return;
  if (!prefs.codes.includes(code)) {
    prefs.codes = [code, ...prefs.codes];
    savePrefs();
  }
}

export async function createSpace(name: string): Promise<Space | null> {
  const { data, error } = await supabase.rpc("create_space", {
    p_name: name.trim() || "New Space",
    p_owner_id: state.userId,
  });
  const row = (Array.isArray(data) ? data[0] : data) as SpaceRow | null;
  if (error) throw new Error(error.message);
  if (!row) throw new Error("The Space service returned no Space.");

  const space = toSpace(row);
  rememberCode(space.code);
  void registerMembership(space.code, state.userId);
  set({ spaces: [space, ...state.spaces], activeSpaceId: space.id });
  return space;
}

export async function joinSpace(rawCode: string): Promise<Space | null> {
  const digits = rawCode.replace(/[^0-9]/g, "");
  // Legacy 6-digit spaces remain joinable; all new spaces use 8 digits.
  if (digits.length !== 6 && digits.length !== 8) return null;
  const splitAt = digits.length === 8 ? 4 : 3;
  const formatted = `${digits.slice(0, splitAt)}-${digits.slice(splitAt)}`;

  const local = state.spaces.find((s) => s.code === formatted);
  if (local) {
    set({ activeSpaceId: local.id });
    void registerMembership(local.code, state.userId);
    return local;
  }

  const space = await fetchSpace(formatted);
  if (!space || !space.id || !space.code) return null;
  rememberCode(space.code);
  void registerMembership(space.code, state.userId);

  const history = await fetchMessages(space.code);
  const existingIds = new Set(state.messages.map((m) => m.id));

  set({
    spaces: [space, ...state.spaces.filter((s) => s.id !== space.id)],
    messages: [...state.messages, ...history.filter((m) => !existingIds.has(m.id))],
    activeSpaceId: space.id,
  });
  return space;
}

export function leaveSpace(spaceId: string): boolean {
  const space = state.spaces.find((s) => s.id === spaceId);
  if (space) {
    prefs.codes = prefs.codes.filter((c) => c !== space.code);
    savePrefs();
  }
  set({
    spaces: state.spaces.filter((s) => s.id !== spaceId),
    messages: state.messages.filter((m) => m.spaceId !== spaceId),
    activeSpaceId: state.activeSpaceId === spaceId ? null : state.activeSpaceId,
  });
  return Boolean(space);
}

export async function deleteSpaceForEveryone(spaceId: string): Promise<boolean> {
  const space = state.spaces.find((item) => item.id === spaceId);
  if (!space || !state.userId || space.ownerId !== state.userId) return false;

  const { data, error } = await supabase.rpc("delete_space_for_everyone", {
    p_code: space.code,
    p_owner_id: state.userId,
  });
  if (error || data !== true) return false;
  return leaveSpace(spaceId);
}

export function setActiveSpace(spaceId: string | null) {
  set({ activeSpaceId: spaceId });
}

async function insertMessage(msg: Omit<Message, "id" | "createdAt" | "authorId" | "authorName">) {
  const space = state.spaces.find((s) => s.id === msg.spaceId);
  if (!space) return false;

  // Wire encoding: the RPC rejects non-classic kinds, so location & P2P
  // invites travel inside the legacy text/file columns (see markers above).
  let wireKind: string = msg.kind;
  let wireText = msg.text;
  let wireFileName = msg.fileName;
  let wireFileSize = msg.fileSize;
  let wireMimeType = msg.mimeType;

  if (msg.kind === "p2p_file") {
    if (!msg.p2pTransferId) return false;
    wireKind = "file";
    wireText = `${P2P_MARKER}${msg.p2pTransferId}|${msg.p2pFileSize ?? 0}|${msg.p2pMimeType ?? "application/octet-stream"}`;
    wireFileName = msg.p2pFileName ?? msg.fileName;
    // The real byte size rides in the marker: the server caps file_size at 20MB,
    // but P2P streams never touch server storage so any size is allowed.
    wireFileSize = undefined;
    wireMimeType = msg.p2pMimeType ?? msg.mimeType;
  } else if (msg.kind === "location") {
    if (msg.latitude === undefined || msg.longitude === undefined) return false;
    wireKind = "text";
    wireText = `${LOCATION_MARKER}${msg.latitude},${msg.longitude}|${msg.locationName ?? ""}`;
  }

  if (msg.threadParentId) {
    wireText = `${wireText ?? ""}${THREAD_MARKER}${msg.threadParentId}`;
  }

  try {
    const { data, error } = await supabase.rpc("send_space_message", {
      p_code: space.code,
      p_author_id: state.userId,
      p_author_name: state.displayName,
      p_kind: wireKind,
      ...(wireText !== undefined && { p_text: wireText }),
      ...(msg.dataUrl !== undefined && { p_data_url: msg.dataUrl }),
      ...(wireFileName !== undefined && { p_file_name: wireFileName }),
      ...(wireFileSize !== undefined && { p_file_size: wireFileSize }),
      ...(wireMimeType !== undefined && { p_mime_type: wireMimeType }),
      p_forwarded: msg.forwarded ?? false,
    });
    const row = (Array.isArray(data) ? data[0] : data) as MessageRow | null;
    if (error || !row) return false;

    const saved = toMessage(row);
    if (!state.messages.some((m) => m.id === saved.id)) {
      set({ messages: [...state.messages, saved] });
    }
    return true;
  } catch {
    return false;
  }
}

export async function sendMessage(
  msg: Omit<Message, "id" | "createdAt" | "authorId" | "authorName">,
) {
  return insertMessage(msg);
}

export async function forwardMessage(message: Message, spaceId: string) {
  return insertMessage({
    spaceId,
    kind: message.kind,
    ...(message.text !== undefined && { text: message.text }),
    ...(message.dataUrl !== undefined && { dataUrl: message.dataUrl }),
    ...(message.fileName !== undefined && { fileName: message.fileName }),
    ...(message.fileSize !== undefined && { fileSize: message.fileSize }),
    ...(message.mimeType !== undefined && { mimeType: message.mimeType }),
    ...(message.latitude !== undefined && { latitude: message.latitude }),
    ...(message.longitude !== undefined && { longitude: message.longitude }),
    ...(message.locationName !== undefined && { locationName: message.locationName }),
    ...(message.p2pTransferId !== undefined && { p2pTransferId: message.p2pTransferId }),
    ...(message.p2pFileName !== undefined && { p2pFileName: message.p2pFileName }),
    ...(message.p2pFileSize !== undefined && { p2pFileSize: message.p2pFileSize }),
    ...(message.p2pMimeType !== undefined && { p2pMimeType: message.p2pMimeType }),
    forwarded: true,
  });
}

export async function editMessage(messageId: string, spaceId: string, text: string) {
  const space = state.spaces.find((item) => item.id === spaceId);
  if (!space) return null;
  const { data, error } = await supabase.rpc("edit_space_message", {
    p_code: space.code,
    p_message_id: messageId,
    p_author_id: state.userId,
    p_text: text.trim(),
  });
  if (error) return null;
  const row = (Array.isArray(data) ? data[0] : data) as MessageRow | null;
  if (!row) return null;
  const edited = toMessage(row);
  set({ messages: state.messages.map((item) => (item.id === edited.id ? edited : item)) });
  return edited;
}

export async function deleteMessage(messageId: string, spaceId: string) {
  const space = state.spaces.find((item) => item.id === spaceId);
  if (!space) return false;
  const { data, error } = await supabase.rpc("delete_space_message", {
    p_code: space.code,
    p_message_id: messageId,
    p_author_id: state.userId,
  });
  if (error || data !== true) return false;
  set({ messages: state.messages.filter((item) => item.id !== messageId) });
  return true;
}

/* ---------- helpers ---------- */

export function kindForFile(file: File): MediaKind {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return "file";
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.type.startsWith("image/") && !file.type.includes("svg") && file.size > 800 * 1024) {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const canvas = document.createElement("canvas");
        const MAX_WIDTH = 1920;
        const MAX_HEIGHT = 1080;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height = Math.round((height * MAX_WIDTH) / width);
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width = Math.round((width * MAX_HEIGHT) / height);
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", 0.85));
          return;
        }
        // Fallback to direct read
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      };
      img.src = url;
      return;
    }

    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function setTypingStatus(
  spaceId: string,
  userId: string,
  userName: string,
  isTyping: boolean,
) {
  const currentMap = state.typingMap[spaceId] || {};
  const nextSpaceMap = { ...currentMap };
  if (isTyping) {
    nextSpaceMap[userId] = userName;
  } else {
    delete nextSpaceMap[userId];
  }
  set({
    typingMap: {
      ...state.typingMap,
      [spaceId]: nextSpaceMap,
    },
  });
}

export function markSpaceAsRead(spaceId: string) {
  set({
    readTimestamps: {
      ...state.readTimestamps,
      [spaceId]: Date.now(),
    },
  });
}

export async function markSpaceMessagesRead(spaceCode: string, readerId: string): Promise<boolean> {
  const { error } = await supabase.rpc("mark_space_messages_read", {
    p_code: spaceCode,
    p_reader_id: readerId,
  });
  return !error;
}

export function getUnreadCount(
  spaceId: string,
  messages: Message[],
  userId: string,
  readTimestamps: Record<string, number> = {},
): number {
  if (!spaceId) return 0;
  const lastRead = readTimestamps[spaceId] || 0;
  return messages.filter(
    (m) => m.spaceId === spaceId && m.authorId !== userId && m.createdAt > lastRead,
  ).length;
}

/* ---------- Permanent Access Key & Identity Restore ---------- */

export function getPermanentKey(): string {
  loadPrefs();
  return prefs.permanentKey || "";
}

export function getBackupPayload(): string {
  loadPrefs();
  const key = prefs.permanentKey || "";
  return createFullBackupPayload(key, prefs.displayName, prefs.codes);
}

export async function restoreFromPermanentKey(input: string): Promise<{
  success: boolean;
  message: string;
  userId?: string;
}> {
  try {
    const parsed = parseBackupInput(input);
    const validation = validatePermanentAccessKey(parsed.key);
    if (!validation.valid) {
      return { success: false, message: validation.error || "Invalid permanent access key" };
    }

    prefs.permanentKey = validation.cleanKey;
    prefs.userId = parsed.userId;
    if (parsed.displayName) {
      prefs.displayName = parsed.displayName;
    }
    if (parsed.codes && parsed.codes.length > 0) {
      const mergedCodes = [...new Set([...prefs.codes, ...parsed.codes])];
      prefs.codes = mergedCodes;
    }

    savePrefs();
    set({ userId: prefs.userId, displayName: prefs.displayName });

    // Pull explicit memberships first: this recovers silent + legacy spaces
    // that owner/author tracking cannot see.
    const memberCodes = await fetchMemberCodes(prefs.userId);
    if (memberCodes.length > 0) {
      prefs.codes = [...new Set([...prefs.codes, ...memberCodes])];
      savePrefs();
    }

    // Sync cloud spaces for this userId
    await syncUserSpacesFromCloud(prefs.userId);

    // Load space data and past messages
    await loadSpaces();

    const spaceCount = state.spaces.length;
    return {
      success: true,
      message: `Access granted! Restored ${spaceCount} space(s) & past chat history for ${prefs.userId}`,
      userId: prefs.userId,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Restoration failed";
    return { success: false, message: msg };
  }
}
