// ──────────────────────────────────────────────────────────────────────────────
// Match loop: one tick of simulation, plus the round/announcer state machine.
//
// Framework-free on purpose — the React hook and the netplay driver both call
// tick() and neither needs to know about the other.
// ──────────────────────────────────────────────────────────────────────────────

import type { CharData, CharState, GameState } from "./types";
import { createChar, updateChar, objectRegistry } from "./engine";
import { runCollisions } from "./collision";
import { InputDevice, emptyRawInput, type RawInput } from "./input";
import { gameRng } from "./rng";
import { TUNING } from "@/lib/tuning";

export const ROUND_TIMER_FRAMES = 60 * TUNING.match.roundSeconds;
export const ROUNDS_TO_WIN = TUNING.match.roundsToWin;

// Announcer beats, in frames at 60fps
const INTRO_ROUND_FRAMES = 90;   // "ROUND n"
const INTRO_FIGHT_FRAMES = 60;   // "FIGHT!"
const ROUND_END_FRAMES   = 180;  // knockdown plays out under "KO!"
const MATCH_END_FRAMES   = 240;

const SPAWN_X = TUNING.match.startDistance;

export interface TickInputs {
  player: RawInput;
  cpu: RawInput;
  /** Macro tokens injected verbatim, e.g. ["QCF"] from a classified CV pose. */
  playerCommands?: string[];
  cpuCommands?: string[];
}

export interface MatchChars {
  playerData: CharData;
  cpuData: CharData;
  stage: CharState;
}

export function createGame(chars: MatchChars, seed = Date.now()): GameState {
  gameRng.restore(seed);
  objectRegistry.spawnQueue.length = 0;

  const player = createChar(chars.playerData, chars.playerData.name, [-SPAWN_X, 0], 1, 1, "Stand");
  const cpu = createChar(chars.cpuData, chars.cpuData.name, [SPAWN_X, 0], -1, 2, "Stand");

  player.selfMainObject = player;
  player.otherMainObject = cpu;
  cpu.selfMainObject = cpu;
  cpu.otherMainObject = player;

  player.device = new InputDevice();
  cpu.device = new InputDevice();

  const bb = chars.stage.boxes["boundingbox"]?.boxes?.[0];
  const stageBounds: [number, number] = bb ? [bb[0], bb[0] + bb[2]] : [-1300, 1300];

  return {
    player,
    cpu,
    objects: [player, cpu],
    phase: "intro",
    frameCount: 0,
    phaseTimer: INTRO_ROUND_FRAMES + INTRO_FIGHT_FRAMES,
    roundTimer: ROUND_TIMER_FRAMES,
    round: 1,
    roundsWon: [0, 0],
    roundWinner: null,
    winner: null,
    announcer: "ROUND 1",
    combo: null,
    stageBounds,
  };
}

/** Reset both fighters to their corners for the next round, keeping match score. */
export function startRound(g: GameState): void {
  const reset = (c: CharState, x: number, face: number) => {
    c.pos = [x, 0, 0];
    c.speed = [0, 0];
    c.acceleration = [0, 0];
    c.conSpeed = [0, 0];
    c.face = face;
    c.fet = "grounded";
    c.hitstop = 0;
    c.hitstun = 0;
    c.juggle = 100;
    c.combo = 0;
    c.comboList = [];
    c.damageScaling = [100, 100];
    c.grabed = null;
    c.influenceObject = null;
    c.wallbounce = false;
    c.parry = ["", 0];
    c.guard = [];
    c.currentCommand = [];
    c.bufferState = {};
    c.cancel = [null];
    c.killed = false;
    c.device?.reset();
    for (const gauge in c.data.gauges) {
      // Health refills each round; super meter carries over, as in SF3.
      if (gauge !== "super") c.gauges[gauge] = c.data.gauges[gauge].inicial;
    }
    // Force the idle state rather than letting the animation finish.
    c.currentState = "Stand";
    c.frame = [c.data.states["Stand"].framedata.length, 0];
  };

  reset(g.player, -SPAWN_X, 1);
  reset(g.cpu, SPAWN_X, -1);

  g.objects = [g.player, g.cpu];
  objectRegistry.spawnQueue.length = 0;
  g.roundTimer = ROUND_TIMER_FRAMES;
  g.roundWinner = null;
  g.combo = null;
  g.phase = "intro";
  g.phaseTimer = INTRO_ROUND_FRAMES + INTRO_FIGHT_FRAMES;
  g.announcer = `ROUND ${g.round}`;
}

