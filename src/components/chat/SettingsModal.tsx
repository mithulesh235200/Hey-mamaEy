import { useState, useEffect } from "react";
import {
  ArrowLeft,
  X,
  Palette,
  Volume2,
  Sliders,
  Shield,
  Smartphone,
  Check,
  Radio,
  Sparkles,
  Copy,
  RefreshCw,
  Bell,
  Moon,
  Sun,
  Zap,
  Flame,
  Waves,
  Key,
  Eye,
  EyeOff,
  Download,
} from "lucide-react";
import { toast } from "sonner";
import {
  regenerateId,
  setDisplayName,
  getPermanentKey,
  getBackupPayload,
  restoreFromPermanentKey,
} from "@/lib/heymama";

export type Theme = "dark" | "light" | "cyberpunk" | "sunset" | "ocean";
export type Accent = "cyan" | "emerald" | "violet" | "gold" | "rose";
export type Density = "comfortable" | "compact";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  userId: string;
  displayName: string;
}

const THEMES: {
  id: Theme;
  label: string;
  desc: string;
  icon: React.ReactNode;
  previewBg: string;
}[] = [
  {
    id: "dark",
    label: "Midnight Dark",
    desc: "Sleek deep dark mode for night focus",
    icon: <Moon className="size-4 text-cyan-400" />,
    previewBg: "bg-slate-900 border-slate-700",
  },
  {
    id: "ocean",
    label: "Deep Ocean",
    desc: "Vibrant aquatic blue & teal glow",
    icon: <Waves className="size-4 text-sky-400" />,
    previewBg: "bg-sky-950 border-sky-800",
  },
  {
    id: "cyberpunk",
    label: "Cyberpunk Neon",
    desc: "High-contrast neon pink & purple vibe",
    icon: <Zap className="size-4 text-pink-400" />,
    previewBg: "bg-purple-950 border-pink-700",
  },
  {
    id: "sunset",
    label: "Sunset Gold",
    desc: "Warm amber & golden glow theme",
    icon: <Flame className="size-4 text-amber-400" />,
    previewBg: "bg-amber-950 border-amber-800",
  },
  {
    id: "light",
    label: "Pure Light",
    desc: "Clean high-contrast daylight view",
    icon: <Sun className="size-4 text-amber-500" />,
    previewBg: "bg-slate-100 border-slate-300 text-slate-900",
  },
];

const ACCENTS: { id: Accent; label: string; color: string; hsl: string; fg: string }[] = [
  { id: "cyan", label: "Electric Cyan", color: "#06b6d4", hsl: "hsl(188 94% 43%)", fg: "#ffffff" },
  {
    id: "emerald",
    label: "Neon Emerald",
    color: "#10b981",
    hsl: "hsl(160 84% 39%)",
    fg: "#ffffff",
  },
  { id: "violet", label: "Ultra Violet", color: "#8b5cf6", hsl: "hsl(262 83% 58%)", fg: "#ffffff" },
  { id: "gold", label: "Solar Gold", color: "#f59e0b", hsl: "hsl(38 92% 48%)", fg: "#000000" },
  { id: "rose", label: "Vibrant Rose", color: "#f43f5e", hsl: "hsl(343 89% 60%)", fg: "#ffffff" },
];

function savePreference(key: string, value: string) {
  localStorage.setItem(key, value);
  window.dispatchEvent(new Event("heymamaey:preferences-updated"));
}

