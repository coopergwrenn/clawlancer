"use client";

import { useState, useRef, useCallback } from "react";
import { Circle, Square, Download, Share2 } from "lucide-react";

interface ClipRecorderProps {
  /** The container element that holds the noVNC canvas */
  targetRef: React.RefObject<HTMLDivElement | null>;
}

type RecordingState = "idle" | "recording" | "done";

const CLIP_DURATION = 15; // seconds
const SHARE_TEXT = "Watch my @instaclaws agent work autonomously 🤖";

export function ClipRecorder({ targetRef }: ClipRecorderProps) {
  const [state, setState] = useState<RecordingState>("idle");
  const [countdown, setCountdown] = useState(CLIP_DURATION);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const startRecording = useCallback(() => {
    const container = targetRef.current;
    if (!container) return;

    // Find the canvas inside the VNC viewer
    const canvas = container.querySelector("canvas") as HTMLCanvasElement | null;
    if (!canvas) return;

    try {
      const stream = canvas.captureStream(10); // 10 fps
      const recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
          ? "video/webm;codecs=vp9"
          : "video/webm",
      });

      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        setBlobUrl(url);
        setState("done");
      };

      recorder.start(1000); // Collect data every second
      recorderRef.current = recorder;
      setState("recording");
      setCountdown(CLIP_DURATION);

      // Countdown timer
      let remaining = CLIP_DURATION;
      timerRef.current = setInterval(() => {
        remaining--;
        setCountdown(remaining);
        if (remaining <= 0) {
          stopRecording();
        }
      }, 1000);
    } catch (err) {
      console.error("Recording failed:", err);
    }
  }, [targetRef]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === "recording") {
      recorderRef.current.stop();
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const downloadClip = () => {
    if (!blobUrl) return;
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = `instaclaw-agent-${Date.now()}.webm`;
    a.click();
  };

  const shareToTwitter = () => {
    const url = encodeURIComponent("https://instaclaw.io");
    const text = encodeURIComponent(SHARE_TEXT);
    window.open(`https://twitter.com/intent/tweet?text=${text}&url=${url}`, "_blank");
  };

  const reset = () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    setBlobUrl(null);
    setState("idle");
    setCountdown(CLIP_DURATION);
  };

  if (state === "idle") {
    return (
      <button
        onClick={startRecording}
        className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium text-[var(--muted)] hover:text-red-500 hover:bg-red-50 border border-[var(--border)] transition-colors"
        title="Record 15s clip"
      >
        <Circle className="w-3 h-3" fill="currentColor" />
        Record
      </button>
    );
  }

  if (state === "recording") {
    return (
      <button
        onClick={stopRecording}
        className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium text-red-500 bg-red-50 border border-red-200 animate-pulse transition-colors"
      >
        <Square className="w-3 h-3" fill="currentColor" />
        {countdown}s
      </button>
    );
  }

  // state === "done"
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={downloadClip}
        className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium text-[var(--foreground)] hover:bg-black/5 border border-[var(--border)] transition-colors"
        title="Download clip"
      >
        <Download className="w-3 h-3" />
        Save
      </button>
      <button
        onClick={shareToTwitter}
        className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium text-[#1DA1F2] hover:bg-blue-50 border border-blue-200 transition-colors"
        title="Share to X"
      >
        <Share2 className="w-3 h-3" />
        Share
      </button>
      <button
        onClick={reset}
        className="px-2 py-1 rounded-full text-[10px] text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
      >
        ✕
      </button>
    </div>
  );
}
