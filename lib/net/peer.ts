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

/**
 * ICE servers, ordered cheapest path first.
 *
 * PeerJS's defaults are STUN plus TURN on UDP 3478, which is fine at home and
 * useless on a locked-down network. Hotel and conference wifi typically does
 * all three of: isolate clients from each other so no direct path exists at
 * all, use symmetric NAT so hole-punching fails, and allow only TCP 80/443.
 *
 * The entries that actually rescue those cases are the TURN relays on port 443
 * — and especially `?transport=tcp`, which is indistinguishable from ordinary
 * HTTPS and therefore survives almost any firewall. They are last because relay
 * costs latency; ICE only falls back to them when nothing better works.
 *
 * Relayed traffic passes through a third party, so it is worth being clear what
 * that is: 16-bit input bitmasks, DTLS-encrypted, no video and no personal data.
 * The webcam feed never leaves the device — only the classified move does.
 */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
  // PeerJS's own relays (UDP only).
  {
    urls: ["turn:eu-0.turn.peerjs.com:3478", "turn:us-0.turn.peerjs.com:3478"],
    username: "peerjs",
    credential: "peerjsp",
  },
  // Open relay project — the important one: port 80, 443, and TCP/443.
  {
    urls: [
      "turn:openrelay.metered.ca:80",
      "turn:openrelay.metered.ca:443",
      "turn:openrelay.metered.ca:443?transport=tcp",
    ],
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

/** How the media path was finally established. */
export type IceRoute = "direct" | "relay" | null;

export class PeerLink {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private handlers: PeerHandlers;
  /** Round-trip time in ms, from periodic pings. */
  rtt = 0;
  /** Raw ICE state — "checking", "connected", "failed"… */
  iceState = "new";
  /** Whether the final path is peer-to-peer or through a TURN relay. */
  route: IceRoute = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(handlers: PeerHandlers) {
    this.handlers = handlers;
  }

  private async createPeer(id?: string): Promise<Peer> {
    const { default: PeerCtor } = await import("peerjs");
    return new PeerCtor(id as string, {
      // Unreliable ordering is configured per-connection below; this is just
      // the signalling config.
      debug: 0,
      config: { iceServers: ICE_SERVERS },
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

  /**
   * Watch the underlying ICE agent.
   *
   * Without this a failed connection is indistinguishable from a slow one:
   * PeerJS reports nothing until it gives up, so a restrictive network looks
   * like the app hanging. `failed` here is the signature of a network that
   * blocks both direct paths and relays.
   */
  private watchIce(conn: DataConnection): void {
    const pc = (conn as unknown as { peerConnection?: RTCPeerConnection }).peerConnection;
    if (!pc) return;

    const report = () => {
      this.iceState = pc.iceConnectionState;
      if (pc.iceConnectionState === "failed") {
        this.handlers.onStatus(
          "error",
          "No network path to the other player. This network is blocking peer-to-peer."
        );
      }
    };
    pc.addEventListener("iceconnectionstatechange", report);
    report();

    // Which candidate pair won tells us whether we went direct or via relay.
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = setInterval(async () => {
      if (!pc || pc.iceConnectionState === "closed") return;
      try {
        const stats = await pc.getStats();
        stats.forEach(r => {
          if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated) {
            const local = stats.get(r.localCandidateId) as { candidateType?: string } | undefined;
            const remote = stats.get(r.remoteCandidateId) as { candidateType?: string } | undefined;
            this.route =
              local?.candidateType === "relay" || remote?.candidateType === "relay"
                ? "relay"
                : "direct";
          }
        });
      } catch {
        // Stats are best-effort diagnostics; never let them break the match.
      }
    }, 2000);
  }

  private attach(conn: DataConnection): void {
    this.conn = conn;
    this.watchIce(conn);
    conn.on("open", () => {
      this.watchIce(conn);
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
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
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
