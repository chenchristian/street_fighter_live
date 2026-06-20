"use client";

import { useState } from "react";
import Link from "next/link";
import { usePosePipeline } from "@/hooks/usePosePipeline";

const MOVE_DISPLAY: Record<string, string> = {
  idle:                    "Idle",
  jab:                     "Jab",
  cross:                   "Cross",
  lead_hook:               "Lead Hook",
  rear_hook:               "Rear Hook",
  uppercut:                "Uppercut",
  jumping_cross:           "Jumping Cross",
  rear_low_kick:           "Rear Low Kick",
  side_kick:               "Side Kick",
  spinning_back_high_kick: "Spinning BHK",
  crouching_low_sweep:     "Crouching Sweep",
  grab:                    "Grab",
  hadouken:                "Hadouken",
  shoryuken:               "Shoryuken",
};

function Histogram({
  labels,
  allProbs,
  activeLabel,
}: {
  labels: string[];
  allProbs: number[];
  activeLabel: string;
}) {
  // Sort by probability descending so highest is always on top
  const sorted = labels
    .map((label, i) => ({ label, prob: allProbs[i] ?? 0 }))
    .sort((a, b) => b.prob - a.prob);

  return (
    <div className="flex h-full flex-col gap-1 overflow-hidden p-3">
      <p className="mb-1 text-[10px] uppercase tracking-widest text-zinc-600">
        Model Output
      </p>
      {sorted.map(({ label, prob }) => {
        const isActive = label === activeLabel && activeLabel !== "idle";
        const pct = (prob * 100).toFixed(1);
        return (
          <div key={label} className="flex items-center gap-2 min-w-0">
            <span
              className={`w-24 shrink-0 text-right text-[10px] uppercase tracking-wide ${
                isActive ? "text-red-400" : "text-zinc-600"
              }`}
            >
              {MOVE_DISPLAY[label] ?? label}
            </span>
            <div className="relative h-3 flex-1 overflow-hidden rounded-sm bg-zinc-900">
              <div
                className={`h-full rounded-sm transition-all duration-75 ${
                  isActive ? "bg-red-500" : "bg-zinc-700"
                }`}
                style={{ width: `${prob * 100}%` }}
              />
            </div>
            <span
              className={`w-8 shrink-0 text-right text-[10px] tabular-nums ${
                isActive ? "text-red-400" : "text-zinc-700"
              }`}
            >
              {pct}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function GamePage() {
  const { videoRef, canvasRef, status, prediction, labels, errorMsg, start } =
    usePosePipeline();
  const [showHistogram, setShowHistogram] = useState(true);

  const isReady = status === "ready";

  return (
    <main className="flex h-screen flex-col bg-black overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-zinc-900 px-4 py-2 shrink-0">
        <Link
          href="/"
          className="text-xs uppercase tracking-widest text-zinc-600 hover:text-zinc-400"
        >
          ← Back
        </Link>
        <span className="text-xs uppercase tracking-widest text-zinc-700">
          Street Fighter Live
        </span>
        <button
          onClick={() => setShowHistogram(v => !v)}
          className={`text-xs uppercase tracking-widest transition-colors ${
            showHistogram
              ? "text-red-500 hover:text-red-400"
              : "text-zinc-600 hover:text-zinc-400"
          }`}
        >
          {showHistogram ? "Hide Predictions" : "Show Predictions"}
        </button>
      </div>

      {/* Hidden video element */}
      <video ref={videoRef} className="hidden" playsInline muted />

      {/* Main layout */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left: Webcam + Histogram ── */}
        <div className="flex w-1/2 flex-col">

          {/* Webcam — expands to fill when histogram hidden */}
          <div className={`relative overflow-hidden bg-zinc-950 ${showHistogram ? "h-1/2" : "h-full"} border-b border-zinc-900`}>

            {/* Canvas */}
            <canvas
              ref={canvasRef}
              className="h-full w-full object-cover"
              style={{
                display: isReady ? "block" : "none",
                transform: "scaleX(-1)",
              }}
            />

            {/* Idle overlay */}
            {status === "idle" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                <p className="text-xs uppercase tracking-widest text-zinc-600">
                  Camera + AI Pipeline
                </p>
                <button
                  onClick={start}
                  className="border border-red-500 px-6 py-3 text-xs font-black uppercase tracking-widest text-red-500 transition-colors hover:bg-red-500 hover:text-black"
                >
                  Start Camera
                </button>
                <p className="max-w-[180px] text-center text-[10px] text-zinc-700">
                  Stand 6–8 feet back so your full body is visible
                </p>
              </div>
            )}

            {/* Loading overlay */}
            {status === "loading" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-red-500" />
                <p className="text-[10px] uppercase tracking-widest text-zinc-600">
                  Loading AI models…
                </p>
              </div>
            )}

            {/* Error overlay */}
            {status === "error" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4">
                <p className="text-[10px] uppercase tracking-widest text-red-500">Error</p>
                <p className="text-center text-[10px] text-zinc-500">{errorMsg}</p>
                <button
                  onClick={start}
                  className="text-[10px] uppercase tracking-widest text-zinc-500 hover:text-zinc-300"
                >
                  Retry
                </button>
              </div>
            )}

            {/* Live prediction badge */}
            {isReady && prediction && (
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-black/70 px-3 py-1 backdrop-blur-sm">
                <span
                  className={`text-sm font-black uppercase tracking-wider ${
                    prediction.label === "idle" ? "text-zinc-600" : "text-red-400"
                  }`}
                >
                  {MOVE_DISPLAY[prediction.label] ?? prediction.label}
                </span>
                {prediction.direction && (
                  <span className="ml-2 text-[10px] text-zinc-600">
                    · {prediction.direction}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Histogram panel */}
          {showHistogram && (
            <div className="h-1/2 overflow-hidden">
              {isReady && prediction && labels.length > 0 ? (
                <Histogram
                  labels={labels}
                  allProbs={prediction.allProbs}
                  activeLabel={prediction.label}
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <p className="text-[10px] uppercase tracking-widest text-zinc-800">
                    Waiting for predictions…
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Right: Game Engine ── */}
        <div className="flex w-1/2 flex-col items-center justify-center border-l border-zinc-900">
          <p className="text-xs uppercase tracking-widest text-zinc-800">
            Game Engine
          </p>
          <p className="mt-1 text-[10px] text-zinc-900">Phase 3</p>
        </div>

      </div>
    </main>
  );
}
