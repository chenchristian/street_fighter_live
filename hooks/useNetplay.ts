"use client";
// ──────────────────────────────────────────────────────────────────────────────
// Online versus: PeerJS transport + NetplaySession + the fixed-step clock.
// ──────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import type { CharData, CharState, GameState } from "@/lib/game/types";
import { createChar, normalizeCharData, objectRegistry } from "@/lib/game/engine";
import { createGame } from "@/lib/game/match";
import { FixedClock } from "@/lib/game/clock";
import { CvSource, KeyboardSource } from "@/lib/game/sources";
import { encodeInput, makeRoomCode, type NetMessage } from "@/lib/net/protocol";
import { PeerLink, suggestInputDelay, type ConnectionStatus } from "@/lib/net/peer";
import { NetplaySession } from "@/lib/net/session";
import { preloadFrom } from "@/lib/render/textures";
import type { PredictionState } from "./usePosePipeline";

async function loadCharData(url: string): Promise<CharData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
  return res.json();
}

/** How often the peers compare state hashes, in frames. */
const CHECKSUM_INTERVAL = 60;

export interface NetplayState {
  status: ConnectionStatus;
  detail: string;
  roomCode: string;
  isHost: boolean;
  rtt: number;
  inputDelay: number;
  rollbacks: number;
  stalls: number;
  desynced: boolean;
}

