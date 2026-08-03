"use client";

import { useState } from "react";
import Link from "next/link";
import { usePosePipeline } from "@/hooks/usePosePipeline";
import { useGameEngine, type CpuMode } from "@/hooks/useGameEngine";
import type { Difficulty } from "@/lib/game/cpu";
import GameCanvas from "./GameCanvas";

// Fixed display order matching pose_viewer.py custom_order
const MOVE_ORDER = [
  "idle", "jab", "cross", "lead_hook", "rear_hook", "uppercut",
  "jumping_cross", "rear_low_kick", "side_kick", "spinning_back_high_kick",
  "crouching_low_sweep", "grab", "hadouken", "shoryuken",
];

const MOVE_DISPLAY: Record<string, string> = {
  idle: "Idle",
  jab: "Jab",
  cross: "Cross",
  lead_hook: "Lead Hook",
  rear_hook: "Rear Hook",
  uppercut: "Uppercut",
  jumping_cross: "Jumping Cross",
  rear_low_kick: "Rear Low Kick",
  side_kick: "Side Kick",
  spinning_back_high_kick: "Spinning BHK",
  crouching_low_sweep: "Crouching Sweep",
  grab: "Grab",
  hadouken: "Hadouken",
  shoryuken: "Shoryuken",
};

function getLabelColor(index: number, total: number): string {
  return `hsl(${Math.round((index / total) * 320)}, 65%, 55%)`;
}

// ─── Prediction bars ─────────────────────────────────────────────────────────

