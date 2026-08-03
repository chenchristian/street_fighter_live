"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePosePipeline } from "@/hooks/usePosePipeline";
import { useGameEngine, type CpuMode } from "@/hooks/useGameEngine";
import type { Difficulty } from "@/lib/game/cpu";
import GameShell from "@/components/GameShell";
import CvPanel from "@/components/CvPanel";
import GameCanvas, { type MenuModel, type MenuHit } from "./GameCanvas";

type MenuField = "opponent" | "difficulty" | "keyboard" | "boxes" | "start";
const FIELDS: MenuField[] = ["opponent", "difficulty", "keyboard", "boxes", "start"];

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];
const OPPONENTS: CpuMode[] = ["random", "punchingBag"];
const OPPONENT_LABEL: Record<CpuMode, string> = {
  random: "CPU",
  punchingBag: "PUNCH BAG",
};

export default function GamePage() {
  const [cpuMode, setCpuMode] = useState<CpuMode>("random");
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [showBoxes, setShowBoxes] = useState(false);
  const [keyboardEnabled, setKeyboardEnabled] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [started, setStarted] = useState(false);

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
    if (field === "opponent") setCpuMode(v => cycle(OPPONENTS, v, dir));
    else if (field === "difficulty") setDifficulty(v => cycle(DIFFICULTIES, v, dir));
    else if (field === "keyboard") setKeyboardEnabled(v => !v);
    else if (field === "boxes") setShowBoxes(v => !v);
  }, []);

  /** Enter, or a click on the row body rather than one of its arrows. */
  const activate = useCallback((field: MenuField) => {
    if (field === "start") handleStart();
    else if (field === "keyboard") setKeyboardEnabled(v => !v);
    else if (field === "boxes") setShowBoxes(v => !v);
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
        { label: "OPPONENT", value: OPPONENT_LABEL[cpuMode], cycles: true },
        {
          label: "DIFFICULTY",
          value: difficulty.toUpperCase(),
          cycles: true,
          // Difficulty only tunes the CPU AI; a punching bag takes no input at
          // all, so the setting has nothing to act on. Say so rather than
          // leaving a live-looking control that does nothing.
          dim: cpuMode === "punchingBag",
        },
        { label: "KEYBOARD", value: keyboardEnabled ? "ON" : "OFF", cycles: true },
        { label: "HITBOXES", value: showBoxes ? "ON" : "OFF", cycles: true },
        { label: "START", value: "" },
      ],
      footer: [
        cpuMode === "punchingBag"
          ? "PUNCH BAG IGNORES DIFFICULTY"
          : "ARROW KEYS OR CLICK TO CHANGE",
        "ENTER STARTS - STAND 6-8 FEET BACK",
      ],
    };
  }, [started, cursor, cpuMode, difficulty, keyboardEnabled, showBoxes]);

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
            <span>Boxes</span>
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
