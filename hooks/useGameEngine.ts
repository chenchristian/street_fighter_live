"use client";
import { useEffect, useRef, useCallback, useState } from "react";
import type { CharData, CharState, GameState } from "@/lib/game/types";
import { createChar, updateChar, normalizeCharData, objectRegistry } from "@/lib/game/engine";
import { runCollisions } from "@/lib/game/collision";
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
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevLabelRef = useRef<string>("idle");
  const cpuModeRef = useRef<CpuMode>(cpuMode);
  cpuModeRef.current = cpuMode;

  const [activeMove, setActiveMove] = useState<string | null>(null);

  const start = useCallback(async () => {
    setStatus("loading");
    try {
      const [ryuData, kenData, trainingData, hadoukenData, sparksData] = await Promise.all([
        loadCharData("/assets/objects/SF3/Ryu.json"),
        loadCharData("/assets/objects/SF3/Ken.json"),
        loadStageData("/assets/objects/Training.json"),
        loadCharData("/assets/objects/SF3/Hadouken.json"),
        loadCharData("/assets/objects/SF3/Sparks.json"),
      ].map(p => p.then(normalizeCharData)));

      // Register spawnable objects (create_object refs these by name)
      objectRegistry.dict["SF3/Hadouken"] = hadoukenData;
      objectRegistry.dict["SF3/Sparks"] = sparksData;
      objectRegistry.spawnQueue.length = 0;

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
        objects: [player, cpu],
        phase: "playing",
        frameCount: 0,
        winner: null,
        roundTimer: ROUND_TIMER_FRAMES,
        koTimer: 0,
      };

      gameRef.current = gs;
      setGameState({ ...gs });
      setStatus("ready");

      // Dev aids: poke the live game / step it synchronously from the console.
      // Stripped from production builds.
      if (process.env.NODE_ENV !== "production") {
        (window as unknown as { __game?: GameState }).__game = gs;
        (window as unknown as { __step?: (n?: number) => void }).__step = (n = 1) => {
          const g = gameRef.current;
          const stg = stageRef.current;
          if (!g || !stg) return;
          for (let i = 0; i < n && (g.phase === "playing" || g.koTimer > 0); i++) {
            tick(g, stg, cpuModeRef.current);
          }
          setGameState({ ...g });
        };
      }

      // Fixed-step 60fps simulation on setInterval (rAF stops in hidden tabs,
      // which would freeze the whole game — rendering still uses rAF).
      const STEP_MS = 1000 / 60;
      let last = performance.now();
      let acc = 0;

      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        const now = performance.now();
        acc += now - last;
        last = now;
        if (acc > 250) acc = 250;  // cap catch-up after tab sleep

        const g = gameRef.current;
        const stg = stageRef.current;
        if (!g || !stg || (g.phase !== "playing" && g.koTimer <= 0)) { acc = 0; return; }

        let stepped = false;
        while (acc >= STEP_MS) {
          tick(g, stg, cpuModeRef.current);
          acc -= STEP_MS;
          stepped = true;
        }
        // Shallow copy to trigger React re-render for health bars etc.
        if (stepped) setGameState({ ...g });
      }, STEP_MS / 2);
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

    // Walking: direction on any frame where label is idle (checked before isNew guard)
    // Camera is mirrored (scaleX -1) but MediaPipe uses unmirrored coords, so LEFT/RIGHT are flipped
    if (label === "idle" && prediction.direction) {
      const walkState = prediction.direction === "LEFT"
        ? (g.player.face === 1 ? "Walk Forward" : "Walk Backward")
        : (g.player.face === 1 ? "Walk Backward" : "Walk Forward");
      if (g.player.data.states[walkState]) {
        g.player.bufferState[walkState] = 8;
        g.player.inputInterPress = true;
      }
      prevLabelRef.current = label;
      return;
    }

    const isNew = label !== prevLabelRef.current && label !== "idle";
    prevLabelRef.current = label;

    if (!isNew) return;

    const stateName = CV_TO_STATE[label];
    if (stateName && g.player.data.states[stateName]) {
      g.player.bufferState[stateName] = 18;
      g.player.inputInterPress = true;
      setActiveMove(label);
    }
  }, [prediction]);

  // Cleanup
  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  return { status, errorMsg, gameState, start, activeMove };
}

// ─── One game tick ────────────────────────────────────────────────────────────

function tick(g: GameState, stage: CharState, cpuMode: CpuMode): void {
  g.frameCount++;

  if (g.phase === "playing") {
    g.roundTimer = Math.max(0, g.roundTimer - 1);
    // CPU AI
    if (cpuMode === "random") updateCpuInput(g.cpu, g.player);
  }

  // Update every live object (characters, projectiles, sparks)
  for (const obj of g.objects) updateChar(obj);

  // Bring in objects spawned this frame (fireballs, hit sparks)
  if (objectRegistry.spawnQueue.length) {
    for (const s of objectRegistry.spawnQueue) {
      if (!s.selfMainObject) s.selfMainObject = s.team === g.player.team ? g.player : g.cpu;
      if (!s.otherMainObject) s.otherMainObject = s.team === g.player.team ? g.cpu : g.player;
      g.objects.push(s);
    }
    objectRegistry.spawnQueue.length = 0;
  }

  // Collision pass: hits → push → stage bounds (matches Python order)
  runCollisions(g.objects, stage);

  // Kill projectiles that flew far offscreen
  const stageBB = stage.boxes["boundingbox"];
  if (stageBB?.boxes.length) {
    const [sx, , sw] = stageBB.boxes[0];
    for (const o of g.objects) {
      if (o.type === "projectile" && (o.pos[0] < sx - 600 || o.pos[0] > sx + sw + 600)) {
        o.killed = true;
      }
    }
  }

  // Reap killed objects
  if (g.objects.some(o => o.killed)) {
    g.objects = g.objects.filter(o => !o.killed);
  }

  // After KO: keep simulating so the knockdown plays out, then freeze
  if (g.phase !== "playing") {
    g.koTimer = Math.max(0, g.koTimer - 1);
    return;
  }

  // Win condition
  const playerDead = (g.player.gauges.health ?? 1) <= 0;
  const cpuDead = (g.cpu.gauges.health ?? 1) <= 0;
  const timeOut = g.roundTimer <= 0;

  if (playerDead || cpuDead || timeOut) {
    g.phase = "ko";
    g.koTimer = 180;  // let the fall/landing animation play out (~3s)
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
