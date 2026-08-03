// ──────────────────────────────────────────────────────────────────────────────
// Simulation snapshots for rollback.
//
// Rollback re-runs frames after a mispredicted remote input arrives, so it
// needs to rewind everything the simulation reads: every character's mutable
// runtime state, the object list, the input devices, and the RNG.
//
// Character `data` (the parsed JSON) is immutable and shared, so it is carried
// by reference. Everything else is copied.
// ──────────────────────────────────────────────────────────────────────────────

import type { CharData, CharState, GameState, BoxSet } from "../game/types";
import { InputDevice, type DeviceState } from "../game/input";
import { gameRng } from "../game/rng";
import { objectRegistry } from "../game/engine";

interface CharSnapshot {
  data: CharData;
  name: string;
  team: number;
  type: string;
  killed: boolean;
  timekill: boolean | number;
  pos: [number, number, number];
  speed: [number, number];
  acceleration: [number, number];
  conSpeed: [number, number];
  face: number;
  fet: "grounded" | "airborne";
  airTime: number;
  currentState: string;
  frame: [number, number];
  cancel: (string | number | null)[];
  bufferState: Record<string, number>;
  commandIndexTimer: Record<string, [number, number][]>;
  currentCommand: (string | number)[];
  kara: number;
  repeat: number;
  hitstop: number;
  hitstun: number;
  ignoreStop: boolean;
  holdOnStun: boolean;
  wallbounce: boolean;
  juggle: number;
  damageScaling: [number, number];
  lastDamage: [number, number];
  combo: number;
  comboList: unknown[];
  parry: [string, number];
  guard: string[];
  gauges: Record<string, number>;
  boxes: Record<string, BoxSet>;
  image: string;
  imageSize: [number, number, number];
  imageOffset: [number, number, number];
  imageMirror: [boolean, boolean];
  imageTint: [number, number, number, number];
  imageAngle: [number, number, number];
  imageRepeat: boolean;
  imageGlow: number;
  drawTextures: unknown[];
  inputCurrentInput: string[];
  inputInterPress: boolean;
  // Cross-object links, stored as indices into the snapshot's char array.
  selfIdx: number;
  otherIdx: number;
  grabedIdx: number;
  influenceIdx: number;
  device: DeviceState | null;
}

export interface GameSnapshot {
  chars: CharSnapshot[];
  playerIdx: number;
  cpuIdx: number;
  phase: GameState["phase"];
  frameCount: number;
  phaseTimer: number;
  roundTimer: number;
  round: number;
  roundsWon: [number, number];
  roundWinner: GameState["roundWinner"];
  winner: GameState["winner"];
  announcer: string;
  combo: GameState["combo"];
  rng: number;
}

function cloneBoxes(boxes: Record<string, BoxSet>): Record<string, BoxSet> {
  const out: Record<string, BoxSet> = {};
  // Shallow-copy each set: `hitset` is mutated in place when a hit connects, so
  // sharing the object with the character data would leak across a rewind.
  for (const k in boxes) out[k] = { ...boxes[k] };
  return out;
}

function cloneCommandTimers(
  t: Record<string, [number, number][]>
): Record<string, [number, number][]> {
  const out: Record<string, [number, number][]> = {};
  for (const k in t) out[k] = t[k].map(p => [p[0], p[1]] as [number, number]);
  return out;
}

export function saveSnapshot(g: GameState): GameSnapshot {
  const idx = new Map<CharState, number>();
  g.objects.forEach((o, i) => idx.set(o, i));
  const ref = (c: CharState | null) => (c && idx.has(c) ? idx.get(c)! : -1);

  return {
    chars: g.objects.map(c => ({
      data: c.data,
      name: c.name,
      team: c.team,
      type: c.type,
      killed: c.killed,
      timekill: c.timekill,
      pos: [...c.pos] as [number, number, number],
      speed: [...c.speed] as [number, number],
      acceleration: [...c.acceleration] as [number, number],
      conSpeed: [...c.conSpeed] as [number, number],
      face: c.face,
      fet: c.fet,
      airTime: c.airTime,
      currentState: c.currentState,
      frame: [...c.frame] as [number, number],
      cancel: [...c.cancel],
      bufferState: { ...c.bufferState },
      commandIndexTimer: cloneCommandTimers(c.commandIndexTimer),
      currentCommand: [...c.currentCommand],
      kara: c.kara,
      repeat: c.repeat,
      hitstop: c.hitstop,
      hitstun: c.hitstun,
      ignoreStop: c.ignoreStop,
      holdOnStun: c.holdOnStun,
      wallbounce: c.wallbounce,
      juggle: c.juggle,
      damageScaling: [...c.damageScaling] as [number, number],
      lastDamage: [...c.lastDamage] as [number, number],
      combo: c.combo,
      comboList: [...c.comboList],
      parry: [...c.parry] as [string, number],
      guard: [...c.guard],
      gauges: { ...c.gauges },
      boxes: cloneBoxes(c.boxes as Record<string, BoxSet>),
      image: c.image,
      imageSize: [...c.imageSize] as [number, number, number],
      imageOffset: [...c.imageOffset] as [number, number, number],
      imageMirror: [...c.imageMirror] as [boolean, boolean],
      imageTint: [...c.imageTint] as [number, number, number, number],
      imageAngle: [...c.imageAngle] as [number, number, number],
      imageRepeat: c.imageRepeat,
      imageGlow: c.imageGlow,
      drawTextures: [...c.drawTextures],
      inputCurrentInput: [...c.inputCurrentInput],
      inputInterPress: c.inputInterPress,
      selfIdx: ref(c.selfMainObject),
      otherIdx: ref(c.otherMainObject),
      grabedIdx: ref(c.grabed),
      influenceIdx: ref(c.influenceObject),
      device: c.device ? c.device.save() : null,
    })),
    playerIdx: ref(g.player),
    cpuIdx: ref(g.cpu),
    phase: g.phase,
    frameCount: g.frameCount,
    phaseTimer: g.phaseTimer,
    roundTimer: g.roundTimer,
    round: g.round,
    roundsWon: [...g.roundsWon] as [number, number],
    roundWinner: g.roundWinner,
    winner: g.winner,
    announcer: g.announcer,
    combo: g.combo ? { ...g.combo } : null,
    rng: gameRng.save(),
  };
}