export function useNetplay(prediction: PredictionState | null, keyboardEnabled = true) {
  const [gameState, setGameState] = useState<GameState | null>(null);
  /** Sprite preload progress, 0..1. */
  const [loadProgress, setLoadProgress] = useState(0);
  const [net, setNet] = useState<NetplayState>({
    status: "idle", detail: "", roomCode: "", isHost: false,
    rtt: 0, inputDelay: 3, rollbacks: 0, stalls: 0, desynced: false,
  });

  const gameRef = useRef<GameState | null>(null);
  const stageRef = useRef<CharState | null>(null);
  const clockRef = useRef<FixedClock>(new FixedClock({ fps: 60 }));
  const linkRef = useRef<PeerLink | null>(null);
  const sessionRef = useRef<NetplaySession | null>(null);
  const cvRef = useRef<CvSource>(new CvSource());
  const kbRef = useRef<KeyboardSource>(new KeyboardSource());
  const kbEnabledRef = useRef(keyboardEnabled);
  /** Checksums we've sent, so an arriving peer checksum can be compared. */
  const ownChecksums = useRef(new Map<number, number>());

  useEffect(() => {
    kbEnabledRef.current = keyboardEnabled;
  }, [keyboardEnabled]);

  useEffect(() => {
    const kb = kbRef.current;
    kb.attach();
    return () => kb.detach();
  }, []);

  useEffect(() => {
    if (prediction) cvRef.current.setPrediction(prediction.label, prediction.direction);
  }, [prediction]);

  const startLoop = useCallback((isHost: boolean, seed: number, inputDelay: number) => {
    const session = new NetplaySession({
      isHost,
      inputDelay,
      send: msg => linkRef.current?.sendMessage(msg),
    });
    sessionRef.current = session;

    const g = gameRef.current!;
    const stage = stageRef.current!;

    clockRef.current.start(
      () => {
        const link = linkRef.current;
        if (!link?.isConnected) return;

        // Local input: CV drives the fighter, keyboard is the debug override.
        const cv = cvRef.current.read();
        let raw = cv.raw;
        if (kbEnabledRef.current) {
          const kb = kbRef.current.read();
          if (kb.dir[0] !== 0 || kb.dir[1] !== 0 || kb.buttons.some(Boolean)) raw = kb;
        }

        const ok = session.advance(g, stage, encodeInput(raw));
        if (!ok) return; // stalled waiting for the peer

        const frame = session.getFrame();
        if (frame % CHECKSUM_INTERVAL === 0) {
          const sum = session.checksumAt(g);
          ownChecksums.current.set(frame, sum);
          for (const f of ownChecksums.current.keys()) {
            if (f < frame - 600) ownChecksums.current.delete(f);
          }
          link.sendMessage({ t: "sync", frame, checksum: sum });
        }
      },
      () => {
        const cur = gameRef.current;
        if (cur) setGameState({ ...cur });
        const s = sessionRef.current;
        const link = linkRef.current;
        if (s && link) {
          setNet(n => ({
            ...n,
            rtt: link.rtt,
            rollbacks: s.stats.rollbacks,
            stalls: s.stats.stalls,
            desynced: s.desyncedAt !== null,
          }));
        }
      }
    );
  }, []);

  const loadAndStart = useCallback(
    async (isHost: boolean, seed: number, inputDelay: number) => {
      const [ryu, ken, training, hadouken, sparks] = await Promise.all(
        [
          loadCharData("/assets/objects/SF3/Ryu.json"),
          loadCharData("/assets/objects/SF3/Ken.json"),
          loadCharData("/assets/objects/Training.json"),
          loadCharData("/assets/objects/SF3/Hadouken.json"),
          loadCharData("/assets/objects/SF3/Sparks.json"),
        ].map(p => p.then(normalizeCharData))
      );
      objectRegistry.dict["SF3/Hadouken"] = hadouken;
      objectRegistry.dict["SF3/Sparks"] = sparks;

      // Same preload as the single-player path — a sprite that pops in mid-match
      // is worse online, where both peers are already fighting the clock.
      await preloadFrom(
        [ryu, ken, hadouken, sparks, training],
        (loaded, total) => setLoadProgress(total ? loaded / total : 1)
      );

      const stage = createChar(training, "stage", [0, 0], 1, 0, "Stand");
      stageRef.current = stage;

      const g = createGame({ playerData: ryu, cpuData: ken, stage }, seed);
      gameRef.current = g;
      setGameState({ ...g });
      cvRef.current.reset();

      startLoop(isHost, seed, inputDelay);
    },
    [startLoop]
  );

  const handleMessage = useCallback((msg: NetMessage) => {
    const link = linkRef.current;
    if (link?.handleTransportMessage(msg)) return;

    const session = sessionRef.current;
    const g = gameRef.current;
    const stage = stageRef.current;

    if (msg.t === "in" && session && g && stage) {
      const changedFrom = session.onRemoteInput(msg);
      // A misprediction: rewind to the first wrong frame and replay forward.
      if (changedFrom !== null) session.rollbackTo(g, stage, changedFrom);
      return;
    }

    if (msg.t === "sync" && session) {
      const own = ownChecksums.current.get(msg.frame);
      if (own !== undefined && own !== msg.checksum && session.desyncedAt === null) {
        session.desyncedAt = msg.frame;
      }
      return;
    }

    if (msg.t === "start") {
      // Guest adopts the host's seed and delay, then starts simulating.
      setNet(n => ({ ...n, inputDelay: msg.inputDelay }));
      void loadAndStart(false, msg.seed, msg.inputDelay);
    }
  }, [loadAndStart]);

  const onStatus = useCallback((status: ConnectionStatus, detail?: string) => {
    setNet(n => ({ ...n, status, detail: detail ?? "" }));
  }, []);

  const host = useCallback(async () => {
    const code = makeRoomCode();
    setNet(n => ({ ...n, roomCode: code, isHost: true }));
    const link = new PeerLink({ onMessage: handleMessage, onStatus });
    linkRef.current = link;
    await link.host(code);
  }, [handleMessage, onStatus]);

  const join = useCallback(
    async (code: string) => {
      setNet(n => ({ ...n, roomCode: code.toUpperCase(), isHost: false }));
      const link = new PeerLink({ onMessage: handleMessage, onStatus });
      linkRef.current = link;
      await link.join(code.toUpperCase());
    },
    [handleMessage, onStatus]
  );

  // Once connected, the host picks the seed and delay and tells the guest.
  useEffect(() => {
    if (net.status !== "connected" || !net.isHost || sessionRef.current) return;
    const link = linkRef.current;
    if (!link) return;
    // Give ping a moment to produce an RTT before choosing a delay.
    const t = setTimeout(() => {
      const seed = (Date.now() ^ 0x5f3759df) >>> 0;
      const delay = suggestInputDelay(link.rtt);
      setNet(n => ({ ...n, inputDelay: delay }));
      link.sendMessage({ t: "start", seed, inputDelay: delay });
      void loadAndStart(true, seed, delay);
    }, 1200);
    return () => clearTimeout(t);
  }, [net.status, net.isHost, loadAndStart]);

  useEffect(() => {
    const clock = clockRef.current;
    return () => {
      clock.stop();
      linkRef.current?.close();
    };
  }, []);

  return { gameState, net, host, join, loadProgress };
}
