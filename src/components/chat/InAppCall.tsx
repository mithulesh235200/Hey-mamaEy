import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Monitor, MonitorOff, Phone, PhoneOff, Video, VideoOff, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

type CallMode = "voice" | "video";
type CallSignal = {
  callId: string;
  from: string;
  to?: string | undefined;
  mode?: CallMode | undefined;
  offer?: RTCSessionDescriptionInit | undefined;
  answer?: RTCSessionDescriptionInit | undefined;
  candidate?: RTCIceCandidateInit | undefined;
};

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
    { urls: "stun:stun.services.mozilla.com" },
    { urls: "stun:global.stun.twilio.com:3478" },
  ],
};

function startRingtone(): () => void {
  if (typeof window === "undefined") return () => {};
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return () => {};
    const ctx = new AudioContextClass();
    let playing = true;

    const chime = () => {
      if (!playing) return;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = "sine";
      osc2.type = "sine";
      osc1.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
      osc2.frequency.setValueAtTime(659.25, ctx.currentTime); // E5

      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.2);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start();
      osc2.start();
      osc1.stop(ctx.currentTime + 1.2);
      osc2.stop(ctx.currentTime + 1.2);
    };

    chime();
    const interval = setInterval(chime, 2500);

    return () => {
      playing = false;
      clearInterval(interval);
      void ctx.close().catch(() => {});
    };
  } catch {
    return () => {};
  }
}

