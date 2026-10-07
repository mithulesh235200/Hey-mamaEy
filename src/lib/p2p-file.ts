// WebRTC DataChannel Peer-to-Peer (P2P) File Transfer Engine
import { supabase } from "@/integrations/supabase/client";

// Reliable Public STUN/TURN Servers for WebRTC NAT Traversal
const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
    { urls: "stun:stun.services.mozilla.com" },
    { urls: "stun:global.stun.twilio.com:3478" },
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp",
        "turn:openrelay.metered.ca:3478",
      ],
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};

const CHUNK_SIZE = 32768; // 32 KB chunks for high WebRTC throughput

export type P2PTransferStatus =
  "idle" | "connecting" | "transferring" | "completed" | "failed" | "cancelled";

export type P2PProgressInfo = {
  transferId: string;
  status: P2PTransferStatus;
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
  speedMbps: number;
  fileName: string;
  blobUrl?: string;
  error?: string;
};

export type P2PProgressCallback = (info: P2PProgressInfo) => void;

// Active transfer sessions pool
const activeSenders = new Map<string, P2PFileSenderSession>();
const activeReceivers = new Map<string, P2PFileReceiverSession>();

/**
 * P2P File Sender Session using WebRTC DataChannel
 */
export class P2PFileSenderSession {
  public transferId: string;
  public file: File;
  public userId: string;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private channel: ReturnType<typeof supabase.channel> | null = null;
  private status: P2PTransferStatus = "idle";
  private bytesSent = 0;
  private startTime = 0;
  private listeners = new Set<P2PProgressCallback>();

  constructor(transferId: string, file: File, userId: string) {
    this.transferId = transferId;
    this.file = file;
    this.userId = userId;
  }

  public subscribe(cb: P2PProgressCallback) {
    this.listeners.add(cb);
    this.notify();
    return () => this.listeners.delete(cb);
  }

  private notify(error?: string, blobUrl?: string) {
    const elapsed = (Date.now() - (this.startTime || Date.now())) / 1000;
    const speedMbps = elapsed > 0 ? (this.bytesSent * 8) / (elapsed * 1000000) : 0;
    const pct =
      this.file.size > 0 ? Math.min(100, Math.round((this.bytesSent / this.file.size) * 100)) : 0;

    const info: P2PProgressInfo = {
      transferId: this.transferId,
      status: this.status,
      bytesTransferred: this.bytesSent,
      totalBytes: this.file.size,
      percentage: pct,
      speedMbps: Math.round(speedMbps * 10) / 10,
      fileName: this.file.name,
      ...(blobUrl !== undefined && { blobUrl }),
      ...(error !== undefined && { error }),
    };
    this.listeners.forEach((fn) => fn(info));
  }

