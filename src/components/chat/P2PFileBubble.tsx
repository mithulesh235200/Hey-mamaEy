import { useEffect, useState } from "react";
import { Download, FileIcon, HardDrive, ShieldCheck, Zap } from "lucide-react";
import { Message } from "@/lib/heymama";
import {
  createP2PReceiver,
  createP2PSender,
  getActiveP2PReceiver,
  getActiveP2PSender,
  P2PProgressInfo,
} from "@/lib/p2p-file";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function P2PFileBubble({
  message,
  currentUserId,
}: {
  message: Message;
  currentUserId: string;
}) {
  const isSender = message.authorId === currentUserId;
  const transferId = message.p2pTransferId || message.id;
  const fileName = message.p2pFileName || message.fileName || "P2P_File";
  const fileSize = message.p2pFileSize || message.fileSize || 0;

  const [progress, setProgress] = useState<P2PProgressInfo>({
    transferId,
    status: "idle",
    bytesTransferred: 0,
    totalBytes: fileSize,
    percentage: 0,
    speedMbps: 0,
    fileName,
  });

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    if (isSender) {
      const active = getActiveP2PSender(transferId);
      if (active) {
        unsubscribe = active.subscribe(setProgress);
      }
    } else {
      const active = getActiveP2PReceiver(transferId);
      if (active) {
        unsubscribe = active.subscribe(setProgress);
      }
    }

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [transferId, isSender]);

  const handleStartReceive = () => {
    const receiver = createP2PReceiver(transferId, currentUserId);
    receiver.subscribe(setProgress);
    void receiver.start();
  };

  const handleDownload = () => {
    if (!progress.blobUrl) return;
    const a = document.createElement("a");
    a.href = progress.blobUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="my-1.5 w-full max-w-sm rounded-2xl border border-emerald-500/30 bg-card/95 p-3.5 shadow-lg backdrop-blur-md transition-all">
      {/* Header Badge */}
      <div className="mb-2.5 flex items-center justify-between border-b border-emerald-500/20 pb-2">
        <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-400">
          <Zap className="h-4 w-4 animate-pulse fill-emerald-400" />
          <span>WebRTC P2P Direct</span>
        </div>
        <div className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
          <ShieldCheck className="h-3 w-3" />
          <span>Zero Server Storage</span>
        </div>
      </div>

      {/* File Info */}
      <div className="mb-3 flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
          <FileIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-foreground" title={fileName}>
            {fileName}
          </p>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>{formatBytes(fileSize)}</span>
            <span>•</span>
            <span className="flex items-center gap-1">
              <HardDrive className="h-3 w-3" />
              {isSender ? "Sender (You)" : `From ${message.authorName}`}
            </span>
          </div>
        </div>
      </div>

      {/* Progress Bar & Status */}
      {(progress.status === "transferring" || progress.status === "connecting") && (
        <div className="mb-3 space-y-1.5">
          <div className="flex items-center justify-between text-[11px] font-medium text-foreground">
            <span>
              {progress.status === "connecting"
                ? "Establishing WebRTC Peer Stream..."
                : `Streaming: ${progress.percentage}%`}
            </span>
            {progress.speedMbps > 0 && (
              <span className="font-mono text-emerald-400">{progress.speedMbps} MB/s</span>
            )}
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-emerald-950/40 p-0.5 border border-emerald-500/30">
            <div
              className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-300 shadow-sm shadow-emerald-500/50"
              style={{ width: `${progress.percentage}%` }}
            />
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="mt-2 flex items-center justify-end">
        {!isSender && progress.status === "idle" && (
          <button
            onClick={handleStartReceive}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-3.5 py-2 text-xs font-bold text-white shadow-md hover:from-emerald-500 hover:to-teal-500 transition-all active:scale-[0.98]"
          >
            <Download className="h-4 w-4" />
            <span>Accept & Stream P2P File</span>
          </button>
        )}

        {!isSender && progress.status === "completed" && progress.blobUrl && (
          <button
            onClick={handleDownload}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-3.5 py-2 text-xs font-bold text-emerald-950 shadow-md hover:bg-emerald-400 transition-all active:scale-[0.98]"
          >
            <Download className="h-4 w-4" />
            <span>Save P2P File to Device</span>
          </button>
        )}

        {isSender && progress.status === "completed" && (
          <div className="w-full text-center text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 rounded-xl py-1.5 border border-emerald-500/20">
            ✓ File Streamed Direct to Peer
          </div>
        )}

        {progress.status === "failed" && (
          <div className="w-full text-center text-[11px] font-semibold text-rose-400 bg-rose-500/10 rounded-xl py-1.5 border border-rose-500/20">
            ⚠ Transfer Failed / Peer Disconnected
          </div>
        )}
      </div>
    </div>
  );
}