export function SettingsModal({ open, onClose, userId, displayName }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<"appearance" | "audio" | "density" | "account">(
    "appearance",
  );
  const [editingName, setEditingName] = useState(displayName);

  // Permanent Secret Access Key State
  const [showPermanentKey, setShowPermanentKey] = useState(false);
  const [restoreInput, setRestoreInput] = useState("");
  const [showRestoreForm, setShowRestoreForm] = useState(false);

  const permanentKey = getPermanentKey();

  const handleCopyPermanentKey = async () => {
    try {
      await navigator.clipboard.writeText(permanentKey);
      toast.success("Permanent Access Key Copied!", {
        description: "Keep this key safe to access your account anywhere.",
      });
    } catch {
      toast.error("Copy failed");
    }
  };

  const handleCopyBackup = async () => {
    try {
      const payload = getBackupPayload();
      await navigator.clipboard.writeText(payload);
      toast.success("Full Backup Data Payload Copied!", {
        description: "Contains access key, display name, and joined space codes.",
      });
    } catch {
      toast.error("Copy failed");
    }
  };

  const [isRestoring, setIsRestoring] = useState(false);

  const handleRestoreAccount = async () => {
    if (!restoreInput.trim()) {
      toast.error("Please enter a valid permanent access key or backup token");
      return;
    }
    setIsRestoring(true);
    const toastId = toast.loading("Syncing identity, spaces & chat history...");
    try {
      const result = await restoreFromPermanentKey(restoreInput.trim());
      toast.dismiss(toastId);
      if (result.success) {
        toast.success("Access Granted & Data Synced!", {
          description: result.message,
        });
        setRestoreInput("");
        setShowRestoreForm(false);
        onClose();
      } else {
        toast.error("Access Failed", {
          description: result.message,
        });
      }
    } catch {
      toast.dismiss(toastId);
      toast.error("Restoration failed");
    } finally {
      setIsRestoring(false);
    }
  };

  // Theme & Accent State
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("heymamaey.theme") as Theme) || "dark";
    }
    return "dark";
  });

  const [accent, setAccent] = useState<Accent>(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("heymamaey.accent") as Accent) || "cyan";
    }
    return "cyan";
  });

  // Interactive Preference Toggles
  const [density, setDensity] = useState<Density>(() => {
    if (typeof window === "undefined") return "comfortable";
    return (localStorage.getItem("heymamaey.density") as Density) || "comfortable";
  });

  const [soundEffects, setSoundEffects] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("heymamaey.sounds") !== "false";
  });

  const [typingIndicators, setTypingIndicators] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("heymamaey.typing") !== "false";
  });

  const [messageNotifications, setMessageNotifications] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("heymamaey.notifications") === "true";
  });

  const [mobileBottomBar, setMobileBottomBar] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("heymamaey.mobileBar") !== "false";
  });

  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose, open]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", theme);
      localStorage.setItem("heymamaey.theme", theme);
      window.dispatchEvent(new Event("heymamaey:preferences-updated"));
    }
  }, [theme]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      const selected = ACCENTS.find((a) => a.id === accent);
      if (selected) {
        document.documentElement.style.setProperty("--primary", selected.hsl);
        document.documentElement.style.setProperty("--primary-foreground", selected.fg);
        localStorage.setItem("heymamaey.accent", accent);
        window.dispatchEvent(new Event("heymamaey:preferences-updated"));
      }
    }
  }, [accent]);

  useEffect(() => {
    localStorage.setItem("heymamaey.density", density);
    document.documentElement.setAttribute("data-density", density);
    window.dispatchEvent(new Event("heymamaey:preferences-updated"));
  }, [density]);

  useEffect(() => {
    savePreference("heymamaey.sounds", String(soundEffects));
  }, [soundEffects]);

  useEffect(() => {
    savePreference("heymamaey.typing", String(typingIndicators));
  }, [typingIndicators]);

  useEffect(() => {
    savePreference("heymamaey.notifications", String(messageNotifications));
  }, [messageNotifications]);

  useEffect(() => {
    savePreference("heymamaey.mobileBar", String(mobileBottomBar));
  }, [mobileBottomBar]);

  if (!open) return null;

  const handleSaveName = () => {
    if (!editingName.trim()) {
      toast.error("Name cannot be empty");
      return;
    }
    setDisplayName(editingName.trim());
    toast.success("Display name updated!");
  };

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(userId);
      toast.success("Identity Code Copied!", { description: userId });
    } catch {
      toast.error("Copy failed");
    }
  };

  const handleRegenerateId = () => {
    if (window.confirm("Are you sure? This will give you a fresh random identity code.")) {
      regenerateId();
      toast.success("Identity Regenerated");
    }
  };

  const toggleMessageNotifications = async () => {
    if (messageNotifications) {
      setMessageNotifications(false);
      return;
    }
    if (!("Notification" in window)) {
      toast.error("This device does not support web notifications");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      setMessageNotifications(true);
      toast.success("Message notifications enabled");
    } else {
      toast.error("Notification permission was not granted");
    }
  };

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl transition-all glow-ring animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4 bg-muted/30">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Sliders className="size-5" />
            </div>
            <div>
              <h2
                id="settings-dialog-title"
                className="text-lg font-bold tracking-tight text-foreground"
              >
                Interactive Settings
              </h2>
              <p className="text-xs text-muted-foreground">
                Customize your theme, layout, sound, and mobile controls
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Back from settings"
            title="Back"
            className="flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary md:hidden"
          >
            <ArrowLeft className="size-5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="hidden size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary md:flex"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Modal Layout */}
        <div className="flex min-h-0 flex-col md:flex-row h-[min(480px,calc(90dvh-150px))]">
          {/* Navigation Sidebar Tabs */}
          <div
            role="tablist"
            aria-label="Settings categories"
            className="grid w-full shrink-0 grid-cols-2 gap-1 border-b border-border bg-muted/10 p-2 md:flex md:w-48 md:flex-col md:border-b-0 md:border-r"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "appearance"}
              tabIndex={activeTab === "appearance" ? 0 : -1}
              onClick={() => setActiveTab("appearance")}
              className={`flex min-w-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-xs font-semibold transition-all w-full text-left ${
                activeTab === "appearance"
                  ? "bg-primary text-primary-foreground shadow-md"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
            >
              <Palette className="size-4" /> Theme & Colors
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "density"}
              tabIndex={activeTab === "density" ? 0 : -1}
              onClick={() => setActiveTab("density")}
              className={`flex min-w-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-xs font-semibold transition-all w-full text-left ${
                activeTab === "density"
                  ? "bg-primary text-primary-foreground shadow-md"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
            >
              <Radio className="size-4" /> Radio Layout
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "audio"}
              tabIndex={activeTab === "audio" ? 0 : -1}
              onClick={() => setActiveTab("audio")}
              className={`flex min-w-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-xs font-semibold transition-all w-full text-left ${
                activeTab === "audio"
                  ? "bg-primary text-primary-foreground shadow-md"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
            >
              <Volume2 className="size-4" /> Audio & Effects
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "account"}
              tabIndex={activeTab === "account" ? 0 : -1}
              onClick={() => setActiveTab("account")}
              className={`flex min-w-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-xs font-semibold transition-all w-full text-left ${
                activeTab === "account"
                  ? "bg-primary text-primary-foreground shadow-md"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
            >
              <Shield className="size-4" /> Identity & Code
            </button>
          </div>

          {/* Tab Content Area */}
          <div className="flex-1 overflow-y-auto p-6 thin-scroll">
            {/* TAB 1: APPEARANCE & THEMES */}
            {activeTab === "appearance" && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-bold text-foreground mb-1 flex items-center gap-2">
                    <Sparkles className="size-4 text-primary" /> Select Theme Vibe
                  </h3>
                  <p className="text-xs text-muted-foreground mb-3">
                    Choose an interactive theme palette for desktop & mobile.
                  </p>

                  <div
                    className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                    role="radiogroup"
                    aria-label="Color theme"
                  >
                    {THEMES.map((t) => {
                      const isSelected = theme === t.id;
                      return (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={isSelected}
                          tabIndex={isSelected ? 0 : -1}
                          key={t.id}
                          onClick={() => setTheme(t.id)}
                          className={`radio-card w-full text-left ${isSelected ? "radio-card-selected" : ""}`}
                        >
                          <div className="flex items-center gap-3">
                            <div
                              className={`flex size-9 items-center justify-center rounded-lg border ${t.previewBg}`}
                            >
                              {t.icon}
                            </div>
                            <div>
                              <p className="text-xs font-bold text-foreground">{t.label}</p>
                              <p className="text-[10px] text-muted-foreground">{t.desc}</p>
                            </div>
                          </div>
                          <div
                            className={`size-4 rounded-full border flex items-center justify-center transition-colors ${
                              isSelected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-muted-foreground/40"
                            }`}
                          >
                            {isSelected && <Check className="size-2.5 stroke-[3]" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="border-t border-border pt-5">
                  <h3 className="text-sm font-bold text-foreground mb-1">Accent Color Swatches</h3>
                  <p className="text-xs text-muted-foreground mb-3">
                    Select interactive primary accent color highlights.
                  </p>

                  <div className="grid grid-cols-5 gap-3">
                    {ACCENTS.map((a) => {
                      const isSelected = accent === a.id;
                      return (
                        <button
                          type="button"
                          aria-pressed={isSelected}
                          aria-label={`Accent color ${a.label}`}
                          key={a.id}
                          onClick={() => setAccent(a.id)}
                          className={`flex flex-col items-center gap-1.5 p-2 rounded-xl border transition-all ${
                            isSelected
                              ? "border-primary bg-primary/10 shadow-sm ring-2 ring-primary/40"
                              : "border-border hover:bg-muted/30"
                          }`}
                        >
                          <div
                            className="size-7 rounded-full shadow-inner border border-white/20 flex items-center justify-center transition-transform hover:scale-110"
                            style={{ backgroundColor: a.color }}
                          >
                            {isSelected && <Check className="size-4" style={{ color: a.fg }} />}
                          </div>
                          <span className="text-[10px] font-semibold text-muted-foreground">
                            {a.label.split(" ")[1]}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: RADIO LAYOUT & DENSITY */}
            {activeTab === "density" && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-bold text-foreground mb-1 flex items-center gap-2">
                    <Radio className="size-4 text-primary" /> Interactive Viewport Density
                  </h3>
                  <p className="text-xs text-muted-foreground mb-3">
                    Adjust spacing and layout scaling across devices.
                  </p>

                  <div className="space-y-3" role="radiogroup" aria-label="Message density">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={density === "comfortable"}
                      tabIndex={density === "comfortable" ? 0 : -1}
                      onClick={() => setDensity("comfortable")}
                      className={`radio-card w-full text-left ${density === "comfortable" ? "radio-card-selected" : ""}`}
                    >
                      <div>
                        <p className="text-xs font-bold text-foreground">Comfortable Mode</p>
                        <p className="text-[11px] text-muted-foreground">
                          Generous spacing, larger message bubbles, relaxed view
                        </p>
                      </div>
                      <div
                        className={`size-4 rounded-full border flex items-center justify-center ${
                          density === "comfortable"
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-muted-foreground/40"
                        }`}
                      >
                        {density === "comfortable" && <Check className="size-2.5 stroke-[3]" />}
                      </div>
                    </button>

                    <button
                      type="button"
                      role="radio"
                      aria-checked={density === "compact"}
                      tabIndex={density === "compact" ? 0 : -1}
                      onClick={() => setDensity("compact")}
                      className={`radio-card w-full text-left ${density === "compact" ? "radio-card-selected" : ""}`}
                    >
                      <div>
                        <p className="text-xs font-bold text-foreground">Compact Mode</p>
                        <p className="text-[11px] text-muted-foreground">
                          High information density, slim message paddings
                        </p>
                      </div>
                      <div
                        className={`size-4 rounded-full border flex items-center justify-center ${
                          density === "compact"
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-muted-foreground/40"
                        }`}
                      >
                        {density === "compact" && <Check className="size-2.5 stroke-[3]" />}
                      </div>
                    </button>
                  </div>
                </div>

                <div className="border-t border-border pt-5">
                  <h3 className="text-sm font-bold text-foreground mb-2 flex items-center gap-2">
                    <Smartphone className="size-4 text-primary" /> Mobile Experience
                  </h3>

                  <div className="flex items-center justify-between rounded-xl border border-border p-3.5 bg-muted/20">
                    <div>
                      <p className="text-xs font-semibold text-foreground">
                        Mobile Bottom Quick Bar
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        Show quick navigation buttons on mobile screens
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={mobileBottomBar}
                      aria-label="Show mobile quick navigation bar"
                      onClick={() => setMobileBottomBar(!mobileBottomBar)}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                        mobileBottomBar ? "bg-primary" : "bg-muted"
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block size-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                          mobileBottomBar ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: AUDIO & EFFECTS */}
            {activeTab === "audio" && (
              <div className="space-y-4">
                <h3 className="text-sm font-bold text-foreground mb-1 flex items-center gap-2">
                  <Volume2 className="size-4 text-primary" /> Sound & Audio Feedback
                </h3>
                <p className="text-xs text-muted-foreground mb-3">
                  Configure message chimes and interactive soundboard effects. Call audio stays
                  controlled by your device.
                </p>

                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded-xl border border-border p-3.5 bg-muted/20">
                    <div>
                      <p className="text-xs font-semibold text-foreground">
                        Interactive Soundboard Effects
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        Play chimes for sent and received messages and soundboard effects
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={soundEffects}
                      aria-label="Enable sound effects"
                      onClick={() => setSoundEffects(!soundEffects)}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                        soundEffects ? "bg-primary" : "bg-muted"
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block size-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                          soundEffects ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  <div className="flex items-center justify-between rounded-xl border border-border p-3.5 bg-muted/20">
                    <div>
                      <p className="text-xs font-semibold text-foreground">
                        Real-Time Typing Indicators
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        Broadcast typing status when writing text
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={typingIndicators}
                      aria-label="Enable typing indicators"
                      onClick={() => setTypingIndicators(!typingIndicators)}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                        typingIndicators ? "bg-primary" : "bg-muted"
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block size-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                          typingIndicators ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  <div className="flex items-center justify-between rounded-xl border border-border p-3.5 bg-muted/20">
                    <div className="pr-3">
                      <p className="text-xs font-semibold text-foreground">Message notifications</p>
                      <p className="text-[10px] text-muted-foreground">
                        Show device notifications when new messages arrive while HeyMamaEy is in the
                        background. You can mute each space from its chat menu.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={messageNotifications}
                      aria-label="Enable message notifications"
                      onClick={() => void toggleMessageNotifications()}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${messageNotifications ? "bg-primary" : "bg-muted"}`}
                    >
                      <span
                        className={`pointer-events-none inline-block size-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${messageNotifications ? "translate-x-5" : "translate-x-0"}`}
                      />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 4: IDENTITY & ACCOUNT */}
            {activeTab === "account" && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-bold text-foreground mb-1">
                    Your Anonymous Display Name
                  </h3>
                  <p className="text-xs text-muted-foreground mb-3">
                    Visible to other users inside shared Spaces.
                  </p>

                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      placeholder="Enter display name..."
                      className="flex-1 rounded-xl border border-border bg-background px-3.5 py-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                    <button
                      onClick={handleSaveName}
                      className="rounded-xl bg-primary px-4 py-2 text-xs font-bold text-primary-foreground hover:opacity-90 transition-opacity"
                    >
                      Save
                    </button>
                  </div>
                </div>

                <div className="border-t border-border pt-4">
                  <h3 className="text-sm font-bold text-foreground mb-1">
                    Anonymous Identity Code
                  </h3>
                  <p className="text-xs text-muted-foreground mb-3">
                    Your unique local cryptographic identifier.
                  </p>

                  <div className="flex items-center justify-between rounded-xl border border-border p-3 bg-muted/30">
                    <span className="font-mono text-xs text-foreground font-semibold truncate max-w-[280px]">
                      {userId}
                    </span>
                    <button
                      onClick={handleCopyId}
                      className="flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5 text-xs font-semibold text-secondary-foreground hover:bg-muted transition-colors"
                    >
                      <Copy className="size-3.5" /> Copy Code
                    </button>
                  </div>
                </div>

                {/* PERMANENT SECRET ACCESS KEY SECTION */}
                <div className="border-t border-border pt-5">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <h3 className="text-sm font-bold text-foreground flex items-center gap-1.5">
                        <Key className="size-4 text-primary" /> Permanent Secret Access Key
                      </h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Your permanent secret access number. Use this number to access your account & data on any device.
                      </p>
                    </div>
                    <button
                      onClick={() => setShowPermanentKey(!showPermanentKey)}
                      className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted transition-colors shrink-0"
                    >
                      {showPermanentKey ? (
                        <>
                          <EyeOff className="size-3.5" /> Hide Key
                        </>
                      ) : (
                        <>
                          <Eye className="size-3.5" /> Reveal Key
                        </>
                      )}
                    </button>
                  </div>

                  {/* Permanent Key Display Card */}
                  <div className="relative rounded-2xl border border-primary/30 bg-primary/5 p-4 mt-3">
                    {!showPermanentKey && (
                      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl bg-background/85 backdrop-blur-md p-4 text-center">
                        <Key className="size-6 text-primary mb-1 opacity-80" />
                        <span className="text-xs font-semibold text-foreground">
                          Permanent Secret Key Hidden
                        </span>
                        <p className="text-[11px] text-muted-foreground mt-0.5 mb-2 max-w-[260px]">
                          Never share your secret access key with anyone.
                        </p>
                        <button
                          onClick={() => setShowPermanentKey(true)}
                          className="rounded-xl bg-primary px-3.5 py-1.5 text-xs font-bold text-primary-foreground hover:opacity-90 transition-opacity"
                        >
                          Reveal Permanent Key
                        </button>
                      </div>
                    )}

                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block">
                          Your Permanent Access Number
                        </span>
                        <span className="font-mono text-base font-bold text-primary tracking-widest block mt-0.5">
                          {permanentKey}
                        </span>
                      </div>
                    </div>

                    <div className="mt-3.5 flex flex-wrap gap-2 pt-2 border-t border-border/40">
                      <button
                        onClick={handleCopyPermanentKey}
                        className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-primary/10 border border-primary/30 px-3 py-2 text-xs font-bold text-primary hover:bg-primary/20 transition-colors"
                      >
                        <Copy className="size-3.5" /> Copy Permanent Key
                      </button>
                      <button
                        onClick={handleCopyBackup}
                        className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-secondary border border-border px-3 py-2 text-xs font-semibold text-secondary-foreground hover:bg-muted transition-colors"
                      >
                        <Download className="size-3.5" /> Copy Full Backup Payload
                      </button>
                    </div>
                  </div>
                </div>

                {/* ACCESS ON ANOTHER DEVICE / RESTORE ACCOUNT SECTION */}
                <div className="border-t border-border pt-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-foreground">
                        Access Account on Another Device
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        Enter your permanent access key to switch or restore identity & data on this device.
                      </p>
                    </div>
                    <button
                      onClick={() => setShowRestoreForm(!showRestoreForm)}
                      className="rounded-xl bg-secondary border border-border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted transition-colors shrink-0"
                    >
                      {showRestoreForm ? "Cancel" : "Enter Key"}
                    </button>
                  </div>

                  {showRestoreForm && (
                    <div className="mt-3.5 space-y-3 rounded-2xl border border-primary/30 bg-primary/5 p-4">
                      <label className="block text-xs font-medium text-foreground">
                        Enter Permanent Access Number (e.g. 8492-3841-9021):
                      </label>
                      <input
                        type="text"
                        value={restoreInput}
                        onChange={(e) => setRestoreInput(e.target.value)}
                        placeholder="e.g. 8492-3841-9021 or HEYMAMA_KEY_..."
                        className="w-full rounded-xl border border-border bg-background p-3 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                      />
                      <button
                        onClick={handleRestoreAccount}
                        disabled={isRestoring}
                        className="w-full rounded-xl bg-primary px-4 py-2.5 text-xs font-bold text-primary-foreground hover:opacity-90 transition-opacity shadow-sm disabled:opacity-50"
                      >
                        {isRestoring ? "Syncing Spaces & Chats..." : "Access Account & Load Data"}
                      </button>
                    </div>
                  )}
                </div>

                <div className="border-t border-border pt-4">
                  <button
                    onClick={handleRegenerateId}
                    className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-xs font-semibold text-destructive hover:bg-destructive/20 transition-colors w-full justify-center"
                  >
                    <RefreshCw className="size-4" /> Regenerate Random Identity
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-6 py-3 bg-muted/20">
          <span className="text-[11px] text-muted-foreground font-medium">
            HeyMamaEy UI/UX v2.5
          </span>
          <button
            onClick={onClose}
            className="rounded-xl bg-primary px-5 py-2 text-xs font-bold text-primary-foreground hover:opacity-90 transition-opacity"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
