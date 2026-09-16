import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

type CallMode = "voice" | "video";
type CallSignal = {
  callId: string;
  from: string;
  to?: string;
  mode?: CallMode;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

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
  const callIdRef = useRef<string | null>(null);
  const pendingOfferRef = useRef<CallSignal | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(false);
  const [mode, setMode] = useState<CallMode>("video");
  const [incoming, setIncoming] = useState<CallSignal | null>(null);
  const [connected, setConnected] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [error, setError] = useState("");

  const send = async (event: string, payload: CallSignal) => {
    await channelRef.current?.send({ type: "broadcast", event, payload });
  };

  const closePeer = () => {
    peerRef.current?.close();
    peerRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setConnected(false);
    setActive(false);
    setIncoming(null);
    callIdRef.current = null;
    pendingOfferRef.current = null;
  };

  const createPeer = async (callId: string, callMode: CallMode) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callMode === "video",
    });
    const peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));
    peer.ontrack = (event) => {
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = event.streams[0];
    };
    peer.onicecandidate = (event) => {
      if (event.candidate) {
        void send("call-ice", {
          callId,
          from: userId,
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
    if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    callIdRef.current = callId;
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
    const offer = pendingOfferRef.current;
    if (!offer?.offer) return;
    setError("");
    try {
      const callMode = offer.mode ?? "video";
      const peer = await createPeer(offer.callId, callMode);
      await peer.setRemoteDescription(offer.offer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await send("call-answer", {
        callId: offer.callId,
        from: userId,
        to: offer.from,
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
    const channel = supabase.channel(`in-app-call:${spaceCode}`);
    channelRef.current = channel;
    channel
      .on("broadcast", { event: "call-offer" }, ({ payload }: { payload: CallSignal }) => {
        if (payload.from !== userId && !active) {
          pendingOfferRef.current = payload;
          setIncoming(payload);
        }
      })
      .on("broadcast", { event: "call-answer" }, async ({ payload }: { payload: CallSignal }) => {
        if (payload.to !== userId || payload.callId !== callIdRef.current || !payload.answer) return;
        await peerRef.current?.setRemoteDescription(payload.answer);
      })
      .on("broadcast", { event: "call-ice" }, async ({ payload }: { payload: CallSignal }) => {
        if (payload.to && payload.to !== userId) return;
        if (payload.callId !== callIdRef.current || !payload.candidate) return;
        await peerRef.current?.addIceCandidate(payload.candidate);
      })
      .on("broadcast", { event: "call-end" }, ({ payload }: { payload: CallSignal }) => {
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
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  }, [active, mode]);

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

  return (
    <>
      {incoming && !active && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-6 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 text-center shadow-2xl">
            <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-primary/15 text-primary">
              {incoming.mode === "voice" ? <Phone className="size-6" /> : <Video className="size-6" />}
            </div>
            <h2 className="mt-4 text-lg font-semibold">Incoming {incoming.mode ?? "video"} call</h2>
            <p className="mt-1 text-sm text-muted-foreground">Another person in this Space is calling.</p>
            <div className="mt-5 flex justify-center gap-2">
              <button type="button" onClick={() => void endCall()} className="rounded-xl bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground">
                Decline
              </button>
              <button type="button" onClick={() => void acceptCall()} className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
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
              <p className="text-xs text-muted-foreground">{connected ? "Connected" : "Connecting..."}</p>
            </div>
            <button type="button" onClick={() => void endCall()} aria-label="Close call" className="rounded-full bg-card p-2 text-muted-foreground hover:text-foreground">
              <X className="size-4" />
            </button>
          </header>
          {error && <p className="mx-auto mt-4 rounded-lg bg-destructive/15 px-3 py-2 text-center text-xs text-destructive-foreground">{error}</p>}
          <div className="relative mx-auto mt-4 flex min-h-0 w-full max-w-5xl flex-1 items-center justify-center overflow-hidden rounded-2xl bg-card">
            <video ref={remoteVideoRef} autoPlay playsInline className={mode === "video" ? "h-full w-full object-contain" : "hidden"} />
            {mode === "voice" && <div className="flex size-24 items-center justify-center rounded-full bg-primary/15 text-primary"><Phone className="size-10" /></div>}
            {mode === "video" && <video ref={localVideoRef} autoPlay muted playsInline className="absolute bottom-4 right-4 z-10 h-28 w-40 rounded-xl bg-background object-cover shadow-xl sm:h-36 sm:w-52" />}
          </div>
          <div className="mt-4 flex justify-center gap-2">
            <button type="button" onClick={toggleMute} aria-label={muted ? "Unmute microphone" : "Mute microphone"} className="flex size-11 items-center justify-center rounded-full bg-card hover:text-primary">
              {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </button>
            {mode === "video" && <button type="button" onClick={toggleCamera} aria-label={cameraOff ? "Turn camera on" : "Turn camera off"} className="flex size-11 items-center justify-center rounded-full bg-card hover:text-primary">
              {cameraOff ? <VideoOff className="size-4" /> : <Video className="size-4" />}
            </button>}
            <button type="button" onClick={() => void endCall()} aria-label="End call" className="flex size-11 items-center justify-center rounded-full bg-destructive text-destructive-foreground">
              <PhoneOff className="size-4" />
            </button>
          </div>
        </div>
      )}
      {error && !active && !incoming && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-destructive px-4 py-2 text-xs text-destructive-foreground">{error}</div>}
    </>
  );
}