function PredictionOverlay({
  labels, allProbs, activeLabel,
}: {
  labels: string[];
  allProbs: number[];
  activeLabel: string;
}) {
  const probMap: Record<string, number> = {};
  labels.forEach((l, i) => { probMap[l] = allProbs[i] ?? 0; });
  const displayLabels = MOVE_ORDER.filter(l => l in probMap);

  return (
    <div className="grid grid-cols-2 gap-x-2 gap-y-[3px] p-2">
      {displayLabels.map((label, i) => {
        const prob = probMap[label] ?? 0;
        const pct = Math.round(prob * 100);
        return (
          <div key={label} className="relative h-[15px] w-full">
            <div className="absolute inset-0 rounded-sm bg-black/60" />
            <div
              className="absolute inset-y-0 left-0 rounded-sm"
              style={{ width: `${pct}%`, backgroundColor: getLabelColor(i, displayLabels.length), opacity: 0.88 }}
            />
            {label === activeLabel && (
              <div className="absolute inset-0 rounded-sm ring-1 ring-white/90" />
            )}
            <span
              className="absolute inset-0 flex items-center pl-1.5 text-[9px] font-medium uppercase tracking-wide text-white"
              style={{ textShadow: "0 0 3px #000, 1px 1px 0 #000" }}
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
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [showBoxes, setShowBoxes] = useState(false);
  const [keyboardEnabled, setKeyboardEnabled] = useState(true);
  const [started, setStarted] = useState(false);

  const {
    videoRef, canvasRef,
    status: poseStatus, prediction, labels,
    errorMsg: poseErr, start: startPose,
  } = usePosePipeline();

  const {
    status: gameStatus, errorMsg: gameErr,
    gameState, start: startGame, activeMove,
  } = useGameEngine(prediction, { cpuMode, difficulty, keyboardEnabled });

  const isPoseReady = poseStatus === "ready";
  const isGameReady = gameStatus === "ready";

  const handleStart = () => {
    setStarted(true);
    startPose();
    startGame();
  };

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-[#0b0810]">
      {/* Top bar */}
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-900 px-4 py-1.5">
        <Link href="/" className="text-[10px] uppercase tracking-widest text-zinc-600 hover:text-zinc-400">
          ← Back
        </Link>
        <span className="text-[10px] uppercase tracking-widest text-zinc-700">Street Fighter Live</span>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={keyboardEnabled}
              onChange={e => setKeyboardEnabled(e.target.checked)}
              className="accent-red-500"
            />
            <span className="text-[9px] uppercase tracking-widest text-zinc-600">Keys</span>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={showBoxes}
              onChange={e => setShowBoxes(e.target.checked)}
              className="accent-red-500"
            />
            <span className="text-[9px] uppercase tracking-widest text-zinc-600">Boxes</span>
          </label>
        </div>
      </div>

      <video ref={videoRef} className="hidden" playsInline muted />

      {/* ── Game: full width, landscape. A fighting game needs a wide viewport;
             the camera feed lives underneath rather than stealing half the width. ── */}
      <div className="relative min-h-0 flex-1">
        {isGameReady ? (
          <GameCanvas gameState={gameState} showBoxes={showBoxes} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-5">
            {!started && (
              <>
                <h1 className="text-2xl font-black uppercase tracking-[0.2em] text-zinc-300">
                  Street Fighter Live
                </h1>

                <div className="flex items-start gap-10">
                  <div className="flex flex-col gap-2">
                    <p className="text-[9px] uppercase tracking-widest text-zinc-600">Opponent</p>
                    {(["random", "punchingBag"] as const).map(mode => (
                      <label key={mode} className="flex cursor-pointer items-center gap-2">
                        <input
                          type="radio"
                          name="cpuMode"
                          checked={cpuMode === mode}
                          onChange={() => setCpuMode(mode)}
                          className="accent-red-500"
                        />
                        <span className="text-[11px] uppercase tracking-wider text-zinc-400">
                          {mode === "random" ? "CPU" : "Punching Bag"}
                        </span>
                      </label>
                    ))}
                  </div>

                  <div className="flex flex-col gap-2">
                    <p className="text-[9px] uppercase tracking-widest text-zinc-600">Difficulty</p>
                    {(["easy", "medium", "hard"] as const).map(d => (
                      <label key={d} className="flex cursor-pointer items-center gap-2">
                        <input
                          type="radio"
                          name="difficulty"
                          checked={difficulty === d}
                          onChange={() => setDifficulty(d)}
                          className="accent-red-500"
                        />
                        <span className="text-[11px] uppercase tracking-wider text-zinc-400">{d}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <button
                  onClick={handleStart}
                  className="border border-red-500 px-8 py-3 text-xs font-black uppercase tracking-widest text-red-500 transition-colors hover:bg-red-500 hover:text-black"
                >
                  Start Game
                </button>
                <p className="max-w-xs text-center text-[10px] leading-relaxed text-zinc-700">
                  Stand 6–8 feet back so your full body is visible.
                  <br />
                  Debug keys: arrows move · A/S/D punch · Q/W/E kick
                </p>
              </>
            )}
            {gameStatus === "loading" && (
              <div className="flex flex-col items-center gap-3">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-800 border-t-red-500" />
                <p className="text-[10px] uppercase tracking-widest text-zinc-600">Loading game assets…</p>
              </div>
            )}
            {gameStatus === "error" && (
              <p className="text-center text-[10px] text-red-400">{gameErr}</p>
            )}
          </div>
        )}

        {/* Move flash over the game */}
        {isGameReady && activeMove && (
          <div className="pointer-events-none absolute inset-x-0 top-[22%] flex justify-center">
            <span
              key={activeMove}
              className="text-3xl font-black uppercase tracking-widest text-white"
              style={{
                textShadow: "0 0 18px #ff5a4a, 2px 2px 0 #000, -2px -2px 0 #000",
                animation: "fadeOut 1.2s ease-out forwards",
              }}
            >
              {MOVE_DISPLAY[activeMove] ?? activeMove}
            </span>
          </div>
        )}
      </div>

      {/* ── Camera strip ── */}
      <div className="flex h-[210px] shrink-0 border-t border-zinc-900 bg-black">
        <div className="relative aspect-[4/3] h-full shrink-0 bg-zinc-950">
          <canvas
            ref={canvasRef}
            className="h-full w-full object-contain"
            style={{ display: isPoseReady ? "block" : "none", transform: "scaleX(-1)" }}
          />
          {poseStatus === "loading" && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-[9px] uppercase tracking-widest text-zinc-600">Loading AI models…</p>
            </div>
          )}
          {poseStatus === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3">
              <p className="text-[9px] uppercase tracking-widest text-red-500">Camera unavailable</p>
              <p className="text-center text-[9px] text-zinc-600">{poseErr}</p>
              <button
                onClick={startPose}
                className="text-[9px] uppercase tracking-widest text-zinc-500 hover:text-zinc-300"
              >
                Retry
              </button>
              <p className="text-center text-[9px] text-zinc-700">
                Keyboard debug controls still work.
              </p>
            </div>
          )}
          {poseStatus === "idle" && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-[9px] uppercase tracking-widest text-zinc-700">Camera</p>
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-hidden">
          {isPoseReady && prediction && labels.length > 0 ? (
            <PredictionOverlay
              labels={labels}
              allProbs={prediction.allProbs}
              activeLabel={prediction.label}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-[9px] uppercase tracking-widest text-zinc-800">
                Pose predictions appear here
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
