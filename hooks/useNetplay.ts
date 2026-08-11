"use client";
// ──────────────────────────────────────────────────────────────────────────────
// Online versus: PeerJS transport + NetplaySession + the fixed-step clock.
//
// Startup is a three-step handshake, because both halves of it turned out to be
// failure points in the field:
//
//   hello  guest -> host, repeated until answered. The data channel is
//          unreliable by design (a fighting game must never wait for a
//          retransmit), so a one-shot `start` can simply be dropped and the
//          guest would wait forever.
//   start  host -> guest, carrying the seed and input delay. Re-sent on every
//          hello, always with the same seed.
//   ready  both ways, once sprites are loaded. Neither side starts its clock
//          until both are ready — otherwise the faster machine runs ahead,
//          hits the rollback ceiling and freezes mid-intro waiting for inputs
//          from a peer that is still downloading.
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
/** Retry cadence for hello / ready. */
const HANDSHAKE_RETRY_MS = 500;
/** Host waits this long after connecting so ping has an RTT to work from. */
const SEED_DELAY_MS = 800;

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
  /** This client has loaded and is ready to simulate. */
  selfReady: boolean;
  /** The peer has told us it is ready. */
  peerReady: boolean;
  /** True once the clock is running. */
  running: boolean;
  /** Raw ICE state, so a blocked network is diagnosable. */
  iceState: string;
  /** "direct" peer-to-peer, or "relay" through TURN. */
  route: "direct" | "relay" | null;
}

const INITIAL: NetplayState = {
  status: "idle", detail: "", roomCode: "", isHost: false,
  rtt: 0, inputDelay: 3, rollbacks: 0, stalls: 0, desynced: false,
  selfReady: false, peerReady: false, running: false,
  iceState: "new", route: null,
};

