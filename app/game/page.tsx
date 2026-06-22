"use client";

import { useState } from "react";
import Link from "next/link";
import { usePosePipeline } from "@/hooks/usePosePipeline";
import { useGameEngine, type CpuMode } from "@/hooks/useGameEngine";
import GameCanvas from "./GameCanvas";

// Fixed display order matching pose_viewer.py custom_order
const MOVE_ORDER = [
  "idle", "jab", "cross", "lead_hook", "rear_hook", "uppercut",
  "jumping_cross", "rear_low_kick", "side_kick", "spinning_back_high_kick",
  "crouching_low_sweep", "grab", "hadouken", "shoryuken",
];

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

// HSV-style colors matching Python's _generate_colors (hue spread across 0-180° HSV → CSS HSL)
function getLabelColor(index: number, total: number): string {
  const hue = Math.round((index / total) * 320);
  return `hsl(${hue}, 65%, 55%)`;
}

// ─── Prediction overlay — drawn on top of camera, mirrors pose_viewer.py bar chart ───

function PredictionOverlay({
  labels,
  allProbs,
  activeLabel,
}: {
  labels: string[];
  allProbs: number[];
  activeLabel: string;
}) {
  const probMap: Record<string, number> = {};
  labels.forEach((l, i) => { probMap[l] = allProbs[i] ?? 0; });

  const displayLabels = MOVE_ORDER.filter(l => l in probMap);
  const total = displayLabels.length;

  return (
    <div className="absolute top-3 left-3 flex flex-col gap-[5px] pointer-events-none select-none">
      {displayLabels.map((label, i) => {
        const prob = probMap[label] ?? 0;
        const isActive = label === activeLabel;
        const color = getLabelColor(i, total);
        const pct = Math.round(prob * 100);

        return (
          <div key={label} className="relative h-[18px] w-[175px]">
            {/* Dark background */}
            <div className="absolute inset-0 rounded-sm bg-black/55" />
            {/* Probability fill */}
            <div
              className="absolute inset-y-0 left-0 rounded-sm"
              style={{ width: `${pct}%`, backgroundColor: color, opacity: 0.88 }}
            />
            {/* Active outline */}
            {isActive && (
              <div className="absolute inset-0 rounded-sm ring-1 ring-white/90" />
            )}
            {/* Label text — white with black shadow like Python's _draw_text */}
            <span
              className="absolute inset-0 flex items-center pl-1.5 text-[10px] font-medium uppercase tracking-wide text-white"
              style={{ textShadow: "0 0 3px #000, 1px 1px 0 #000, -1px -1px 0 #000" }}
            >
              {MOVE_DISPLAY[label] ?? label}: {pct}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function GamePage() {
  const [cpuMode, setCpuMode] = useState<CpuMode>("random");

  const {
    videoRef, canvasRef,
    status: poseStatus, prediction, labels,
    errorMsg: poseErr, start: startPose,
  } = usePosePipeline();

  const {
    status: gameStatus, errorMsg: gameErr,
    gameState, start: startGame,
  } = useGameEngine(prediction, cpuMode);

  const isPoseReady = poseStatus === "ready";
  const isGameReady = gameStatus === "ready";

  const handleStart = () => {
    startPose();
    startGame();
  };

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
        <div className="w-24" />
      </div>

      {/* Hidden video element */}
      <video ref={videoRef} className="hidden" playsInline muted />

      {/* Main layout — always 50/50 */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left: Camera (full height) + overlays ── */}
        <div className="relative w-1/2 overflow-hidden bg-zinc-950">

          {/* Camera canvas — mirrored like a mirror */}
          <canvas
            ref={canvasRef}
            className="h-full w-full object-contain"
            style={{
              display: isPoseReady ? "block" : "none",
              transform: "scaleX(-1)",
            }}
          />

          {/* Start screen */}
          {poseStatus === "idle" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
              <p className="text-xs uppercase tracking-widest text-zinc-600">
                Camera + Game
              </p>

              {/* CPU mode selector */}
              <div className="flex flex-col gap-2">
                <p className="text-center text-[10px] uppercase tracking-widest text-zinc-600">Opponent</p>
                {(["random", "punchingBag"] as const).map((mode) => (
                  <label
                    key={mode}
                    className="flex cursor-pointer items-center gap-2"
                  >
                    <input
                      type="radio"
                      name="cpuMode"
                      value={mode}
                      checked={cpuMode === mode}
                      onChange={() => setCpuMode(mode)}
                      className="accent-red-500"
                    />
                    <span className="text-[11px] uppercase tracking-wider text-zinc-400">
                      {mode === "random" ? "Random" : "Punching Bag"}
                    </span>
                  </label>
                ))}
              </div>

              <button
                onClick={handleStart}
                className="border border-red-500 px-6 py-3 text-xs font-black uppercase tracking-widest text-red-500 transition-colors hover:bg-red-500 hover:text-black"
              >
                Start Game
              </button>
              <p className="max-w-[180px] text-center text-[10px] text-zinc-700">
                Stand 6–8 feet back so your full body is visible
              </p>
            </div>
          )}

          {/* Loading */}
          {(poseStatus === "loading" || gameStatus === "loading") && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-red-500" />
              <p className="text-[10px] uppercase tracking-widest text-zinc-600">
                {gameStatus === "loading" ? "Loading game assets…" : "Loading AI models…"}
              </p>
            </div>
          )}

          {/* Error */}
          {(poseStatus === "error" || gameStatus === "error") && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4">
              <p className="text-[10px] uppercase tracking-widest text-red-500">Error</p>
              <p className="text-center text-[10px] text-zinc-500">{poseErr || gameErr}</p>
              <button
                onClick={handleStart}
                className="text-[10px] uppercase tracking-widest text-zinc-500 hover:text-zinc-300"
              >
                Retry
              </button>
            </div>
          )}

          {/* Prediction bar overlay (top-left, like pose_viewer.py) */}
          {isPoseReady && prediction && labels.length > 0 && (
            <PredictionOverlay
              labels={labels}
              allProbs={prediction.allProbs}
              activeLabel={prediction.label}
            />
          )}

          {/* Active move badge (bottom center) */}
          {isPoseReady && prediction && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-black/70 px-3 py-1 backdrop-blur-sm">
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

        {/* ── Right: Game Engine (full height) ── */}
        <div className="flex w-1/2 flex-col border-l border-zinc-900">
          {isGameReady ? (
            <GameCanvas gameState={gameState} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2">
              <p className="text-xs uppercase tracking-widest text-zinc-800">
                {gameStatus === "loading" ? "Loading…" : "Game Engine"}
              </p>
              {gameStatus === "idle" && (
                <p className="text-[10px] text-zinc-900">Click Start Game to begin</p>
              )}
            </div>
          )}
        </div>

      </div>
    </main>
  );
}
