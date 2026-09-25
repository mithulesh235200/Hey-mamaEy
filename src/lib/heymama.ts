import { useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";

export type MediaKind = "text" | "image" | "video" | "audio" | "file";

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
  createdAt: number;
};

export type Space = {
  id: string;
  name: string;
  code: string;
  createdAt: number;
};

export type State = {
  userId: string;
  displayName: string;
  spaces: Space[];
  messages: Message[];
  activeSpaceId: string | null;
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

/* ---------- persistence of local prefs ---------- */

type Prefs = { userId: string; displayName: string; codes: string[] };

let prefs: Prefs = { userId: "", displayName: "You", codes: [] };

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
  if (!prefs.userId) prefs.userId = generateUserId();
  savePrefs();
}

/* ---------- mapping ---------- */

type SpaceRow = { id: string; name: string; code: string; created_at: string };
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
  created_at: string;
};

const toSpace = (r: SpaceRow): Space => ({
  id: r.id,
  name: r.name,
  code: r.code,
  createdAt: new Date(r.created_at).getTime(),
});

const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  spaceId: r.space_id,
  authorId: r.author_id,
  authorName: r.author_name,
  kind: r.kind as MediaKind,
  ...(r.text !== null && { text: r.text }),
  ...(r.data_url !== null && { dataUrl: r.data_url }),
  ...(r.file_name !== null && { fileName: r.file_name }),
  ...(r.file_size !== null && { fileSize: Number(r.file_size) }),
  ...(r.mime_type !== null && { mimeType: r.mime_type }),
  forwarded: r.forwarded,
  createdAt: new Date(r.created_at).getTime(),
});

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
    return row ? toSpace(row) : null;
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

async function fetchMessagesSince(code: string, after: number): Promise<Message[]> {
  try {
    const { data, error } = await supabase.rpc("get_space_messages_since", {
      p_code: code,
      p_after: new Date(Math.max(0, after - 1)).toISOString(),
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

async function loadSpaces() {
  if (prefs.codes.length === 0) {
    set({ spaces: [], messages: [], ready: true });
    return;
  }
  try {
    const results = await Promise.all(prefs.codes.map(fetchSpace));
    const spaces = results.filter((s): s is Space => s !== null);
    const ids = spaces.map((s) => s.id);
    const messageLists = await Promise.all(spaces.map((s) => fetchMessages(s.code)));
    const validMessages = filterRetained(messageLists.flat());

    set({
      spaces,
      messages: validMessages,
      ready: true,
      activeSpaceId:
        state.activeSpaceId && ids.includes(state.activeSpaceId)
          ? state.activeSpaceId
          : (spaces[0]?.id ?? null),
    });
  } catch {
    // Keep the application usable if a network request is interrupted.
    set({ ready: true });
  }
}

async function refreshActiveSpace() {
  if (typeof document !== "undefined" && document.hidden) return;
  const active = state.spaces.find((s) => s.id === state.activeSpaceId);
  if (!active) return;
  const currentRetained = filterRetained(state.messages);
  const activeMessages = currentRetained.filter((m) => m.spaceId === active.id);
  const newest = activeMessages.reduce((latest, message) => Math.max(latest, message.createdAt), 0);
  const fresh = await fetchMessagesSince(active.code, newest);
  const known = new Set(activeMessages.map((m) => m.id));
  const added = filterRetained(fresh).filter((m) => !known.has(m.id));

  set({ messages: [...currentRetained, ...added] });
}

export function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  loadPrefs();
  set({ userId: prefs.userId, displayName: prefs.displayName });
  void (async () => {
    await loadSpaces();
    const inviteCode = new URLSearchParams(window.location.search).get("space");
    if (!inviteCode) return;

    const joined = await joinSpace(inviteCode);
    if (joined) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  })();

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
  prefs.userId = generateUserId();
  savePrefs();
  set({ userId: prefs.userId });
}

export function setDisplayName(name: string) {
  prefs.displayName = name || "You";
  savePrefs();
  set({ displayName: prefs.displayName });
}

function rememberCode(code: string) {
  if (!prefs.codes.includes(code)) {
    prefs.codes = [code, ...prefs.codes];
    savePrefs();
  }
}

export async function createSpace(name: string): Promise<Space | null> {
  const { data, error } = await supabase.rpc("create_space", {
    p_name: name.trim() || "New Space",
  });
  const row = (Array.isArray(data) ? data[0] : data) as SpaceRow | null;
  if (error) throw new Error(error.message);
  if (!row) throw new Error("The Space service returned no Space.");

  const space = toSpace(row);
  rememberCode(space.code);
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
    return local;
  }

  const space = await fetchSpace(formatted);
  if (!space) return null;
  rememberCode(space.code);

  const history = await fetchMessages(space.code);
  const existingIds = new Set(state.messages.map((m) => m.id));

  set({
    spaces: [space, ...state.spaces],
    messages: [...state.messages, ...history.filter((m) => !existingIds.has(m.id))],
    activeSpaceId: space.id,
  });
  return space;
}

export function leaveSpace(spaceId: string) {
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
}

export function setActiveSpace(spaceId: string | null) {
  set({ activeSpaceId: spaceId });
}

async function insertMessage(msg: Omit<Message, "id" | "createdAt" | "authorId" | "authorName">) {
  const space = state.spaces.find((s) => s.id === msg.spaceId);
  if (!space) return false;

  try {
    const { data, error } = await supabase.rpc("send_space_message", {
      p_code: space.code,
      p_author_id: state.userId,
      p_author_name: state.displayName,
      p_kind: msg.kind,
      ...(msg.text !== undefined && { p_text: msg.text }),
      ...(msg.dataUrl !== undefined && { p_data_url: msg.dataUrl }),
      ...(msg.fileName !== undefined && { p_file_name: msg.fileName }),
      ...(msg.fileSize !== undefined && { p_file_size: msg.fileSize }),
      ...(msg.mimeType !== undefined && { p_mime_type: msg.mimeType }),
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

