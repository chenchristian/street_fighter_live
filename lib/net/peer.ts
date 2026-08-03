// ──────────────────────────────────────────────────────────────────────────────
// PeerJS transport.
//
// Signalling runs through the public PeerJS broker; once the offer/answer is
// exchanged the data channel is direct peer-to-peer. The channel is opened
// unreliable + unordered on purpose: a fighting game must never wait for a
// retransmit, and every packet already carries a trailing window of input
// frames, so a dropped one is covered by the next.
// ──────────────────────────────────────────────────────────────────────────────

import type { DataConnection, Peer } from "peerjs";
import { PEER_PREFIX, type NetMessage } from "./protocol";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "waiting"
  | "connected"
  | "closed"
  | "error";

export interface PeerHandlers {
  onMessage: (msg: NetMessage) => void;
  onStatus: (status: ConnectionStatus, detail?: string) => void;
}

export class PeerLink {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private handlers: PeerHandlers;
  /** Round-trip time in ms, from periodic pings. */
  rtt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(handlers: PeerHandlers) {
    this.handlers = handlers;
  }

  private async createPeer(id?: string): Promise<Peer> {
    const { default: PeerCtor } = await import("peerjs");
    return new PeerCtor(id as string, {
      // Unreliable ordering is configured per-connection below; this is just
      // the signalling config.
      debug: 0,
    });
  }

  /** Open a room and wait for the other player. Resolves with the room code. */
  async host(roomCode: string): Promise<void> {
    this.handlers.onStatus("connecting");
    const peer = await this.createPeer(PEER_PREFIX + roomCode);
    this.peer = peer;

    peer.on("open", () => this.handlers.onStatus("waiting", roomCode));
    peer.on("error", e => this.handlers.onStatus("error", String(e?.message ?? e)));
    peer.on("connection", c => {
      // Reject a second joiner rather than silently corrupting the match.
      if (this.conn) { c.close(); return; }
      this.attach(c);
    });
  }

  /** Join an existing room. */
  async join(roomCode: string): Promise<void> {
    this.handlers.onStatus("connecting");
    const peer = await this.createPeer();
    this.peer = peer;

    peer.on("error", e => this.handlers.onStatus("error", String(e?.message ?? e)));
    peer.on("open", () => {
      const c = peer.connect(PEER_PREFIX + roomCode, {
        reliable: false,
        serialization: "json",
      });
      this.attach(c);
    });
  }

  private attach(conn: DataConnection): void {
    this.conn = conn;
    conn.on("open", () => {
      this.handlers.onStatus("connected");
      this.startPing();
    });
    conn.on("data", d => this.handlers.onMessage(d as NetMessage));
    conn.on("close", () => {
      this.stopPing();
      this.handlers.onStatus("closed");
    });
    conn.on("error", e => this.handlers.onStatus("error", String(e?.message ?? e)));
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.sendMessage({ t: "ping", sent: Date.now() });
    }, 1000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** Handle transport-level messages; returns true if fully consumed. */
  handleTransportMessage(msg: NetMessage): boolean {
    if (msg.t === "ping") {
      this.sendMessage({ t: "pong", sent: msg.sent });
      return true;
    }
    if (msg.t === "pong") {
      this.rtt = Date.now() - msg.sent;
      return true;
    }
    return false;
  }

  sendMessage(msg: NetMessage): void {
    if (this.conn?.open) {
      try {
        this.conn.send(msg);
      } catch {
        // A dropped send is survivable: input packets carry a trailing window.
      }
    }
  }

  get isConnected(): boolean {
    return !!this.conn?.open;
  }

  close(): void {
    this.stopPing();
    this.conn?.close();
    this.peer?.destroy();
    this.conn = null;
    this.peer = null;
  }
}

/** Suggest an input delay from measured RTT — half the trip, in frames, plus one. */
export function suggestInputDelay(rttMs: number): number {
  const oneWayFrames = Math.ceil(rttMs / 2 / (1000 / 60));
  return Math.max(2, Math.min(8, oneWayFrames + 1));
}
