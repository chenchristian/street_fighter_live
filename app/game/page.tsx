"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePosePipeline } from "@/hooks/usePosePipeline";
import { useGameEngine, type CpuMode } from "@/hooks/useGameEngine";
import type { Difficulty } from "@/lib/game/cpu";
import GameShell from "@/components/GameShell";
import CvPanel from "@/components/CvPanel";
import GameCanvas, { type MenuModel, type MenuHit } from "./GameCanvas";

type MenuField = "difficulty" | "keyboard" | "start";
const FIELDS: MenuField[] = ["difficulty", "keyboard", "start"];

// One combined control. "Practice" is the old punching bag — a dummy that takes
// no input; the other three set the CPU AI's difficulty.
type GameMode = "practice" | "easy" | "medium" | "hard";
const MODES: GameMode[] = ["practice", "easy", "medium", "hard"];

export default function GamePage() {
  const [mode, setMode] = useState<GameMode>("medium");
  const [showBoxes, setShowBoxes] = useState(false);
  const [keyboardEnabled, setKeyboardEnabled] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [started, setStarted] = useState(false);

  // The engine still takes opponent kind and AI difficulty separately; derive
  // both from the single menu choice.
  const cpuMode: CpuMode = mode === "practice" ? "punchingBag" : "random";
  const difficulty: Difficulty = mode === "practice" ? "medium" : mode;

  const {
    videoRef, canvasRef, status: poseStatus, prediction, labels,
    errorMsg: poseErr, stats, camAspect, start: startPose,
  } = usePosePipeline();

  const {
    status: gameStatus, errorMsg: gameErr, gameState, start: startGame, loadProgress,
  } = useGameEngine(prediction, { cpuMode, difficulty, keyboardEnabled });

  const handleStart = useCallback(() => {
    setStarted(true);
    startPose();
    startGame();
  }, [startPose, startGame]);

  // Value changes go through one place, so the arrow keys and the on-screen
  // arrows can never drift out of step.
  const adjust = useCallback((field: MenuField, dir: -1 | 1) => {
    const cycle = <T,>(list: T[], cur: T, d: number): T =>
      list[(list.indexOf(cur) + d + list.length) % list.length];
    if (field === "difficulty") setMode(v => cycle(MODES, v, dir));
    else if (field === "keyboard") setKeyboardEnabled(v => !v);
  }, []);

  /** Enter, or a click on the row body rather than one of its arrows. */
  const activate = useCallback((field: MenuField) => {
    if (field === "start") handleStart();
    else if (field === "keyboard") setKeyboardEnabled(v => !v);
  }, [handleStart]);

  const onMenuHit = useCallback((hit: MenuHit) => {
    setCursor(hit.row);
    const field = FIELDS[hit.row];
    if (hit.dir !== 0) adjust(field, hit.dir);
    else activate(field);
  }, [adjust, activate]);

  // ── Menu navigation, arrows + confirm ──
  useEffect(() => {
    if (started) return;
    const onKey = (e: KeyboardEvent) => {
      const field = FIELDS[cursor];
      switch (e.code) {
        case "ArrowUp":
          e.preventDefault();
          setCursor(c => (c - 1 + FIELDS.length) % FIELDS.length);
          break;
        case "ArrowDown":
          e.preventDefault();
          setCursor(c => (c + 1) % FIELDS.length);
          break;
        case "ArrowLeft":
        case "ArrowRight":
          e.preventDefault();
          adjust(field, e.code === "ArrowLeft" ? -1 : 1);
          break;
        case "Enter":
        case "Space":
        case "KeyA":
          e.preventDefault();
          activate(field);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [started, cursor, adjust, activate]);

  const menu: MenuModel | null = useMemo(() => {
    if (started) return null;
    return {
      title: "STREET FIGHTER",
      subtitle: "LIVE - CONTROLLED BY YOUR BODY",
      cursor,
      rows: [
        { label: "DIFFICULTY", value: mode.toUpperCase(), cycles: true },
        { label: "KEYBOARD", value: keyboardEnabled ? "ON" : "OFF", cycles: true },
        { label: "START", value: "" },
      ],
      footer: [
        mode === "practice"
          ? "PRACTICE - OPPONENT WON'T FIGHT BACK"
          : "ARROW KEYS OR CLICK TO CHANGE",
        "ENTER STARTS - STAND 6-8 FEET BACK",
      ],
    };
  }, [started, cursor, mode, keyboardEnabled]);

  const status = useMemo(() => {
    if (!started) return null;
    if (gameStatus === "loading") return `LOADING SPRITES\n${Math.round(loadProgress * 100)}%`;
    if (gameStatus === "error") return `*ERROR\n${(gameErr || "").toUpperCase()}`;
    return null;
  }, [started, gameStatus, gameErr, loadProgress]);

  return (
    <GameShell
      topbar={
        <div className="shell-topbar">
          <Link href="/">&larr; Back</Link>
          <span>Street Fighter Live</span>
          <label className="shell-toggle">
            <input
              type="checkbox"
              checked={showBoxes}
              onChange={e => setShowBoxes(e.target.checked)}
            />
            <span>Hitboxes</span>
          </label>
        </div>
      }
      sidebar={
        <CvPanel
          videoRef={videoRef}
          overlayRef={canvasRef}
          labels={labels}
          prediction={prediction}
          stats={stats}
          camAspect={camAspect}
          status={poseStatus}
          errorMsg={poseErr}
        />
      }
    >
      {scale => (
        <GameCanvas
          gameState={gameState}
          showBoxes={showBoxes}
          scale={scale}
          menu={menu}
          status={status}
          onMenuHit={onMenuHit}
        />
      )}
    </GameShell>
  );
}
