"use client";

import { useState } from "react";
import Link from "next/link";
import { usePosePipeline } from "@/hooks/usePosePipeline";
import { useNetplay } from "@/hooks/useNetplay";
import GameCanvas from "../game/GameCanvas";

export default function VersusPage() {
  const [joinCode, setJoinCode] = useState("");
  const [showBoxes, setShowBoxes] = useState(false);
  const [keyboardEnabled, setKeyboardEnabled] = useState(true);

  const {
    videoRef, canvasRef, status: poseStatus, prediction, start: startPose,
  } = usePosePipeline();

  const { gameState, net, host, join } = useNetplay(prediction, keyboardEnabled);

  const inMatch = gameState !== null;

  const handleHost = () => { startPose(); void host(); };
  const handleJoin = () => {
    if (joinCode.trim().length < 3) return;
    startPose();
    void join(joinCode.trim());
  };

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-[#0b0810]">
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-900 px-4 py-1.5">
        <Link href="/" className="text-[10px] uppercase tracking-widest text-zinc-600 hover:text-zinc-400">
          ← Back
        </Link>
        <span className="text-[10px] uppercase tracking-widest text-zinc-700">
          Online Versus
        </span>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={keyboardEnabled}
              onChange={e => setKeyboardEnabled(e.target.checked)} className="accent-red-500" />
            <span className="text-[9px] uppercase tracking-widest text-zinc-600">Keys</span>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={showBoxes}
              onChange={e => setShowBoxes(e.target.checked)} className="accent-red-500" />
            <span className="text-[9px] uppercase tracking-widest text-zinc-600">Boxes</span>
          </label>
        </div>
      </div>

      <video ref={videoRef} className="hidden" playsInline muted />

      <div className="relative min-h-0 flex-1">
        {inMatch ? (
          <GameCanvas gameState={gameState} showBoxes={showBoxes} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-6">
            <h1 className="text-2xl font-black uppercase tracking-[0.2em] text-zinc-300">
              Online Versus
            </h1>

            {net.status === "idle" && (
              <div className="flex items-start gap-12">
                <div className="flex w-52 flex-col items-center gap-3">
                  <p className="text-[9px] uppercase tracking-widest text-zinc-600">Host a match</p>
                  <button
                    onClick={handleHost}
                    className="w-full border border-red-500 px-6 py-3 text-xs font-black uppercase tracking-widest text-red-500 transition-colors hover:bg-red-500 hover:text-black"
                  >
                    Create Room
                  </button>
                  <p className="text-center text-[9px] leading-relaxed text-zinc-700">
                    You play Ryu on the left. Share the code with your opponent.
                  </p>
                </div>

                <div className="flex w-52 flex-col items-center gap-3">
                  <p className="text-[9px] uppercase tracking-widest text-zinc-600">Join a match</p>
                  <input
                    value={joinCode}
                    onChange={e => setJoinCode(e.target.value.toUpperCase())}
                    onKeyDown={e => { if (e.key === "Enter") handleJoin(); }}
                    placeholder="ROOM CODE"
                    maxLength={5}
                    className="w-full border border-zinc-800 bg-black px-3 py-3 text-center font-mono text-sm uppercase tracking-[0.3em] text-zinc-200 outline-none focus:border-red-500"
                  />
                  <button
                    onClick={handleJoin}
                    className="w-full border border-zinc-700 px-6 py-2 text-xs font-black uppercase tracking-widest text-zinc-400 transition-colors hover:border-red-500 hover:text-red-500"
                  >
                    Join
                  </button>
                  <p className="text-center text-[9px] leading-relaxed text-zinc-700">
                    You play Ken on the right.
                  </p>
                </div>
              </div>
            )}

            {net.status === "connecting" && (
              <p className="text-[10px] uppercase tracking-widest text-zinc-500">Connecting…</p>
            )}

            {net.status === "waiting" && (
              <div className="flex flex-col items-center gap-3">
                <p className="text-[9px] uppercase tracking-widest text-zinc-600">Room code</p>
                <p className="font-mono text-5xl font-black tracking-[0.3em] text-red-500">
                  {net.roomCode}
                </p>
                <p className="text-[10px] uppercase tracking-widest text-zinc-600">
                  Waiting for opponent…
                </p>
              </div>
            )}

            {net.status === "connected" && (
              <p className="text-[10px] uppercase tracking-widest text-zinc-500">
                Connected — starting match…
              </p>
            )}

            {net.status === "error" && (
              <div className="flex flex-col items-center gap-2">
                <p className="text-[10px] uppercase tracking-widest text-red-500">
                  Connection error
                </p>
                <p className="max-w-sm text-center text-[10px] text-zinc-600">{net.detail}</p>
              </div>
            )}

            {net.status === "closed" && (
              <p className="text-[10px] uppercase tracking-widest text-zinc-500">
                Opponent disconnected
              </p>
            )}
          </div>
        )}
      </div>

      {/* Netplay telemetry + camera */}
      <div className="flex h-[150px] shrink-0 border-t border-zinc-900 bg-black">
        <div className="relative aspect-[4/3] h-full shrink-0 bg-zinc-950">
          <canvas
            ref={canvasRef}
            className="h-full w-full object-contain"
            style={{ display: poseStatus === "ready" ? "block" : "none", transform: "scaleX(-1)" }}
          />
          {poseStatus !== "ready" && (
            <div className="absolute inset-0 flex items-center justify-center px-3">
              <p className="text-center text-[9px] uppercase tracking-widest text-zinc-700">
                {poseStatus === "error" ? "Camera unavailable — keys still work" : "Camera"}
              </p>
            </div>
          )}
        </div>

        <div className="flex flex-1 flex-col justify-center gap-1.5 px-6 font-mono text-[10px] text-zinc-500">
          <Row label="Status" value={net.status} />
          <Row label="Role" value={net.isHost ? "Host · Ryu (P1)" : "Guest · Ken (P2)"} />
          <Row label="Room" value={net.roomCode || "—"} />
          <Row label="Ping" value={`${net.rtt} ms`} />
          <Row label="Input delay" value={`${net.inputDelay} frames`} />
          <Row label="Rollbacks" value={String(net.rollbacks)} />
          <Row label="Stalls" value={String(net.stalls)} />
          {net.desynced && (
            <p className="text-red-500">DESYNC DETECTED — states have diverged</p>
          )}
        </div>
      </div>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <span className="w-24 shrink-0 uppercase tracking-widest text-zinc-700">{label}</span>
      <span className="text-zinc-400">{value}</span>
    </div>
  );
}