/** Advance the simulation by exactly one frame. */
export function tick(g: GameState, stage: CharState, inputs: TickInputs): void {
  g.frameCount++;

  // ── Phase machine ──
  if (g.phase === "intro") {
    g.phaseTimer--;
    g.announcer = g.phaseTimer > INTRO_FIGHT_FRAMES ? `ROUND ${g.round}` : "FIGHT!";
    if (g.phaseTimer <= 0) {
      g.phase = "playing";
      g.announcer = "";
    }
    // Fighters idle through the intro; they may not act yet.
    stepObjects(g, stage, { player: emptyRawInput(), cpu: emptyRawInput() });
    return;
  }

  if (g.phase === "roundEnd" || g.phase === "matchEnd") {
    g.phaseTimer--;
    // Keep simulating so the knockdown, landing and sparks play out.
    stepObjects(g, stage, { player: emptyRawInput(), cpu: emptyRawInput() });
    if (g.phaseTimer <= 0 && g.phase === "roundEnd") {
      g.round++;
      startRound(g);
    }
    return;
  }

  // ── Playing ──
  g.roundTimer = Math.max(0, g.roundTimer - 1);
  stepObjects(g, stage, inputs);
  updateCombo(g);

  const playerDead = (g.player.gauges.health ?? 1) <= 0;
  const cpuDead = (g.cpu.gauges.health ?? 1) <= 0;
  const timeOut = g.roundTimer <= 0;
  if (!playerDead && !cpuDead && !timeOut) return;

  // ── Round over ──
  let roundWinner: "player" | "cpu" | null = null;
  if (playerDead && !cpuDead) roundWinner = "cpu";
  else if (cpuDead && !playerDead) roundWinner = "player";
  else if (timeOut) {
    const ph = g.player.gauges.health ?? 0;
    const ch = g.cpu.gauges.health ?? 0;
    roundWinner = ph > ch ? "player" : ch > ph ? "cpu" : null;
  }

  g.roundWinner = roundWinner;
  if (roundWinner === "player") g.roundsWon[0]++;
  else if (roundWinner === "cpu") g.roundsWon[1]++;

  g.announcer = timeOut && !playerDead && !cpuDead ? "TIME UP" : "KO!";

  if (g.roundsWon[0] >= ROUNDS_TO_WIN || g.roundsWon[1] >= ROUNDS_TO_WIN) {
    g.phase = "matchEnd";
    g.phaseTimer = MATCH_END_FRAMES;
    g.winner = g.roundsWon[0] >= ROUNDS_TO_WIN ? "player" : "cpu";
  } else {
    g.phase = "roundEnd";
    g.phaseTimer = ROUND_END_FRAMES;
  }
}

// ─── One physics/collision step ──────────────────────────────────────────────

function stepObjects(g: GameState, stage: CharState, inputs: TickInputs): void {
  // 1. Convert raw input into command tokens. Facing is read now, before the
  //    character updates, so "6" means "toward the opponent" for this frame.
  pollDevice(g.player, inputs.player, inputs.playerCommands);
  pollDevice(g.cpu, inputs.cpu, inputs.cpuCommands);

  // 2. Update every live object (characters, projectiles, sparks)
  for (const obj of g.objects) updateChar(obj);

  // 3. Bring in objects spawned this frame (fireballs, hit sparks)
  if (objectRegistry.spawnQueue.length) {
    for (const s of objectRegistry.spawnQueue) {
      if (!s.selfMainObject) s.selfMainObject = s.team === g.player.team ? g.player : g.cpu;
      if (!s.otherMainObject) s.otherMainObject = s.team === g.player.team ? g.cpu : g.player;
      g.objects.push(s);
    }
    objectRegistry.spawnQueue.length = 0;
  }

  // 4. Collisions: hits → push → stage bounds (matches Python order)
  runCollisions(g.objects, stage);

  // 5. Kill projectiles that flew far offscreen
  const stageBB = stage.boxes["boundingbox"];
  if (stageBB?.boxes.length) {
    const [sx, , sw] = stageBB.boxes[0];
    for (const o of g.objects) {
      if (o.type === "projectile" && (o.pos[0] < sx - 600 || o.pos[0] > sx + sw + 600)) {
        o.killed = true;
      }
    }
  }

  // 6. Reap
  if (g.objects.some(o => o.killed)) {
    g.objects = g.objects.filter(o => !o.killed);
  }
}

function pollDevice(char: CharState, raw: RawInput, commands?: string[]): void {
  if (!char.device) return;
  char.device.poll(raw, char.face, [], commands ?? []);
  char.inputCurrentInput = char.device.currentInput;
  char.inputInterPress = char.device.interPress;
}

// ─── Combo counter ───────────────────────────────────────────────────────────

function updateCombo(g: GameState): void {
  const best: [CharState, "player" | "cpu"][] = [
    [g.player, "player"],
    [g.cpu, "cpu"],
  ];
  for (const [c, owner] of best) {
    if (c.combo >= 2) {
      g.combo = { count: c.combo, owner, timer: 90 };
      return;
    }
  }
  if (g.combo) {
    g.combo.timer--;
    if (g.combo.timer <= 0) g.combo = null;
  }
}