  public async start() {
    if (this.status !== "idle") return;
    this.status = "connecting";
    this.notify();

    try {
      this.pc = new RTCPeerConnection(ICE_SERVERS);
      this.dc = this.pc.createDataChannel("file-transfer", { ordered: true });
      this.dc.binaryType = "arraybuffer";

      // Setup DataChannel events
      this.dc.onopen = () => {
        this.status = "transferring";
        this.startTime = Date.now();
        this.notify();
        void this.sendFileChunks();
      };

      this.dc.onerror = () => {
        this.status = "failed";
        this.notify("DataChannel connection error");
      };

      this.dc.onclose = () => {
        if (this.status !== "completed") {
          this.status = "cancelled";
          this.notify("Connection closed prematurely");
        }
      };

      // Handle ICE Candidates
      this.pc.onicecandidate = (event) => {
        if (event.candidate && this.channel) {
          void this.channel.send({
            type: "broadcast",
            event: "ice-candidate",
            payload: { candidate: event.candidate, from: this.userId },
          });
        }
      };

      // Supabase Signaling Channel
      this.channel = supabase.channel(`p2p-transfer-${this.transferId}`);
      this.channel
        .on("broadcast", { event: "request-offer" }, () => {
          void this.createAndSendOffer();
        })
        .on("broadcast", { event: "sdp-answer" }, (msg) => {
          const answer = msg["payload"]?.answer;
          if (answer && this.pc) {
            void this.pc.setRemoteDescription(new RTCSessionDescription(answer));
          }
        })
        .on("broadcast", { event: "ice-candidate" }, (msg) => {
          const candidate = msg["payload"]?.candidate;
          const from = msg["payload"]?.from;
          if (candidate && this.pc && from !== this.userId) {
            void this.pc.addIceCandidate(new RTCIceCandidate(candidate));
          }
        })
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            void this.createAndSendOffer();
          }
        });
    } catch (err) {
      this.status = "failed";
      this.notify(err instanceof Error ? err.message : "Failed to initialize P2P sender");
    }
  }

  private async createAndSendOffer() {
    if (!this.pc) return;
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    if (this.channel) {
      void this.channel.send({
        type: "broadcast",
        event: "sdp-offer",
        payload: {
          offer,
          from: this.userId,
          fileName: this.file.name,
          fileSize: this.file.size,
          mimeType: this.file.type,
        },
      });
    }
  }

  private async sendFileChunks() {
    if (!this.dc || this.dc.readyState !== "open") return;

    // Send Header JSON
    const header = JSON.stringify({
      type: "HEADER",
      fileName: this.file.name,
      fileSize: this.file.size,
      mimeType: this.file.type,
      totalChunks: Math.ceil(this.file.size / CHUNK_SIZE),
    });
    this.dc.send(header);

    const reader = new FileReader();
    let offset = 0;

    const readNextChunk = () => {
      if (offset >= this.file.size) {
        if (this.dc && this.dc.readyState === "open") {
          this.dc.send(JSON.stringify({ type: "EOF" }));
        }
        this.status = "completed";
        this.notify();
        return;
      }
      const slice = this.file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    reader.onload = (e) => {
      if (!this.dc || this.dc.readyState !== "open") return;
      const buffer = e.target?.result as ArrayBuffer;
      if (buffer) {
        // Handle bufferedAmount low backpressure
        if (this.dc.bufferedAmount > 8 * 1024 * 1024) {
          setTimeout(() => {
            if (this.dc && this.dc.readyState === "open") {
              this.dc.send(buffer);
              this.bytesSent += buffer.byteLength;
              offset += buffer.byteLength;
              this.notify();
              readNextChunk();
            }
          }, 100);
          return;
        }

        this.dc.send(buffer);
        this.bytesSent += buffer.byteLength;
        offset += buffer.byteLength;
        this.notify();
        readNextChunk();
      }
    };

    readNextChunk();
  }

  public cancel() {
    this.status = "cancelled";
    this.notify("Cancelled by sender");
    this.cleanup();
  }

  private cleanup() {
    if (this.dc) {
      this.dc.close();
      this.dc = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.channel) {
      void this.channel.unsubscribe();
      this.channel = null;
    }
    activeSenders.delete(this.transferId);
  }
}

/**
 * P2P File Receiver Session using WebRTC DataChannel
 */
export class P2PFileReceiverSession {
  public transferId: string;
  public userId: string;
  private pc: RTCPeerConnection | null = null;
  private channel: ReturnType<typeof supabase.channel> | null = null;
  private status: P2PTransferStatus = "idle";
  private receivedChunks: ArrayBuffer[] = [];
  private bytesReceived = 0;
  private totalBytes = 0;
  private fileName = "";
  private mimeType = "";
  private startTime = 0;
  private listeners = new Set<P2PProgressCallback>();

  constructor(transferId: string, userId: string) {
    this.transferId = transferId;
    this.userId = userId;
  }

  public subscribe(cb: P2PProgressCallback) {
    this.listeners.add(cb);
    this.notify();
    return () => this.listeners.delete(cb);
  }

  private notify(error?: string, blobUrl?: string) {
    const elapsed = (Date.now() - (this.startTime || Date.now())) / 1000;
    const speedMbps = elapsed > 0 ? (this.bytesReceived * 8) / (elapsed * 1000000) : 0;
    const pct =
      this.totalBytes > 0
        ? Math.min(100, Math.round((this.bytesReceived / this.totalBytes) * 100))
        : 0;

    const info: P2PProgressInfo = {
      transferId: this.transferId,
      status: this.status,
      bytesTransferred: this.bytesReceived,
      totalBytes: this.totalBytes,
      percentage: pct,
      speedMbps: Math.round(speedMbps * 10) / 10,
      fileName: this.fileName || "P2P_File",
      ...(blobUrl !== undefined && { blobUrl }),
      ...(error !== undefined && { error }),
    };
    this.listeners.forEach((fn) => fn(info));
  }

