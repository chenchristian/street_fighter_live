// ──────────────────────────────────────────────────────────────────────────────
// Wire protocol for 2-player netplay.
//
// Only inputs cross the wire, never game state: both peers run the identical
// deterministic simulation over the identical input stream. One input frame is
// a 16-bit mask, so a full second of input for one player is 120 bytes.
// ──────────────────────────────────────────────────────────────────────────────

import { BUTTON_COUNT, emptyRawInput, type RawInput } from "../game/input";

// Bit layout:
//   0..3   direction  (up, down, left, right)
//   4..9   buttons 1..6
const BIT_UP = 1 << 0;
const BIT_DOWN = 1 << 1;
const BIT_LEFT = 1 << 2;
const BIT_RIGHT = 1 << 3;
const BUTTON_SHIFT = 4;

export function encodeInput(raw: RawInput): number {
  let mask = 0;
  if (raw.dir[1] > 0) mask |= BIT_UP;
  if (raw.dir[1] < 0) mask |= BIT_DOWN;
  if (raw.dir[0] < 0) mask |= BIT_LEFT;
  if (raw.dir[0] > 0) mask |= BIT_RIGHT;
  for (let i = 1; i <= BUTTON_COUNT; i++) {
    if (raw.buttons[i]) mask |= 1 << (BUTTON_SHIFT + i - 1);
  }
  return mask;
}

export function decodeInput(mask: number): RawInput {
  const raw = emptyRawInput();
  raw.dir[1] = mask & BIT_UP ? 1 : mask & BIT_DOWN ? -1 : 0;
  raw.dir[0] = mask & BIT_RIGHT ? 1 : mask & BIT_LEFT ? -1 : 0;
  for (let i = 1; i <= BUTTON_COUNT; i++) {
    raw.buttons[i] = (mask & (1 << (BUTTON_SHIFT + i - 1))) !== 0;
  }
  return raw;
}

// ─── Messages ─────────────────────────────────────────────────────────────────

/** Frame-stamped inputs. `masks[i]` is the input for frame `startFrame + i`. */
export interface InputMessage {
  t: "in";
  startFrame: number;
  masks: number[];
}

/** Periodic state hash so a desync is detected rather than silently diverging. */
export interface SyncMessage {
  t: "sync";
  frame: number;
  checksum: number;
}

/** Handshake: agrees the seed and who is player 1. */
export interface StartMessage {
  t: "start";
  seed: number;
  inputDelay: number;
}

/** Guest -> host: "I'm connected, send me the match parameters." */
export interface HelloMessage {
  t: "hello";
}

/** Either way: "my sprites are loaded, I can start simulating." */
export interface ReadyMessage {
  t: "ready";
}

export interface PingMessage {
  t: "ping";
  sent: number;
}

export interface PongMessage {
  t: "pong";
  sent: number;
}

export type NetMessage =
  | InputMessage
  | SyncMessage
  | StartMessage
  | HelloMessage
  | ReadyMessage
  | PingMessage
  | PongMessage;

/** Room codes are short and human-shareable; PeerJS ids get a fixed prefix. */
export const PEER_PREFIX = "sflive-";

export function makeRoomCode(): string {
  // Ambiguous characters removed so codes can be read aloud.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}