export function useNetplay(prediction: PredictionState | null, keyboardEnabled = true) {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [net, setNet] = useState<NetplayState>(INITIAL);
  const [loadProgress, setLoadProgress] = useState(0);

  const gameRef = useRef<GameState | null>(null);
  const stageRef = useRef<CharState | null>(null);
  const clockRef = useRef<FixedClock>(new FixedClock({ fps: 60 }));
  const linkRef = useRef<PeerLink | null>(null);
  const sessionRef = useRef<NetplaySession | null>(null);
  const cvRef = useRef<CvSource>(new CvSource());
  const kbRef = useRef<KeyboardSource>(new KeyboardSource());
  const kbEnabledRef = useRef(keyboardEnabled);
  const ownChecksums = useRef(new Map<number, number>());

  // Handshake state. Refs rather than state: these are read from message
  // handlers and timers, where a stale closure would deadlock the startup.
  const isHostRef = useRef(false);
  const matchRef = useRef<{ seed: number; inputDelay: number } | null>(null);
  const selfReady = useRef(false);
  const peerReady = useRef(false);
  const clockStarted = useRef(false);
  const loadingStarted = useRef(false);
  const helloTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const readyTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { kbEnabledRef.current = keyboardEnabled; }, [keyboardEnabled]);

  useEffect(() => {
    const kb = kbRef.current;
    kb.attach();
    return () => kb.detach();
  }, []);

  useEffect(() => {
    if (prediction) cvRef.current.setPrediction(prediction.label, prediction.direction, prediction.jump);
  }, [prediction]);

  const stopTimer = (ref: React.RefObject<ReturnType<typeof setInterval> | null>) => {
    if (ref.current) clearInterval(ref.current);
    ref.current = null;
  };

  // ── Clock ──
  const startLoop = useCallback(() => {
    if (clockStarted.current) return;
    const match = matchRef.current;
    const g = gameRef.current;
    const stage = stageRef.current;
    if (!match || !g || !stage) return;
    clockStarted.current = true;
    stopTimer(readyTimer);
    setNet(n => ({ ...n, running: true }));

    const session = new NetplaySession({
      isHost: isHostRef.current,
      inputDelay: match.inputDelay,
      send: msg => linkRef.current?.sendMessage(msg),
    });
    sessionRef.current = session;

    clockRef.current.start(
      () => {
        const link = linkRef.current;
        if (!link?.isConnected) return;

        // Local player is p1 when hosting, p2 when joining; its grounded state
        // re-arms the jump.
        const localChar = isHostRef.current ? g.player : g.cpu;
        const cv = cvRef.current.read(localChar.fet === "grounded");
        let raw = cv.raw;
        if (kbEnabledRef.current) {
          const kb = kbRef.current.read();
          if (kb.dir[0] !== 0 || kb.dir[1] !== 0 || kb.buttons.some(Boolean)) raw = kb;
        }

        if (!session.advance(g, stage, encodeInput(raw))) return; // stalled

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
            iceState: link.iceState,
            route: link.route,
          }));
        }
      }
    );
  }, []);

  const maybeStart = useCallback(() => {
    if (selfReady.current && peerReady.current) startLoop();
  }, [startLoop]);

  // ── Load assets, then announce readiness ──
  const beginLoad = useCallback(async () => {
    if (loadingStarted.current) return;
    loadingStarted.current = true;
    const match = matchRef.current;
    if (!match) return;

    try {
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

      await preloadFrom(
        [ryu, ken, hadouken, sparks, training],
        (loaded, total) => setLoadProgress(total ? loaded / total : 1)
      );

      const stage = createChar(training, "stage", [0, 0], 1, 0, "Stand");
      stageRef.current = stage;

      const g = createGame({ playerData: ryu, cpuData: ken, stage }, match.seed);
      gameRef.current = g;
      setGameState({ ...g });
      cvRef.current.reset();

      selfReady.current = true;
      setNet(n => ({ ...n, selfReady: true }));

      // Announce, and keep announcing until the peer's own ready arrives —
      // a dropped ready would otherwise leave both sides waiting on each other.
      linkRef.current?.sendMessage({ t: "ready" });
      stopTimer(readyTimer);
      readyTimer.current = setInterval(() => {
        if (peerReady.current) { stopTimer(readyTimer); return; }
        linkRef.current?.sendMessage({ t: "ready" });
      }, HANDSHAKE_RETRY_MS);

      maybeStart();
    } catch (e) {
      setNet(n => ({
        ...n,
        status: "error",
        detail: e instanceof Error ? e.message : "Failed to load assets",
      }));
    }
  }, [maybeStart]);

  // ── Messages ──
  const handleMessage = useCallback((msg: NetMessage) => {
    const link = linkRef.current;
    if (link?.handleTransportMessage(msg)) return;

    switch (msg.t) {
      case "hello": {
        // Host only. Answer every hello with the same parameters, so a lost
        // start is simply re-requested.
        const match = matchRef.current;
        if (isHostRef.current && match) {
          link?.sendMessage({ t: "start", seed: match.seed, inputDelay: match.inputDelay });
        }
        // A peer that is saying hello has clearly not loaded yet.
        break;
      }

      case "start": {
        if (isHostRef.current || matchRef.current) return; // guest, once
        stopTimer(helloTimer);
        matchRef.current = { seed: msg.seed, inputDelay: msg.inputDelay };
        setNet(n => ({ ...n, inputDelay: msg.inputDelay }));
        void beginLoad();
        break;
      }

      case "ready": {
        if (!peerReady.current) {
          peerReady.current = true;
          setNet(n => ({ ...n, peerReady: true }));
        }
        // Our own ready may have been the one that was lost; answer so the peer
        // stops waiting on us.
        if (selfReady.current) link?.sendMessage({ t: "ready" });
        maybeStart();
        break;
      }

      case "in": {
        const session = sessionRef.current;
        const g = gameRef.current;
        const stage = stageRef.current;
        if (!session || !g || !stage) return;
        const changedFrom = session.onRemoteInput(msg);
        if (changedFrom !== null) session.rollbackTo(g, stage, changedFrom);
        break;
      }

      case "sync": {
        const session = sessionRef.current;
        if (!session) return;
        const own = ownChecksums.current.get(msg.frame);
        if (own !== undefined && own !== msg.checksum && session.desyncedAt === null) {
          session.desyncedAt = msg.frame;
        }
        break;
      }
    }
  }, [beginLoad, maybeStart]);

  const onStatus = useCallback((status: ConnectionStatus, detail?: string) => {
    setNet(n => ({ ...n, status, detail: detail ?? "" }));

    if (status !== "connected") {
      if (status === "closed" || status === "error") {
        stopTimer(helloTimer);
        stopTimer(readyTimer);
      }
      return;
    }

    if (isHostRef.current) {
      // Pick the seed once, after ping has had a moment to measure RTT.
      setTimeout(() => {
        if (matchRef.current) return;
        const link = linkRef.current;
        const inputDelay = suggestInputDelay(link?.rtt ?? 0);
        matchRef.current = { seed: (Date.now() ^ 0x5f3759df) >>> 0, inputDelay };
        setNet(n => ({ ...n, inputDelay }));
        link?.sendMessage({
          t: "start", seed: matchRef.current.seed, inputDelay,
        });
        void beginLoad();
      }, SEED_DELAY_MS);
    } else {
      // Ask until answered.
      stopTimer(helloTimer);
      linkRef.current?.sendMessage({ t: "hello" });
      helloTimer.current = setInterval(() => {
        if (matchRef.current) { stopTimer(helloTimer); return; }
        linkRef.current?.sendMessage({ t: "hello" });
      }, HANDSHAKE_RETRY_MS);
    }
  }, [beginLoad]);

  // ── Entry points ──
  const host = useCallback(async () => {
    isHostRef.current = true;
    const code = makeRoomCode();
    setNet(n => ({ ...n, roomCode: code, isHost: true }));
    const link = new PeerLink({ onMessage: handleMessage, onStatus });
    linkRef.current = link;
    await link.host(code);
  }, [handleMessage, onStatus]);

  const join = useCallback(async (code: string) => {
    isHostRef.current = false;
    setNet(n => ({ ...n, roomCode: code.toUpperCase(), isHost: false }));
    const link = new PeerLink({ onMessage: handleMessage, onStatus });
    linkRef.current = link;
    await link.join(code.toUpperCase());
  }, [handleMessage, onStatus]);

  // Poll the transport during the handshake too — the match may never start,
  // and that is exactly when knowing the ICE state matters most.
  useEffect(() => {
    const id = setInterval(() => {
      const link = linkRef.current;
      if (!link) return;
      setNet(n =>
        n.iceState === link.iceState && n.route === link.route && n.rtt === link.rtt
          ? n
          : { ...n, iceState: link.iceState, route: link.route, rtt: link.rtt }
      );
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const clock = clockRef.current;
    return () => {
      clock.stop();
      linkRef.current?.close();
      if (helloTimer.current) clearInterval(helloTimer.current);
      if (readyTimer.current) clearInterval(readyTimer.current);
    };
  }, []);

  return { gameState, net, host, join, loadProgress };
}