  public async start() {
    if (this.status !== "idle") return;
    this.status = "connecting";
    this.notify();

    try {
      this.pc = new RTCPeerConnection(ICE_SERVERS);

      this.pc.ondatachannel = (event) => {
        const dc = event.channel;
        dc.binaryType = "arraybuffer";

        dc.onopen = () => {
          this.status = "transferring";
          this.startTime = Date.now();
          this.notify();
        };

        dc.onmessage = (e) => {
          if (typeof e.data === "string") {
            try {
              const meta = JSON.parse(e.data);
              if (meta.type === "HEADER") {
                this.fileName = meta.fileName;
                this.totalBytes = meta.fileSize;
                this.mimeType = meta.mimeType;
                this.notify();
              } else if (meta.type === "EOF") {
                this.finishTransfer();
              }
            } catch {
              /* text payload */
            }
          } else if (e.data instanceof ArrayBuffer) {
            this.receivedChunks.push(e.data);
            this.bytesReceived += e.data.byteLength;
            this.notify();
          }
        };

        dc.onerror = () => {
          this.status = "failed";
          this.notify("DataChannel error during file receive");
        };
      };

      this.pc.onicecandidate = (event) => {
        if (event.candidate && this.channel) {
          void this.channel.send({
            type: "broadcast",
            event: "ice-candidate",
            payload: { candidate: event.candidate, from: this.userId },
          });
        }
      };

      // Supabase Signaling Channel
      this.channel = supabase.channel(`p2p-transfer-${this.transferId}`);
      this.channel
        .on("broadcast", { event: "sdp-offer" }, async (msg) => {
          const payload = msg["payload"];
          const offer = payload?.offer;
          if (offer && this.pc) {
            if (payload?.fileName) this.fileName = payload.fileName;
            if (payload?.fileSize) this.totalBytes = payload.fileSize;
            if (payload?.mimeType) this.mimeType = payload.mimeType;

            await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);

            if (this.channel) {
              void this.channel.send({
                type: "broadcast",
                event: "sdp-answer",
                payload: { answer, from: this.userId },
              });
            }
          }
        })
        .on("broadcast", { event: "ice-candidate" }, (msg) => {
          const payload = msg["payload"];
          const candidate = payload?.candidate;
          const from = payload?.from;
          if (candidate && this.pc && from !== this.userId) {
            void this.pc.addIceCandidate(new RTCIceCandidate(candidate));
          }
        })
        .subscribe((status) => {
          if (status === "SUBSCRIBED" && this.channel) {
            void this.channel.send({
              type: "broadcast",
              event: "request-offer",
              payload: { from: this.userId },
            });
          }
        });
    } catch (err) {
      this.status = "failed";
      this.notify(err instanceof Error ? err.message : "Failed to initialize P2P receiver");
    }
  }

  private finishTransfer() {
    try {
      const blob = new Blob(this.receivedChunks, {
        type: this.mimeType || "application/octet-stream",
      });
      const blobUrl = URL.createObjectURL(blob);
      this.status = "completed";
      this.notify(undefined, blobUrl);
    } catch (err) {
      this.status = "failed";
      this.notify(err instanceof Error ? err.message : "Failed to assemble file");
    }
  }

  public cancel() {
    this.status = "cancelled";
    this.notify("Cancelled by receiver");
    this.cleanup();
  }

  private cleanup() {
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.channel) {
      void this.channel.unsubscribe();
      this.channel = null;
    }
    activeReceivers.delete(this.transferId);
  }
}

// Global Manager Functions
export function createP2PSender(
  transferId: string,
  file: File,
  userId: string,
): P2PFileSenderSession {
  const existing = activeSenders.get(transferId);
  if (existing) return existing;

  const sender = new P2PFileSenderSession(transferId, file, userId);
  activeSenders.set(transferId, sender);
  return sender;
}

export function createP2PReceiver(transferId: string, userId: string): P2PFileReceiverSession {
  const existing = activeReceivers.get(transferId);
  if (existing) return existing;

  const receiver = new P2PFileReceiverSession(transferId, userId);
  activeReceivers.set(transferId, receiver);
  return receiver;
}

export function getActiveP2PSender(transferId: string): P2PFileSenderSession | undefined {
  return activeSenders.get(transferId);
}

export function getActiveP2PReceiver(transferId: string): P2PFileReceiverSession | undefined {
  return activeReceivers.get(transferId);
}
