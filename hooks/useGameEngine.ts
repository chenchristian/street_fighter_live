"use client";
import { useEffect, useRef, useCallback, useState } from "react";
import type { CharData, CharState, GameState } from "@/lib/game/types";
import { createChar, updateChar } from "@/lib/game/engine";
import { applyBoundingBox, applyPushCollision, applyHitCollision } from "@/lib/game/collision";
import { CV_TO_STATE, updateCpuInput } from "@/lib/game/cpu";
import type { PredictionState } from "./usePosePipeline";

const ROUND_TIMER_FRAMES = 60 * 99;  // 99 seconds

async function loadCharData(url: string): Promise<CharData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}`);
  return res.json();
}

// Stage object that provides the bounding box for floor/wall collision
async function loadStageData(url: string): Promise<CharData> {
  return loadCharData(url);
}

export type GameEngineStatus = "idle" | "loading" | "ready" | "error";
export type CpuMode = "random" | "punchingBag";

export function useGameEngine(prediction: PredictionState | null, cpuMode: CpuMode = "random") {
  const [status, setStatus] = useState<GameEngineStatus>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [gameState, setGameState] = useState<GameState | null>(null);

  const gameRef = useRef<GameState | null>(null);
  const stageRef = useRef<CharState | null>(null);
  const rafRef = useRef<number>(0);
  const prevLabelRef = useRef<string>("idle");
  const cpuModeRef = useRef<CpuMode>(cpuMode);
  cpuModeRef.current = cpuMode;

  const start = useCallback(async () => {
    setStatus("loading");
    try {
      const [ryuData, kenData, trainingData] = await Promise.all([
        loadCharData("/assets/objects/SF3/Ryu.json"),
        loadCharData("/assets/objects/SF3/Ken.json"),
        loadStageData("/assets/objects/Training.json"),
      ]);

      // Create player (Ryu on left, facing right)
      const player = createChar(ryuData, "Ryu Reencor Style", [-300, 0], 1, 1, "Stand");
      // Create CPU (Ken on right, facing left)
      const cpu = createChar(kenData, "Ken Reencor Style", [300, 0], -1, 2, "Stand");

      // Wire cross-references
      player.selfMainObject = player;
      player.otherMainObject = cpu;
      cpu.selfMainObject = cpu;
      cpu.otherMainObject = player;

      // Stage as a CharState for bounding box reuse
      const stage = createChar(trainingData, "stage", [0, 0], 1, 0, "Stand");
      stageRef.current = stage;

      const gs: GameState = {
        player,
        cpu,
        phase: "playing",
        frameCount: 0,
        winner: null,
        roundTimer: ROUND_TIMER_FRAMES,
      };

      gameRef.current = gs;
      setGameState({ ...gs });
      setStatus("ready");

      // Game loop at 60fps via rAF
      let lastTime = 0;
      const FRAME_MS = 1000 / 60;

      const loop = (now: number) => {
        rafRef.current = requestAnimationFrame(loop);
        const elapsed = now - lastTime;
        if (elapsed < FRAME_MS - 1) return;   // skip if too soon
        lastTime = now;

        const g = gameRef.current;
        const stg = stageRef.current;
        if (!g || !stg || g.phase !== "playing") return;

        tick(g, stg, cpuModeRef.current);

        // Shallow copy to trigger React re-render for health bars etc.
        setGameState({ ...g });
      };

      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      setStatus("error");
      setErrorMsg(e instanceof Error ? e.message : "Unknown error");
    }
  }, []);

  // Inject CV prediction into player input each frame
  useEffect(() => {
    const g = gameRef.current;
    if (!g || !prediction) return;

    const label = prediction.label;
    const isNew = label !== prevLabelRef.current && label !== "idle";
    prevLabelRef.current = label;

    if (!isNew) return;

    const stateName = CV_TO_STATE[label];
    if (stateName && g.player.data.states[stateName]) {
      g.player.bufferState[stateName] = 6;
      g.player.inputInterPress = true;
    }

    // Handle walking based on direction
    if (label === "idle" && prediction.direction) {
      const walkState = prediction.direction === "RIGHT"
        ? (g.player.face === 1 ? "Walk Forward" : "Walk Backward")
        : (g.player.face === 1 ? "Walk Backward" : "Walk Forward");
      if (g.player.data.states[walkState]) {
        g.player.bufferState[walkState] = 4;
        g.player.inputInterPress = true;
      }
    }
  }, [prediction]);

  // Cleanup
  useEffect(() => () => { cancelAnimationFrame(rafRef.current); }, []);

  return { status, errorMsg, gameState, start };
}

// ─── One game tick ────────────────────────────────────────────────────────────

function tick(g: GameState, stage: CharState, cpuMode: CpuMode): void {
  g.frameCount++;
  g.roundTimer = Math.max(0, g.roundTimer - 1);

  // CPU AI
  if (cpuMode === "random") updateCpuInput(g.cpu, g.player);

  // Update both characters
  updateChar(g.player);
  updateChar(g.cpu);

  // Apply stage collision
  applyBoundingBox(g.player, stage);
  applyBoundingBox(g.cpu, stage);

  // Pushbox (character vs character)
  applyPushCollision(g.player, g.cpu);

  // Hitbox vs hurtbox
  applyHitCollision(g.player, g.cpu);
  applyHitCollision(g.cpu, g.player);

  // Win condition
  const playerDead = (g.player.gauges.health ?? 1) <= 0;
  const cpuDead = (g.cpu.gauges.health ?? 1) <= 0;
  const timeOut = g.roundTimer <= 0;

  if (playerDead || cpuDead || timeOut) {
    g.phase = "ko";
    if (playerDead && !cpuDead) g.winner = "cpu";
    else if (cpuDead && !playerDead) g.winner = "player";
    else if (timeOut) {
      g.winner = (g.player.gauges.health ?? 0) >= (g.cpu.gauges.health ?? 0)
        ? "player"
        : "cpu";
    } else {
      g.winner = null; // draw
    }
  }
}
