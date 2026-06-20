"use client";

import Link from "next/link";
import { usePosePipeline } from "@/hooks/usePosePipeline";

const MOVE_DISPLAY: Record<string, string> = {
  idle:                      "Idle",
  jab:                       "Jab",
  cross:                     "Cross",
  lead_hook:                 "Lead Hook",
  rear_hook:                 "Rear Hook",
  uppercut:                  "Uppercut",
  jumping_cross:             "Jumping Cross",
  rear_low_kick:             "Rear Low Kick",
  side_kick:                 "Side Kick",
  spinning_back_high_kick:   "Spinning BHK",
  crouching_low_sweep:       "Crouching Sweep",
  grab:                      "Grab",
  hadouken:                  "Hadouken",
  shoryuken:                 "Shoryuken",
};

export default function GamePage() {
  const { videoRef, canvasRef, status, prediction, errorMsg, start } =
    usePosePipeline();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-black p-4">
      <Link
        href="/"
        className="self-start text-xs uppercase tracking-widest text-zinc-600 hover:text-zinc-400"
      >
        ← Back
      </Link>

      {/* Hidden video — we render to canvas */}
      <video ref={videoRef} className="hidden" playsInline muted />

      {/* Main viewport */}
      <div className="relative w-full max-w-2xl">
        {/* Webcam + skeleton canvas — CSS mirror so it feels like a mirror */}
        <canvas
          ref={canvasRef}
          className="w-full rounded bg-zinc-900"
          style={{
            display: status === "ready" ? "block" : "none",
            transform: "scaleX(-1)",
          }}
        />

        {/* Idle: show start button */}
        {status === "idle" && (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-6 rounded bg-zinc-900">
            <p className="text-xs uppercase tracking-widest text-zinc-500">
              Camera + AI pipeline
            </p>
            <button
              onClick={start}
              className="border-2 border-red-500 px-10 py-4 text-base font-black uppercase tracking-widest text-red-500 hover:bg-red-500 hover:text-black transition-colors"
            >
              Start Camera
            </button>
            <p className="max-w-xs text-center text-xs text-zinc-700">
              Stand 6–8 feet back so your full body is visible
            </p>
          </div>
        )}

        {/* Loading */}
        {status === "loading" && (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-4 rounded bg-zinc-900">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-red-500" />
            <p className="text-xs uppercase tracking-widest text-zinc-500">
              Loading AI models…
            </p>
            <p className="text-xs text-zinc-700">
              MediaPipe + ONNX LSTM (~10 MB, first load only)
            </p>
          </div>
        )}

        {/* Error */}
        {status === "error" && (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded bg-zinc-900">
            <p className="text-xs uppercase tracking-widest text-red-500">Error</p>
            <p className="max-w-xs text-center text-xs text-zinc-400">{errorMsg}</p>
            <button
              onClick={start}
              className="mt-2 text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-300"
            >
              Retry
            </button>
          </div>
        )}

        {/* Live prediction overlay */}
        {status === "ready" && prediction && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
            <div className="rounded bg-black/75 px-6 py-3 text-center backdrop-blur-sm min-w-48">
              <p
                className={`text-2xl font-black uppercase tracking-wider ${
                  prediction.label === "idle" ? "text-zinc-600" : "text-red-400"
                }`}
              >
                {MOVE_DISPLAY[prediction.label] ?? prediction.label}
              </p>
              <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-red-500 transition-all duration-75"
                  style={{ width: `${prediction.confidence * 100}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-zinc-600">
                {(prediction.confidence * 100).toFixed(0)}% confidence
                {prediction.direction && (
                  <span className="ml-2 text-zinc-500">
                    · moving {prediction.direction}
                  </span>
                )}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Status line */}
      {status === "ready" && (
        <p className="text-xs text-zinc-700">
          MediaPipe Pose + LSTM running in your browser · no data leaves your device
        </p>
      )}
    </main>
  );
}
