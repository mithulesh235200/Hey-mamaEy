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
    // TURN Relay Fallbacks for mobile NAT & restrictive firewalls
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp",
      ],
      username: "openrelay",
      credential: "openrelay",
    },
  ],
  iceTransportPolicy: "all",
  iceCandidatePoolSize: 10,
};

function startRingtone(): () => void {
  if (typeof window === "undefined") return () => {};
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return () => {};
    const ctx = new AudioContextClass();
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }
    let playing = true;

    const chime = () => {
      if (!playing || ctx.state === "closed") return;
      try {
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
      } catch {
        /* ignore audio play error */
      }
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
  const offerRetryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localOfferRef = useRef<RTCSessionDescriptionInit | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
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

  const clearTimers = () => {
    if (offerRetryTimerRef.current) {
      clearInterval(offerRetryTimerRef.current);
      offerRetryTimerRef.current = null;
    }
    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
  };

  const send = async (event: string, payload: CallSignal) => {
    await channelRef.current?.send({ type: "broadcast", event, payload });
  };

  const closePeer = () => {
    clearTimers();
    if (screenTrackRef.current) {
      screenTrackRef.current.stop();
      screenTrackRef.current = null;
    }
    peerRef.current?.close();
    peerRef.current = null;

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    remoteStreamRef.current = null;
    iceCandidatesQueueRef.current = [];
    localOfferRef.current = null;

    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;

    setConnected(false);
    setActive(false);
    setSharingScreen(false);
    setMuted(false);
    setCameraOff(false);
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
        if (candidate && candidate.candidate) {
          await peer.addIceCandidate(candidate);
        }
      } catch {
        /* ignore invalid candidate */
      }
    }
  };

  const attachRemoteStream = (stream: MediaStream) => {
    remoteStreamRef.current = stream;
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = stream;
      remoteAudioRef.current.play().catch(() => {});
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = stream;
      remoteVideoRef.current.play().catch(() => {});
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
      attachRemoteStream(remoteStream);
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
      const state = peer.connectionState;
      if (state === "connected") {
        setConnected(true);
        if (disconnectTimerRef.current) {
          clearTimeout(disconnectTimerRef.current);
          disconnectTimerRef.current = null;
        }
        if (connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }
      } else if (state === "disconnected") {
        if (!disconnectTimerRef.current) {
          disconnectTimerRef.current = setTimeout(() => {
            if (peer.connectionState !== "connected") {
              closePeer();
              setError("Call disconnected due to network failure.");
            }
          }, 15000);
        }
      } else if (state === "failed") {
        try {
          if (typeof peer.restartIce === "function") {
            peer.restartIce();
          }
        } catch {
          /* ignore restart error */
        }
        if (!disconnectTimerRef.current) {
          disconnectTimerRef.current = setTimeout(() => {
            if (peer.connectionState !== "connected") {
              closePeer();
              setError("Connection failed. Please check network and try again.");
            }
          }, 12000);
        }
      } else if (state === "closed") {
        closePeer();
      }
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
      localOfferRef.current = offer;

      const payload: CallSignal = { callId, from: userId, mode: callMode, offer };
      await send("call-offer", payload);

      let attempts = 0;
      offerRetryTimerRef.current = setInterval(() => {
        attempts++;
        if (peerRef.current?.connectionState === "connected" || attempts > 12) {
          if (offerRetryTimerRef.current) {
            clearInterval(offerRetryTimerRef.current);
            offerRetryTimerRef.current = null;
          }
          return;
        }
        void send("call-offer", payload);
      }, 2500);

      connectionTimeoutRef.current = setTimeout(() => {
        if (peerRef.current?.connectionState !== "connected") {
          closePeer();
          setError("Connection timed out. Receiver did not answer or network blocked.");
        }
      }, 35000);
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

      const answerPayload: CallSignal = {
        callId: offerSignal.callId,
        from: userId,
        to: offerSignal.from,
        answer,
      };
      await send("call-answer", answerPayload);

      setTimeout(() => {
        if (peerRef.current?.connectionState !== "connected") {
          void send("call-answer", answerPayload);
        }
      }, 1500);

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
      .on("broadcast", { event: "call-offer" }, async ({ payload }: { payload: CallSignal }) => {
        if (payload.from === userId) return;

        if (active && payload.callId === callIdRef.current && peerRef.current?.localDescription) {
          await send("call-answer", {
            callId: payload.callId,
            from: userId,
            to: payload.from,
            answer: peerRef.current.localDescription,
          });
          return;
        }

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
        if (peerRef.current && peerRef.current.signalingState !== "stable") {
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
    if (remoteStreamRef.current) {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStreamRef.current;
        remoteVideoRef.current.play().catch(() => {});
      }
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStreamRef.current;
        remoteAudioRef.current.play().catch(() => {});
      }
    }
    if (localVideoRef.current && localStreamRef.current && !sharingScreen) {
      localVideoRef.current.srcObject = localStreamRef.current;
      localVideoRef.current.play().catch(() => {});
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
      /* user cancelled screen share picker */
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
      {/* Invisible dedicated audio element to guarantee voice output on mobile & desktop browsers */}
      <audio ref={remoteAudioRef} autoPlay playsInline hidden />

      {incoming && !active && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-6 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 text-center shadow-2xl">
            <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-primary/15 text-primary animate-pulse">
              {incoming.mode === "voice" ? <Phone className="size-7" /> : <Video className="size-7" />}
            </div>
            <h2 className="mt-4 text-lg font-semibold text-foreground">
              Incoming {incoming.mode ?? "video"} call
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Someone in this Space is calling you.</p>
            <div className="mt-6 flex justify-center gap-3">
              <button
                type="button"
                onClick={() => void endCall()}
                className="flex-1 rounded-xl bg-destructive px-4 py-2.5 text-sm font-semibold text-destructive-foreground hover:opacity-90 transition-opacity"
              >
                Decline
              </button>
              <button
                type="button"
                onClick={() => void acceptCall()}
                className="flex-1 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
              >
                Answer
              </button>
            </div>
          </div>
        </div>
      )}

      {active && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background/95 p-3 sm:p-6 animate-in fade-in duration-200">
          <header className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-foreground">
                {mode === "voice" ? "Voice Call" : "Video Call"}
              </p>
              <p className="text-xs text-muted-foreground font-mono">
                {connected ? `Connected • ${formatTimer(duration)}` : "Ringing / Connecting..."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void endCall()}
              aria-label="Close call"
              className="rounded-full bg-card p-2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="size-5" />
            </button>
          </header>

          {error && (
            <p className="mx-auto mt-3 rounded-lg bg-destructive/15 px-4 py-2 text-center text-xs text-destructive-foreground">
              {error}
            </p>
          )}

          <div className="relative mx-auto mt-4 flex min-h-0 w-full max-w-5xl flex-1 items-center justify-center overflow-hidden rounded-2xl bg-card border border-border shadow-2xl">
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className={mode === "video" ? "h-full w-full object-contain" : "hidden"}
            />
            {mode === "voice" && (
              <div className="flex flex-col items-center gap-4">
                <div className="flex size-28 items-center justify-center rounded-full bg-primary/15 text-primary animate-pulse">
                  <Phone className="size-12" />
                </div>
                <p className="text-xs font-mono text-muted-foreground">
                  {connected ? "Voice Active" : "Calling..."}
                </p>
              </div>
            )}
            {mode === "video" && (
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className="absolute bottom-4 right-4 z-10 h-28 w-40 rounded-xl bg-background object-cover shadow-2xl border border-border sm:h-36 sm:w-52"
              />
            )}
          </div>

          <div className="mt-4 flex justify-center gap-3">
            <button
              type="button"
              onClick={toggleMute}
              aria-label={muted ? "Unmute microphone" : "Mute microphone"}
              className={
                "flex size-12 items-center justify-center rounded-full bg-card hover:text-primary transition-colors border border-border " +
                (muted ? "text-destructive border-destructive/50" : "text-foreground")
              }
            >
              {muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
            </button>

            {mode === "video" && (
              <>
                <button
                  type="button"
                  onClick={toggleCamera}
                  aria-label={cameraOff ? "Turn camera on" : "Turn camera off"}
                  className={
                    "flex size-12 items-center justify-center rounded-full bg-card hover:text-primary transition-colors border border-border " +
                    (cameraOff ? "text-destructive border-destructive/50" : "text-foreground")
                  }
                >
                  {cameraOff ? <VideoOff className="size-5" /> : <Video className="size-5" />}
                </button>
                <button
                  type="button"
                  onClick={() => void toggleScreenShare()}
                  aria-label={sharingScreen ? "Stop screen share" : "Share screen"}
                  className={
                    "flex size-12 items-center justify-center rounded-full bg-card hover:text-primary transition-colors border border-border " +
                    (sharingScreen ? "text-primary ring-2 ring-primary border-primary" : "text-foreground")
                  }
                >
                  {sharingScreen ? <MonitorOff className="size-5" /> : <Monitor className="size-5" />}
                </button>
              </>
            )}

            <button
              type="button"
              onClick={() => void endCall()}
              aria-label="End call"
              className="flex size-12 items-center justify-center rounded-full bg-destructive text-destructive-foreground hover:opacity-90 transition-opacity shadow-lg"
            >
              <PhoneOff className="size-5" />
            </button>
          </div>
        </div>
      )}

      {error && !active && !incoming && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-destructive px-5 py-2.5 text-xs font-semibold text-destructive-foreground shadow-2xl animate-in fade-in duration-200">
          {error}
        </div>
      )}
    </>
  );
}
