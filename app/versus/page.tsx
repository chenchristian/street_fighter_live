"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePosePipeline } from "@/hooks/usePosePipeline";
import { useNetplay } from "@/hooks/useNetplay";
import GameShell from "@/components/GameShell";
import CvPanel from "@/components/CvPanel";
import GameCanvas, { type MenuModel } from "../game/GameCanvas";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
type Field = "mode" | "code" | "go";
const FIELDS: Field[] = ["mode", "code", "go"];

export default function VersusPage() {
  const [isHosting, setIsHosting] = useState(true);
  const [joinCode, setJoinCode] = useState("");
  const [showBoxes, setShowBoxes] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [launched, setLaunched] = useState(false);

  const {
    videoRef, canvasRef, status: poseStatus, prediction, labels,
    errorMsg: poseErr, stats, camAspect, start: startPose,
  } = usePosePipeline();

  const { gameState, net, host, join } = useNetplay(prediction, true);

  const launch = useCallback(() => {
    if (isHosting) {
      setLaunched(true);
      startPose();
      void host();
    } else {
      if (joinCode.length < 5) return;
      setLaunched(true);
      startPose();
      void join(joinCode);
    }
  }, [isHosting, joinCode, host, join, startPose]);

  // ── Lobby navigation ──
  useEffect(() => {
    if (launched) return;
    const onKey = (e: KeyboardEvent) => {
      const field = FIELDS[cursor];

      if (field === "code" && !isHosting) {
        if (e.key.length === 1 && CODE_CHARS.includes(e.key.toUpperCase())) {
          e.preventDefault();
          setJoinCode(c => (c + e.key.toUpperCase()).slice(0, 5));
          return;
        }
        if (e.code === "Backspace") {
          e.preventDefault();
          setJoinCode(c => c.slice(0, -1));
          return;
        }
      }

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
          if (field === "mode") setIsHosting(v => !v);
          break;
        case "Enter":
        case "Space":
          e.preventDefault();
          if (field === "go") launch();
          else if (field === "mode") setIsHosting(v => !v);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [launched, cursor, isHosting, launch]);

  const menu: MenuModel | null = useMemo(() => {
    if (launched) return null;
    return {
      title: "ONLINE VERSUS",
      subtitle: "PEER TO PEER - ROLLBACK NETCODE",
      cursor,
      rows: [
        { label: "MODE", value: isHosting ? "HOST" : "JOIN" },
        {
          label: isHosting ? "ROOM CODE" : "ENTER CODE",
          value: isHosting ? "AUTO" : joinCode.padEnd(5, "-"),
        },
        { label: isHosting ? "CREATE ROOM" : "CONNECT", value: "" },
      ],
      footer: [
        isHosting ? "HOST PLAYS RYU ON THE LEFT" : "GUEST PLAYS KEN ON THE RIGHT",
        "ARROWS SELECT - ENTER CONFIRMS",
      ],
    };
  }, [launched, cursor, isHosting, joinCode]);

  // In-canvas status while connecting / waiting / after a drop.
  const status = useMemo(() => {
    if (!launched || gameState) return null;
    switch (net.status) {
      case "connecting":
        return "CONNECTING";
      case "waiting":
        return `SHARE THIS CODE\n*${net.roomCode}\nWAITING FOR OPPONENT`;
      case "connected":
        return "CONNECTED\nSTARTING MATCH";
      case "closed":
        return "OPPONENT DISCONNECTED";
      case "error":
        return `*ERROR\n${(net.detail || "").toUpperCase().slice(0, 40)}`;
      default:
        return "STARTING";
    }
  }, [launched, gameState, net.status, net.roomCode, net.detail]);

  return (
    <GameShell
      topbar={
        <div className="shell-topbar">
          <Link href="/">&larr; Back</Link>
          <span>Online Versus</span>
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
        >
          <h3>Netplay</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <NetRow k="Status" v={net.status} />
            <NetRow k="Role" v={launched ? (net.isHost ? "Host / Ryu" : "Guest / Ken") : isHosting ? "Host / Ryu" : "Guest / Ken"} />
            <NetRow k="Room" v={net.roomCode || "—"} />
            <NetRow k="Ping" v={`${net.rtt} ms`} />
            <NetRow k="Delay" v={`${net.inputDelay} f`} />
            <NetRow k="Rollbacks" v={String(net.rollbacks)} />
            <NetRow k="Stalls" v={String(net.stalls)} />
          </div>
          {net.desynced && (
            <p className="cv-legend" style={{ color: "var(--blood)" }}>
              Desync detected — the two simulations have diverged.
            </p>
          )}
        </CvPanel>
      }
    >
      {scale => (
        <GameCanvas
          gameState={gameState}
          showBoxes={showBoxes}
          scale={scale}
          menu={menu}
          status={status}
        />
      )}
    </GameShell>
  );
}

function NetRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="net-row">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}