/**
 * Restore into `g` in place.
 *
 * The player and CPU objects keep their identity so anything already holding a
 * reference to them stays valid; transient objects (projectiles, sparks) are
 * rebuilt from the snapshot.
 */
export function restoreSnapshot(g: GameState, snap: GameSnapshot): void {
  const chars: CharState[] = [];

  for (let i = 0; i < snap.chars.length; i++) {
    // Reuse the live player/cpu objects; allocate for everything else.
    let target: CharState;
    if (i === snap.playerIdx) target = g.player;
    else if (i === snap.cpuIdx) target = g.cpu;
    else target = {} as CharState;
    chars.push(target);
  }

  for (let i = 0; i < snap.chars.length; i++) {
    const s = snap.chars[i];
    const c = chars[i];
    c.data = s.data;
    c.name = s.name;
    c.team = s.team;
    c.type = s.type;
    c.killed = s.killed;
    c.timekill = s.timekill;
    c.pos = [...s.pos] as [number, number, number];
    c.speed = [...s.speed] as [number, number];
    c.acceleration = [...s.acceleration] as [number, number];
    c.conSpeed = [...s.conSpeed] as [number, number];
    c.face = s.face;
    c.fet = s.fet;
    c.airTime = s.airTime;
    c.currentState = s.currentState;
    c.frame = [...s.frame] as [number, number];
    c.cancel = [...s.cancel];
    c.bufferState = { ...s.bufferState };
    c.commandIndexTimer = cloneCommandTimers(s.commandIndexTimer);
    c.currentCommand = [...s.currentCommand];
    c.kara = s.kara;
    c.repeat = s.repeat;
    c.hitstop = s.hitstop;
    c.hitstun = s.hitstun;
    c.ignoreStop = s.ignoreStop;
    c.holdOnStun = s.holdOnStun;
    c.wallbounce = s.wallbounce;
    c.juggle = s.juggle;
    c.damageScaling = [...s.damageScaling] as [number, number];
    c.lastDamage = [...s.lastDamage] as [number, number];
    c.combo = s.combo;
    c.comboList = [...s.comboList];
    c.parry = [...s.parry] as [string, number];
    c.guard = [...s.guard];
    c.gauges = { ...s.gauges };
    c.boxes = cloneBoxes(s.boxes);
    c.image = s.image;
    c.imageSize = [...s.imageSize] as [number, number, number];
    c.imageOffset = [...s.imageOffset] as [number, number, number];
    c.imageMirror = [...s.imageMirror] as [boolean, boolean];
    c.imageTint = [...s.imageTint] as [number, number, number, number];
    c.imageAngle = [...s.imageAngle] as [number, number, number];
    c.imageRepeat = s.imageRepeat;
    c.imageGlow = s.imageGlow;
    c.drawTextures = s.drawTextures as CharState["drawTextures"];
    c.inputCurrentInput = [...s.inputCurrentInput];
    c.inputInterPress = s.inputInterPress;
    c.selfMainObject = s.selfIdx >= 0 ? chars[s.selfIdx] : null;
    c.otherMainObject = s.otherIdx >= 0 ? chars[s.otherIdx] : null;
    c.grabed = s.grabedIdx >= 0 ? chars[s.grabedIdx] : null;
    c.influenceObject = s.influenceIdx >= 0 ? chars[s.influenceIdx] : null;
    if (s.device) {
      if (!c.device) c.device = new InputDevice();
      c.device.restore(s.device);
    } else {
      c.device = null;
    }
  }

  g.objects = chars;
  g.phase = snap.phase;
  g.frameCount = snap.frameCount;
  g.phaseTimer = snap.phaseTimer;
  g.roundTimer = snap.roundTimer;
  g.round = snap.round;
  g.roundsWon = [...snap.roundsWon] as [number, number];
  g.roundWinner = snap.roundWinner;
  g.winner = snap.winner;
  g.announcer = snap.announcer;
  g.combo = snap.combo ? { ...snap.combo } : null;
  gameRng.restore(snap.rng);

  // Anything queued by the frames being discarded must not survive the rewind.
  objectRegistry.spawnQueue.length = 0;
}

/**
 * Cheap checksum over the state that matters for divergence.
 *
 * Exchanged periodically so a desync surfaces as a reported error instead of
 * two players quietly playing different games.
 */
export function checksum(g: GameState): number {
  let h = 2166136261;
  const mix = (n: number) => {
    h ^= Math.round(n * 100) | 0;
    h = Math.imul(h, 16777619);
  };
  for (const c of g.objects) {
    mix(c.pos[0]);
    mix(c.pos[1]);
    mix(c.speed[0]);
    mix(c.speed[1]);
    mix(c.face);
    mix(c.frame[0]);
    mix(c.frame[1]);
    mix(c.hitstop);
    mix(c.hitstun);
    for (const g2 in c.gauges) mix(c.gauges[g2]);
    for (let i = 0; i < c.currentState.length; i++) mix(c.currentState.charCodeAt(i));
  }
  mix(g.roundTimer);
  mix(g.frameCount);
  return h >>> 0;
}
