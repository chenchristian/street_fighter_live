// ──────────────────────────────────────────────────────────────────────────────
// Netplay session: frame-stamped input exchange with input delay and rollback.
//
// Both peers run the same deterministic simulation. Only inputs are sent.
//
//   Input delay  Local input read on frame N is applied on frame N + delay,
//                which buys the network `delay` frames to deliver it. Enough
//                delay alone would be lockstep, and would stall on every
//                hiccup.
//
//   Rollback     When the remote input for a frame hasn't arrived, the frame is
//                simulated anyway using the peer's last known input. If the real
//                input turns out to differ, the sim rewinds to that frame and
//                re-runs it with the truth. Only the mispredicted span is
//                replayed, so a late packet costs CPU rather than a visible
//                stall.
// ──────────────────────────────────────────────────────────────────────────────

import type { CharState, GameState } from "../game/types";
import { decodeInput, type InputMessage } from "./protocol";
import { saveSnapshot, restoreSnapshot, checksum, type GameSnapshot } from "./snapshot";
import { tick } from "../game/match";

/** Frames the sim may be rewound. Beyond this a late packet is unrecoverable. */
export const MAX_ROLLBACK = 12;
/** Input frames resent with every packet, so a single drop doesn't stall. */
const REDUNDANCY = 6;

export interface SessionOptions {
  /** Host drives player 1 (left); guest drives player 2 (right). */
  isHost: boolean;
  inputDelay?: number;
  send: (msg: InputMessage) => void;
}

export interface SessionStats {
  frame: number;
  confirmedFrame: number;
  rollbacks: number;
  maxRollbackDepth: number;
  stalls: number;
  predictedFrames: number;
}

export class NetplaySession {
  readonly isHost: boolean;
  inputDelay: number;

  /** Frame the simulation has advanced to (next frame to run). */
  private frame = 0;
  /** Highest frame for which the real remote input is known. */
  private confirmed = -1;

  private local = new Map<number, number>();
  private remote = new Map<number, number>();
  /** What we actually fed the sim, so we can tell a misprediction from a match. */
  private used = new Map<number, number>();
  private snapshots = new Map<number, GameSnapshot>();

  private send: (msg: InputMessage) => void;
  private lastSentFrom = 0;

  stats: SessionStats = {
    frame: 0, confirmedFrame: -1, rollbacks: 0,
    maxRollbackDepth: 0, stalls: 0, predictedFrames: 0,
  };

  /** Set when the peers' checksums disagree — the games have diverged. */
  desyncedAt: number | null = null;

  constructor(opts: SessionOptions) {
    this.isHost = opts.isHost;
    this.inputDelay = opts.inputDelay ?? 3;
    this.send = opts.send;
  }

  getFrame(): number {
    return this.frame;
  }

  /** Record this client's input for the frame it will actually take effect on. */
  pushLocalInput(mask: number): void {
    const target = this.frame + this.inputDelay;
    this.local.set(target, mask);

    // Resend a short trailing window so one lost packet doesn't stall the peer.
    const from = Math.max(this.lastSentFrom, target - REDUNDANCY + 1);
    const masks: number[] = [];
    for (let f = from; f <= target; f++) masks.push(this.local.get(f) ?? 0);
    this.send({ t: "in", startFrame: from, masks });
    this.lastSentFrom = Math.max(0, target - REDUNDANCY + 1);
  }

  /** Ingest a peer packet. Returns the earliest frame whose input changed. */
  onRemoteInput(msg: InputMessage): number | null {
    let earliestChanged: number | null = null;
    for (let i = 0; i < msg.masks.length; i++) {
      const f = msg.startFrame + i;
      const mask = msg.masks[i];
      if (this.remote.has(f)) continue;
      this.remote.set(f, mask);
      if (f < this.frame && this.used.get(f) !== mask) {
        earliestChanged = earliestChanged === null ? f : Math.min(earliestChanged, f);
      }
    }
    // Advance the confirmed watermark over the contiguous known prefix.
    while (this.remote.has(this.confirmed + 1)) this.confirmed++;
    this.stats.confirmedFrame = this.confirmed;
    return earliestChanged;
  }

  /** Peer's input for a frame, or the prediction (repeat last known). */
  private remoteFor(frame: number): { mask: number; predicted: boolean } {
    const known = this.remote.get(frame);
    if (known !== undefined) return { mask: known, predicted: false };
    const last = this.confirmed >= 0 ? this.remote.get(this.confirmed) ?? 0 : 0;
    return { mask: last, predicted: true };
  }

  /**
   * Advance one frame, rolling back first if a correction arrived.
   *
   * Returns false when the frame could not be run — the peer is so far behind
   * that continuing would exceed the rollback window, so we stall instead of
   * diverging.
   */
  advance(g: GameState, stage: CharState, localMask: number): boolean {
    this.pushLocalInput(localMask);

    // Refuse to run further than we could ever rewind.
    if (this.frame - this.confirmed > MAX_ROLLBACK) {
      this.stats.stalls++;
      return false;
    }

    this.snapshots.set(this.frame, saveSnapshot(g));
    for (const f of this.snapshots.keys()) {
      if (f < this.frame - MAX_ROLLBACK) this.snapshots.delete(f);
    }

    this.simulateFrame(g, stage, this.frame);
    this.frame++;
    this.stats.frame = this.frame;
    return true;
  }

  /** Rewind to `toFrame` and replay up to the present with corrected inputs. */
  rollbackTo(g: GameState, stage: CharState, toFrame: number): void {
    const snap = this.snapshots.get(toFrame);
    if (!snap) return; // outside the window — nothing safe to do

    const target = this.frame;
    restoreSnapshot(g, snap);
    this.stats.rollbacks++;
    this.stats.maxRollbackDepth = Math.max(this.stats.maxRollbackDepth, target - toFrame);

    for (let f = toFrame; f < target; f++) {
      this.snapshots.set(f, saveSnapshot(g));
      this.simulateFrame(g, stage, f);
    }
  }

  private simulateFrame(g: GameState, stage: CharState, frame: number): void {
    const localMask = this.local.get(frame) ?? 0;
    const { mask: remoteMask, predicted } = this.remoteFor(frame);
    if (predicted) this.stats.predictedFrames++;
    this.used.set(frame, remoteMask);

    // Host is player 1 on both machines, so the same input always drives the
    // same fighter regardless of which side is running the simulation.
    const p1 = this.isHost ? localMask : remoteMask;
    const p2 = this.isHost ? remoteMask : localMask;

    tick(g, stage, {
      player: decodeInput(p1),
      cpu: decodeInput(p2),
    });

    // Old frames can never be rolled back to again.
    const cutoff = frame - MAX_ROLLBACK * 2;
    if (cutoff > 0) {
      this.local.delete(cutoff);
      this.remote.delete(cutoff);
      this.used.delete(cutoff);
    }
  }

  checksumAt(g: GameState): number {
    return checksum(g);
  }

  reset(): void {
    this.frame = 0;
    this.confirmed = -1;
    this.local.clear();
    this.remote.clear();
    this.used.clear();
    this.snapshots.clear();
    this.lastSentFrom = 0;
    this.desyncedAt = null;
    this.stats = {
      frame: 0, confirmedFrame: -1, rollbacks: 0,
      maxRollbackDepth: 0, stalls: 0, predictedFrames: 0,
    };
  }
}
