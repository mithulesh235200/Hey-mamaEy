import { useRef, useState } from "react";
import { Pause, Play, Wand2 } from "lucide-react";
import { toast } from "sonner";

type VoiceFx = "normal" | "chipmunk" | "robot" | "deep";

export function AudioMessage({ dataUrl, mine }: { dataUrl: string; mine?: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 1.5 | 2>(1);
  const [voiceFx, setVoiceFx] = useState<VoiceFx>("normal");
  const [showFxMenu, setShowFxMenu] = useState(false);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.pause();
    } else {
      void a.play();
    }
  };

  const cycleSpeed = () => {
    const nextSpeed = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
    setSpeed(nextSpeed);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextSpeed * getFxRate(voiceFx);
    }
  };

  const changeFx = (fx: VoiceFx) => {
    setVoiceFx(fx);
    setShowFxMenu(false);
    if (audioRef.current) {
      audioRef.current.playbackRate = speed * getFxRate(fx);
    }
    toast.success(`Voice effect: ${fx.toUpperCase()}`);
  };

  const getFxRate = (fx: VoiceFx) => {
    if (fx === "chipmunk") return 1.35;
    if (fx === "robot") return 0.75;
    if (fx === "deep") return 0.85;
    return 1;
  };

  return (
    <div className="flex flex-col gap-1.5 py-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          className={`flex size-9 items-center justify-center rounded-full transition-transform hover:scale-105 ${
            mine
              ? "bg-primary-foreground text-primary"
              : "bg-primary text-primary-foreground"
          }`}
          aria-label={playing ? "Pause voice note" : "Play voice note"}
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </button>

        <div className="flex flex-col min-w-28">
          <div className="flex h-3 items-center gap-0.5">
            {[40, 75, 30, 90, 60, 100, 45, 80, 50, 95, 35, 70, 85, 40].map((h, i) => (
              <span
                key={i}
                className={`w-0.5 rounded-full transition-all ${
                  playing ? "animate-pulse" : ""
                } ${mine ? "bg-primary-foreground/75" : "bg-primary/75"}`}
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
          <span className={`text-[10px] mt-0.5 ${mine ? "text-primary-foreground/80" : "text-muted-foreground"}`}>
            Voice Note
          </span>
        </div>

        <button
          type="button"
          onClick={cycleSpeed}
          title="Playback speed"
          className={`rounded-full px-2 py-0.5 text-[10px] font-mono font-bold transition-colors ${
            mine
              ? "bg-primary-foreground/20 text-primary-foreground hover:bg-primary-foreground/30"
              : "bg-secondary text-foreground hover:bg-secondary/80"
          }`}
        >
          {speed}x
        </button>

        <div className="relative">
          <button
            type="button"
            onClick={() => setShowFxMenu((v) => !v)}
            title="Voice Pitch FX"
            className={`rounded-full p-1.5 transition-colors ${
              voiceFx !== "normal" ? "bg-amber-500 text-black font-bold" : mine ? "bg-primary-foreground/20 text-primary-foreground" : "bg-secondary text-muted-foreground"
            }`}
          >
            <Wand2 className="size-3" />
          </button>

          {showFxMenu && (
            <div className="absolute right-0 bottom-7 z-40 w-32 rounded-xl border border-border bg-card p-1 shadow-xl animate-in zoom-in-95 duration-150">
              {(["normal", "chipmunk", "robot", "deep"] as VoiceFx[]).map((fx) => (
                <button
                  key={fx}
                  type="button"
                  onClick={() => changeFx(fx)}
                  className={
                    "flex w-full items-center justify-between rounded-lg px-2 py-1 text-[11px] capitalize transition-colors " +
                    (voiceFx === fx ? "bg-primary text-primary-foreground font-semibold" : "hover:bg-secondary text-muted-foreground")
                  }
                >
                  <span>{fx === "chipmunk" ? "🐿️ Chipmunk" : fx === "robot" ? "🤖 Robot" : fx === "deep" ? "🎙️ Deep" : "Normal"}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <audio
          ref={audioRef}
          src={dataUrl}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      </div>
    </div>
  );
}
