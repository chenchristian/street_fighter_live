"use client";
import { useEffect, useRef, useCallback, useState } from "react";
import type { CharData, CharState, GameState } from "@/lib/game/types";
import { createChar, normalizeCharData, objectRegistry } from "@/lib/game/engine";
import { createGame, tick, type TickInputs } from "@/lib/game/match";
import { CpuController, type Difficulty } from "@/lib/game/cpu";
import { CvSource, KeyboardSource } from "@/lib/game/sources";
import { emptyRawInput } from "@/lib/game/input";
import { gameRng } from "@/lib/game/rng";
import { FixedClock } from "@/lib/game/clock";
import type { PredictionState } from "./usePosePipeline";

async function loadCharData(url: string): Promise<CharData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
  return res.json();
}

export type GameEngineStatus = "idle" | "loading" | "ready" | "error";
export type CpuMode = "random" | "punchingBag";

export interface GameEngineOptions {
  cpuMode?: CpuMode;
  difficulty?: Difficulty;
  /** Debug keyboard control. Arrows move, A/S/D punch, Q/W/E kick. */
  keyboardEnabled?: boolean;
}

export function useGameEngine(
  prediction: PredictionState | null,
  options: GameEngineOptions = {}
) {
  const { cpuMode = "random", difficulty = "medium", keyboardEnabled = false } = options;

  const [status, setStatus] = useState<GameEngineStatus>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [activeMove, setActiveMove] = useState<string | null>(null);

  const gameRef = useRef<GameState | null>(null);
  const stageRef = useRef<CharState | null>(null);
  const clockRef = useRef<FixedClock>(new FixedClock({ fps: 60 }));

  const cpuRef = useRef<CpuController | null>(null);
  const cvRef = useRef<CvSource>(new CvSource());
  const keyboardRef = useRef<KeyboardSource>(new KeyboardSource());

  const optsRef = useRef({ cpuMode, difficulty, keyboardEnabled });
  useEffect(() => {
    optsRef.current = { cpuMode, difficulty, keyboardEnabled };
  }, [cpuMode, difficulty, keyboardEnabled]);

  // Keyboard listeners follow the debug flag.
  useEffect(() => {
    const kb = keyboardRef.current;
    if (keyboardEnabled) kb.attach();
    else kb.detach();
    return () => kb.detach();
  }, [keyboardEnabled]);

  useEffect(() => {
    cpuRef.current?.setDifficulty(difficulty);
  }, [difficulty]);

  const start = useCallback(async () => {
    setStatus("loading");
    try {
      const [ryuData, kenData, trainingData, hadoukenData, sparksData] = await Promise.all(
        [
          loadCharData("/assets/objects/SF3/Ryu.json"),
          loadCharData("/assets/objects/SF3/Ken.json"),
          loadCharData("/assets/objects/Training.json"),
          loadCharData("/assets/objects/SF3/Hadouken.json"),
          loadCharData("/assets/objects/SF3/Sparks.json"),
        ].map(p => p.then(normalizeCharData))
      );

      objectRegistry.dict["SF3/Hadouken"] = hadoukenData;
      objectRegistry.dict["SF3/Sparks"] = sparksData;

      const stage = createChar(trainingData, "stage", [0, 0], 1, 0, "Stand");
      stageRef.current = stage;

      const seed = (Date.now() ^ 0x5f3759df) >>> 0;
      const gs = createGame({ playerData: ryuData, cpuData: kenData, stage }, seed);

      cpuRef.current = new CpuController(optsRef.current.difficulty);
      cvRef.current.reset();

      gameRef.current = gs;
      setGameState({ ...gs });
      setStatus("ready");

      if (process.env.NODE_ENV !== "production") {
        // Dev handles. __clock.stop() plus __step(n) gives fully synchronous,
        // frame-exact control of the simulation — the only way to test frame
        // data reliably, since every browser timer is throttled in a hidden tab.
        Object.assign(window as unknown as Record<string, unknown>, {
          __game: gs,
          __clock: clockRef.current,
          __step: (n = 1) => {
            const g = gameRef.current;
            const stg = stageRef.current;
            if (!g || !stg) return;
            for (let i = 0; i < n; i++) stepOnce(g, stg);
            setGameState({ ...g });
          },
        });
      }

      const stepOnce = (g: GameState, stg: CharState) => {
        const opts = optsRef.current;
        const inputs: TickInputs = {
          player: emptyRawInput(),
          cpu: emptyRawInput(),
        };

        // Player: CV is the real input; keyboard is an additive debug override.
        const cv = cvRef.current.read();
        inputs.player = cv.raw;
        inputs.playerCommands = cv.commands;
        if (opts.keyboardEnabled) {
          const kb = keyboardRef.current.read();
          const hasKb = kb.dir[0] !== 0 || kb.dir[1] !== 0 || kb.buttons.some(Boolean);
          if (hasKb) inputs.player = kb;
        }

        if (opts.cpuMode === "random" && cpuRef.current) {
          inputs.cpu = cpuRef.current.update(g.cpu, g.player, gameRng);
        }

        tick(g, stg, inputs);
      };

      clockRef.current.start(
        () => {
          const g = gameRef.current;
          const stg = stageRef.current;
          if (g && stg) stepOnce(g, stg);
        },
        () => {
          const g = gameRef.current;
          if (g) setGameState({ ...g });
          // Surfacing the active move here rather than from a prediction effect
          // keeps setState in a callback from an external system (the clock),
          // which is what React actually wants.
          setActiveMove(cvRef.current.activeLabel);
        }
      );
    } catch (e) {
      setStatus("error");
      setErrorMsg(e instanceof Error ? e.message : "Unknown error");
    }
  }, []);

  // Push classifier output into the CV input source (an external system).
  useEffect(() => {
    if (!prediction) return;
    cvRef.current.setPrediction(prediction.label, prediction.direction);
  }, [prediction]);

  useEffect(() => {
    const clock = clockRef.current;
    return () => clock.stop();
  }, []);

  return { status, errorMsg, gameState, start, activeMove };
}
