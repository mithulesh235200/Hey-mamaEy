// Single source of truth for app theming: theme/accent definitions, storage
// keys, and the DOM application helpers. Consumed by Sidebar, SettingsModal,
// and the pre-paint boot script in __root.tsx (which inlines the accent map
// because a module import cannot run before first paint).

export type Theme = "dark" | "light" | "cyberpunk" | "sunset" | "ocean";
export type Accent = "cyan" | "emerald" | "violet" | "gold" | "rose";

export const THEME_STORAGE_KEY = "heymamaey.theme";
export const ACCENT_STORAGE_KEY = "heymamaey.accent";
/** Broadcast whenever any appearance preference changes. */
export const PREFERENCES_EVENT = "heymamaey:preferences-updated";

export type ThemeDef = {
  id: Theme;
  /** Long display name (cards). */
  label: string;
  /** Compact name for narrow pickers (Sidebar grid). */
  shortLabel: string;
  desc: string;
  /** Emoji used by compact pickers. */
  emoji: string;
  previewBg: string;
};

export const THEMES: ThemeDef[] = [
  {
    id: "dark",
    label: "Midnight Dark",
    shortLabel: "Midnight",
    desc: "Sleek deep dark mode for night focus",
    emoji: "🌙",
    previewBg: "bg-slate-900 border-slate-700",
  },
  {
    id: "light",
    label: "Pure Light",
    shortLabel: "Light",
    desc: "Clean high-contrast daylight view",
    emoji: "☀️",
    previewBg: "bg-slate-100 border-slate-300 text-slate-900",
  },
  {
    id: "cyberpunk",
    label: "Cyberpunk Neon",
    shortLabel: "Cyberpunk",
    desc: "High-contrast neon pink & purple vibe",
    emoji: "⚡",
    previewBg: "bg-purple-950 border-pink-700",
  },
  {
    id: "sunset",
    label: "Sunset Gold",
    shortLabel: "Sunset",
    desc: "Warm amber & golden glow theme",
    emoji: "🌅",
    previewBg: "bg-amber-950 border-amber-800",
  },
  {
    id: "ocean",
    label: "Deep Ocean",
    shortLabel: "Ocean",
    desc: "Vibrant aquatic blue & teal glow",
    emoji: "🌊",
    previewBg: "bg-sky-950 border-sky-800",
  },
];

export const ACCENTS: { id: Accent; label: string; color: string; hsl: string; fg: string }[] = [
  { id: "cyan", label: "Electric Cyan", color: "#06b6d4", hsl: "hsl(188 94% 43%)", fg: "#ffffff" },
  { id: "emerald", label: "Neon Emerald", color: "#10b981", hsl: "hsl(160 84% 39%)", fg: "#ffffff" },
  { id: "violet", label: "Ultra Violet", color: "#8b5cf6", hsl: "hsl(262 83% 58%)", fg: "#ffffff" },
  { id: "gold", label: "Solar Gold", color: "#f59e0b", hsl: "hsl(38 92% 48%)", fg: "#000000" },
  { id: "rose", label: "Vibrant Rose", color: "#f43f5e", hsl: "hsl(343 89% 60%)", fg: "#ffffff" },
];

export function isTheme(value: unknown): value is Theme {
  return THEMES.some((t) => t.id === value);
}

export function isAccent(value: unknown): value is Accent {
  return ACCENTS.some((a) => a.id === value);
}

/** Reads the persisted theme (defaults to "dark"; never throws). */
export function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    /* storage unavailable (private mode) — fall through to default */
  }
  return "dark";
}

/** Reads the persisted accent (defaults to "cyan"; never throws). */
export function loadAccent(): Accent {
  try {
    const stored = localStorage.getItem(ACCENT_STORAGE_KEY);
    if (isAccent(stored)) return stored;
  } catch {
    /* storage unavailable (private mode) — fall through to default */
  }
  return "cyan";
}

/** Applies + persists the theme, then notifies all preference listeners. */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* storage unavailable — the theme still applies for this session */
  }
  window.dispatchEvent(new Event(PREFERENCES_EVENT));
}

/** Applies + persists the accent, then notifies all preference listeners. */
export function applyAccent(accent: Accent): void {
  if (typeof document === "undefined") return;
  const selected = ACCENTS.find((a) => a.id === accent);
  if (!selected) return;
  document.documentElement.style.setProperty("--primary", selected.hsl);
  document.documentElement.style.setProperty("--primary-foreground", selected.fg);
  try {
    localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  } catch {
    /* storage unavailable — the accent still applies for this session */
  }
  window.dispatchEvent(new Event(PREFERENCES_EVENT));
}

/**
 * Returns the blocking inline script that applies the saved theme/accent
 * before first paint (prevents the dark flash on light/other themes).
 * Built from the constants above so the boot script can never drift.
 */
export function themeBootScript(): string {
  const themeIds = JSON.stringify(THEMES.map((t) => t.id));
  const accentMap = JSON.stringify(
    Object.fromEntries(ACCENTS.map((a) => [a.id, [a.hsl, a.fg]])),
  );
  return (
    `(function(){try{` +
    `var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})||"dark";` +
    `if(${themeIds}.indexOf(t)<0)t="dark";` +
    `document.documentElement.setAttribute("data-theme",t);` +
    `var m=${accentMap};` +
    `var a=localStorage.getItem(${JSON.stringify(ACCENT_STORAGE_KEY)})||"cyan";` +
    `var e=m[a];` +
    `if(e){document.documentElement.style.setProperty("--primary",e[0]);` +
    `document.documentElement.style.setProperty("--primary-foreground",e[1]);}` +
    `}catch(err){}})();`
  );
}
