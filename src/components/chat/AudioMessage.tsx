import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";

function seededBars(seed: string, count = 44) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 9973;
  return Array.from({ length: count }, (_, i) => {
    h = (h * 1103515245 + 12345 + i) % 2147483648;
    return 0.25 + ((h >> 8) % 100) / 133;
  });
}

export function AudioMessage({
  src,
  id,
  label,
}: {
  src: string;
  id: string;
  label?: string | undefined;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const bars = useMemo(() => seededBars(id), [id]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setProgress(el.currentTime);
    const onMeta = () => setDuration(el.duration || 0);
    const onEnd = () => {
      setPlaying(false);
      setProgress(0);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("ended", onEnd);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("ended", onEnd);
    };
  }, []);

  const pct = duration ? progress / duration : 0;

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
      setPlaying(true);
    } else {
      el.pause();
      setPlaying(false);
    }
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    el.currentTime = ((e.clientX - rect.left) / rect.width) * duration;
  };

  return (
    <div className="flex w-64 items-center gap-3 rounded-xl bg-background/40 p-2.5 sm:w-72">
      <audio ref={audioRef} src={src} preload="metadata" />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause audio" : "Play audio"}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform hover:scale-105"
      >
        {playing ? <Pause className="size-4" /> : <Play className="ml-0.5 size-4" />}
      </button>
      <div className="min-w-0 flex-1">
        <div onClick={seek} className="flex h-8 cursor-pointer items-center gap-[2px]">
          {bars.map((b, i) => {
            const active = i / bars.length <= pct;
            return (
              <span
                key={i}
                className={
                  "w-[3px] rounded-full transition-colors " +
                  (active ? "bg-primary" : "bg-muted-foreground/40")
                }
                style={{ height: `${Math.min(100, b * 100)}%` }}
              />
            );
          })}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
          <span className="truncate">{label ?? "Voice note"}</span>
          <span>
            {fmt(progress)} / {duration ? fmt(duration) : "--:--"}
          </span>
        </div>
      </div>
    </div>
  );
}