export function InAppCall({
  spaceCode,
  userId,
  requestedMode,
  onClose,
}: {
  spaceCode: string;
  userId: string;
  requestedMode: CallMode | null;
  onClose: () => void;
}) {
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const iceCandidatesQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const callIdRef = useRef<string | null>(null);
  const peerUserIdRef = useRef<string | null>(null);
  const pendingOfferRef = useRef<CallSignal | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);

  const [active, setActive] = useState(false);
  const [mode, setMode] = useState<CallMode>("video");
  const [incoming, setIncoming] = useState<CallSignal | null>(null);
  const [connected, setConnected] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState("");

  const send = async (event: string, payload: CallSignal) => {
    await channelRef.current?.send({ type: "broadcast", event, payload });
  };

  const closePeer = () => {
    if (screenTrackRef.current) {
      screenTrackRef.current.stop();
      screenTrackRef.current = null;
    }
    peerRef.current?.close();
    peerRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    iceCandidatesQueueRef.current = [];
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setConnected(false);
    setActive(false);
    setSharingScreen(false);
    setIncoming(null);
    callIdRef.current = null;
    peerUserIdRef.current = null;
    pendingOfferRef.current = null;
  };

  const processQueuedCandidates = async () => {
    const peer = peerRef.current;
    if (!peer || !peer.remoteDescription) return;
    const queue = [...iceCandidatesQueueRef.current];
    iceCandidatesQueueRef.current = [];
    for (const candidate of queue) {
      try {
        await peer.addIceCandidate(candidate);
      } catch {
        /* ignore invalid candidates */
      }
    }
  };

  const createPeer = async (callId: string, callMode: CallMode, remoteUserId?: string) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callMode === "video",
    });
    const peer = new RTCPeerConnection(ICE_SERVERS);
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));

    peer.ontrack = (event) => {
      const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
      remoteStreamRef.current = remoteStream;
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
        remoteVideoRef.current.play().catch(() => {});
      }
    };

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        void send("call-ice", {
          callId,
          from: userId,
          to: remoteUserId ?? peerUserIdRef.current ?? undefined,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") setConnected(true);
      if (["failed", "disconnected", "closed"].includes(peer.connectionState)) closePeer();
    };

    peerRef.current = peer;
    localStreamRef.current = stream;
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
      localVideoRef.current.play().catch(() => {});
    }
    callIdRef.current = callId;
    if (remoteUserId) peerUserIdRef.current = remoteUserId;
    setMode(callMode);
    setActive(true);
    return peer;
  };

  const startCall = async (callMode: CallMode) => {
    if (active || !channelRef.current) return;
    setError("");
    const callId = crypto.randomUUID();
    try {
      const peer = await createPeer(callId, callMode);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await send("call-offer", { callId, from: userId, mode: callMode, offer });
    } catch {
      closePeer();
      setError("Camera or microphone permission is required for calls.");
    }
  };

  const acceptCall = async () => {
    const offerSignal = pendingOfferRef.current;
    if (!offerSignal?.offer) return;
    setError("");
    try {
      const callMode = offerSignal.mode ?? "video";
      const peer = await createPeer(offerSignal.callId, callMode, offerSignal.from);
      await peer.setRemoteDescription(offerSignal.offer);
      await processQueuedCandidates();
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await send("call-answer", {
        callId: offerSignal.callId,
        from: userId,
        to: offerSignal.from,
        answer,
      });
      pendingOfferRef.current = null;
      setIncoming(null);
    } catch {
      closePeer();
      setError("Camera or microphone permission is required for calls.");
    }
  };

  const endCall = async () => {
    const callId = callIdRef.current ?? incoming?.callId;
    if (callId) {
      await send("call-end", { callId, from: userId });
    }
    closePeer();
    onClose();
  };

  useEffect(() => {
    const channel = supabase.channel(`in-app-call:${spaceCode}`, {
      config: { broadcast: { self: false } },
    });
    channelRef.current = channel;
    channel
      .on("broadcast", { event: "call-offer" }, ({ payload }: { payload: CallSignal }) => {
        if (payload.from === userId) return;
        if (!active) {
          pendingOfferRef.current = payload;
          setIncoming(payload);
        }
      })
      .on("broadcast", { event: "call-answer" }, async ({ payload }: { payload: CallSignal }) => {
        if (payload.from === userId) return;
        if (payload.to && payload.to !== userId) return;
        if (payload.callId !== callIdRef.current || !payload.answer) return;
        peerUserIdRef.current = payload.from;
        if (peerRef.current) {
          await peerRef.current.setRemoteDescription(payload.answer);
          await processQueuedCandidates();
        }
      })
      .on("broadcast", { event: "call-ice" }, async ({ payload }: { payload: CallSignal }) => {
        if (payload.from === userId) return;
        if (payload.to && payload.to !== userId) return;
        if (payload.callId !== callIdRef.current || !payload.candidate) return;

        const peer = peerRef.current;
        if (peer && peer.remoteDescription) {
          try {
            await peer.addIceCandidate(payload.candidate);
          } catch {
            /* ignore invalid candidate */
          }
        } else {
          iceCandidatesQueueRef.current.push(payload.candidate);
        }
      })
      .on("broadcast", { event: "call-end" }, ({ payload }: { payload: CallSignal }) => {
        if (payload.from === userId) return;
        if (payload.callId === callIdRef.current || payload.callId === incoming?.callId) {
          closePeer();
          onClose();
        }
      })
      .subscribe();

    return () => {
      channel.unsubscribe();
      channelRef.current = null;
      closePeer();
    };
  }, [spaceCode, userId]);

  useEffect(() => {
    if (requestedMode) void startCall(requestedMode);
  }, [requestedMode]);

  useEffect(() => {
    if (!incoming || active) return;
    const stopRingtone = startRingtone();
    return () => stopRingtone();
  }, [incoming, active]);

  useEffect(() => {
    if (!connected) {
      setDuration(0);
      return;
    }
    const timer = setInterval(() => setDuration((d) => d + 1), 1000);
    return () => clearInterval(timer);
  }, [connected]);

  useEffect(() => {
    if (localVideoRef.current && localStreamRef.current && !sharingScreen) {
      localVideoRef.current.srcObject = localStreamRef.current;
      localVideoRef.current.play().catch(() => {});
    }
    if (remoteVideoRef.current && remoteStreamRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
      remoteVideoRef.current.play().catch(() => {});
    }
  }, [active, mode, connected, sharingScreen]);

  const toggleMute = () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  };

  const toggleCamera = () => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCameraOff(!track.enabled);
  };

  const toggleScreenShare = async () => {
    const peer = peerRef.current;
    if (!peer || !localStreamRef.current) return;
    try {
      if (!sharingScreen) {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
        const screenTrack = displayStream.getVideoTracks()[0];
        if (!screenTrack) return;
        screenTrackRef.current = screenTrack;
        const videoSender = peer.getSenders().find((s) => s.track?.kind === "video");
        if (videoSender) {
          await videoSender.replaceTrack(screenTrack);
        }
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = displayStream;
          localVideoRef.current.play().catch(() => {});
        }
        screenTrack.onended = () => {
          void stopScreenShare();
        };
        setSharingScreen(true);
      } else {
        await stopScreenShare();
      }
    } catch {
      /* user cancelled picker */
    }
  };

  const stopScreenShare = async () => {
    const peer = peerRef.current;
    const cameraTrack = localStreamRef.current?.getVideoTracks()[0];
    if (peer && cameraTrack) {
      const videoSender = peer.getSenders().find((s) => s.track?.kind === "video");
      if (videoSender) {
        await videoSender.replaceTrack(cameraTrack);
      }
    }
    if (screenTrackRef.current) {
      screenTrackRef.current.stop();
      screenTrackRef.current = null;
    }
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
      localVideoRef.current.play().catch(() => {});
    }
    setSharingScreen(false);
  };

  const formatTimer = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <>
      {incoming && !active && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-6 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 text-center shadow-2xl">
            <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-primary/15 text-primary animate-pulse">
              {incoming.mode === "voice" ? <Phone className="size-6" /> : <Video className="size-6" />}
            </div>
            <h2 className="mt-4 text-lg font-semibold">Incoming {incoming.mode ?? "video"} call</h2>
            <p className="mt-1 text-sm text-muted-foreground">Another person in this Space is calling.</p>
            <div className="mt-5 flex justify-center gap-2">
              <button
                type="button"
                onClick={() => void endCall()}
                className="rounded-xl bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground hover:opacity-90 transition-opacity"
              >
                Decline
              </button>
              <button
                type="button"
                onClick={() => void acceptCall()}
                className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
              >
                Answer
              </button>
            </div>
          </div>
        </div>
      )}
      {active && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background/95 p-3 sm:p-6">
          <header className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">{mode === "voice" ? "Voice call" : "Video call"}</p>
              <p className="text-xs text-muted-foreground font-mono">
                {connected ? `Connected • ${formatTimer(duration)}` : "Connecting..."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void endCall()}
              aria-label="Close call"
              className="rounded-full bg-card p-2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </header>
          {error && (
            <p className="mx-auto mt-4 rounded-lg bg-destructive/15 px-3 py-2 text-center text-xs text-destructive-foreground">
              {error}
            </p>
          )}
          <div className="relative mx-auto mt-4 flex min-h-0 w-full max-w-5xl flex-1 items-center justify-center overflow-hidden rounded-2xl bg-card">
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className={mode === "video" ? "h-full w-full object-contain" : "hidden"}
            />
            {mode === "voice" && (
              <div className="flex size-24 items-center justify-center rounded-full bg-primary/15 text-primary">
                <Phone className="size-10" />
              </div>
            )}
            {mode === "video" && (
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className="absolute bottom-4 right-4 z-10 h-28 w-40 rounded-xl bg-background object-cover shadow-xl sm:h-36 sm:w-52"
              />
            )}
          </div>
          <div className="mt-4 flex justify-center gap-2">
            <button
              type="button"
              onClick={toggleMute}
              aria-label={muted ? "Unmute microphone" : "Mute microphone"}
              className={
                "flex size-11 items-center justify-center rounded-full bg-card hover:text-primary transition-colors " +
                (muted ? "text-destructive" : "")
              }
            >
              {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </button>
            {mode === "video" && (
              <>
                <button
                  type="button"
                  onClick={toggleCamera}
                  aria-label={cameraOff ? "Turn camera on" : "Turn camera off"}
                  className={
                    "flex size-11 items-center justify-center rounded-full bg-card hover:text-primary transition-colors " +
                    (cameraOff ? "text-destructive" : "")
                  }
                >
                  {cameraOff ? <VideoOff className="size-4" /> : <Video className="size-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => void toggleScreenShare()}
                  aria-label={sharingScreen ? "Stop screen share" : "Share screen"}
                  className={
                    "flex size-11 items-center justify-center rounded-full bg-card hover:text-primary transition-colors " +
                    (sharingScreen ? "text-primary ring-2 ring-primary" : "")
                  }
                >
                  {sharingScreen ? <MonitorOff className="size-4" /> : <Monitor className="size-4" />}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => void endCall()}
              aria-label="End call"
              className="flex size-11 items-center justify-center rounded-full bg-destructive text-destructive-foreground hover:opacity-90 transition-opacity"
            >
              <PhoneOff className="size-4" />
            </button>
          </div>
        </div>
      )}
      {error && !active && !incoming && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-destructive px-4 py-2 text-xs text-destructive-foreground">
          {error}
        </div>
      )}
    </>
  );
}
