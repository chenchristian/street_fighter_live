// ──────────────────────────────────────────────────────────────────────────────
// CPU AI.
//
// The AI holds a virtual controller — it produces RawInput and nothing else.
// It cannot write bufferState or force a state, so it is bound by exactly the
// same frame data, cancel windows and motion inputs as a human player. If the
// CPU lands a Shoryuken it is because it actually performed a dragon-punch
// motion and the command system matched it.
// ──────────────────────────────────────────────────────────────────────────────

import type { CharState } from "./types";
import { BTN, emptyRawInput, type RawInput } from "./input";
import type { Rng } from "./rng";

export type Difficulty = "easy" | "medium" | "hard";

export interface CpuConfig {
  /** Frames between the world changing and the AI being allowed to react. */
  reactionFrames: number;
  /** Probability of choosing to block an incoming attack it has reacted to. */
  blockChance: number;
  /** Bias toward closing distance and attacking rather than spacing. */
  aggression: number;
  /** Probability of following a landed normal with another attack. */
  comboChance: number;
  /** Probability of taking a special-move branch when one is available. */
  specialChance: number;
}

export const DIFFICULTIES: Record<Difficulty, CpuConfig> = {
  easy:   { reactionFrames: 24, blockChance: 0.25, aggression: 0.35, comboChance: 0.10, specialChance: 0.15 },
  medium: { reactionFrames: 14, blockChance: 0.55, aggression: 0.55, comboChance: 0.35, specialChance: 0.30 },
  hard:   { reactionFrames: 6,  blockChance: 0.85, aggression: 0.75, comboChance: 0.60, specialChance: 0.50 },
};

// ─── Action scripts ───────────────────────────────────────────────────────────
// A step is one frame's worth of intent, held for `frames` frames. Directions
// are facing-relative here (+1 x = toward the opponent) and converted to
// screen-absolute on the way out, because that is what InputDevice expects.

interface Step {
  dir?: [number, number];
  buttons?: number[];
  frames: number;
}

type Script = Step[];

const HOLD = (frames: number, dir?: [number, number]): Step => ({ dir, frames });
const PRESS = (buttons: number[], dir?: [number, number]): Script => [
  { buttons, dir, frames: 3 },
  { frames: 1 },
];

// Motions are performed as real directional inputs; InputDevice's history
// buffer detects them exactly as it would for a human.
const QCF: Step[] = [
  { dir: [0, -1], frames: 3 },
  { dir: [1, -1], frames: 3 },
  { dir: [1, 0], frames: 2 },
];
const DP: Step[] = [
  { dir: [1, 0], frames: 3 },
  { dir: [0, -1], frames: 3 },
  { dir: [1, -1], frames: 2 },
];

const SCRIPTS: Record<string, Script> = {
  // Normals
  jab:        PRESS([BTN.LP]),
  strong:     PRESS([BTN.MP]),
  fierce:     PRESS([BTN.HP]),
  short:      PRESS([BTN.LK]),
  forward:    PRESS([BTN.MK]),
  roundhouse: PRESS([BTN.HK]),
  crouchJab:  PRESS([BTN.LP], [0, -1]),
  crouchShort:PRESS([BTN.LK], [0, -1]),
  sweep:      PRESS([BTN.HK], [0, -1]),

  // Specials
  hadouken:  [...QCF, { buttons: [BTN.LP], dir: [1, 0], frames: 3 }, { frames: 2 }],
  shoryuken: [...DP,  { buttons: [BTN.LP], dir: [1, 0], frames: 3 }, { frames: 2 }],
  tatsumaki: [
    { dir: [0, -1], frames: 3 },
    { dir: [-1, -1], frames: 3 },
    { dir: [-1, 0], frames: 2 },
    { buttons: [BTN.LK], dir: [-1, 0], frames: 3 },
    { frames: 2 },
  ],

  // Movement / defence
  walkIn:    [HOLD(14, [1, 0])],
  walkOut:   [HOLD(14, [-1, 0])],
  blockHigh: [HOLD(20, [-1, 0])],
  blockLow:  [HOLD(20, [-1, -1])],
  crouch:    [HOLD(16, [0, -1])],
  jumpIn:    [HOLD(3, [1, 1]), HOLD(28, [1, 0])],
  idle:      [HOLD(10)],
};

// ─── Ranges (game units) ─────────────────────────────────────────────────────
const RANGE_CLOSE = 220;   // inside sweep/throw range
const RANGE_MID   = 420;   // inside longest normal
const RANGE_FAR   = 700;   // fireball territory

type CpuState = "neutral" | "approach" | "retreat" | "attack" | "defend";

/** One delayed observation of the opponent, so the AI reacts late like a human. */
interface Observation {
  state: string;
  attacking: boolean;
  airborne: boolean;
  dist: number;
  hitstun: number;
}

export class CpuController {
  private config: CpuConfig;
  private state: CpuState = "neutral";
  /** Remaining frames of the currently-running script. */
  private script: Script = [];
  private stepIndex = 0;
  private stepFrames = 0;
  /** Frames until the next decision is allowed. */
  private thinkTimer = 0;
  /** Ring of observations, read `reactionFrames` behind the present. */
  private observations: Observation[] = [];

  constructor(difficulty: Difficulty = "medium") {
    this.config = DIFFICULTIES[difficulty];
  }

  setDifficulty(difficulty: Difficulty): void {
    this.config = DIFFICULTIES[difficulty];
  }

  reset(): void {
    this.state = "neutral";
    this.script = [];
    this.stepIndex = 0;
    this.stepFrames = 0;
    this.thinkTimer = 0;
    this.observations = [];
  }

  /** Produce this frame's raw input. Called once per tick, before updateChar. */
  update(cpu: CharState, player: CharState, rng: Rng): RawInput {
    this.observe(cpu, player);

    // A running script is committed to — that's what gives the AI a readable,
    // punishable rhythm instead of twitching between decisions every frame.
    if (this.script.length > 0) return this.advanceScript(cpu);

    if (this.thinkTimer > 0) {
      this.thinkTimer--;
      return emptyRawInput();
    }

    this.decide(cpu, player, rng);
    return this.script.length > 0 ? this.advanceScript(cpu) : emptyRawInput();
  }

  // ── Delayed perception ──
  private observe(cpu: CharState, player: CharState): void {
    const hitbox = player.boxes["hitbox"];
    this.observations.push({
      state: player.currentState,
      attacking: !!hitbox?.boxes?.length,
      airborne: player.fet === "airborne",
      dist: Math.abs(cpu.pos[0] - player.pos[0]),
      hitstun: player.hitstun,
    });
    // Keep only what the reaction window needs.
    while (this.observations.length > this.config.reactionFrames + 1) {
      this.observations.shift();
    }
  }

  /** The world as the AI currently believes it to be — `reactionFrames` stale. */
  private perceived(): Observation | null {
    if (this.observations.length <= this.config.reactionFrames) return null;
    return this.observations[0];
  }

  // ── Decision tree ──
  private decide(cpu: CharState, player: CharState, rng: Rng): void {
    const obs = this.perceived();
    const dist = Math.abs(cpu.pos[0] - player.pos[0]);
    const cfg = this.config;

    // Can't act at all — don't burn a decision on it.
    if (cpu.hitstun > 0 || cpu.fet === "airborne") {
      this.thinkTimer = 2;
      return;
    }

    // 1. Defend: react to a committed attack we can still see coming.
    if (obs?.attacking && dist < RANGE_MID && rng.chance(cfg.blockChance)) {
      this.state = "defend";
      // Crouch-blocking beats more of the normal set, so favour it slightly.
      this.run(rng.chance(0.6) ? "blockLow" : "blockHigh");
      return;
    }

    // 2. Punish: opponent is in hitstun or recovering — take the free hit.
    if (obs && obs.hitstun > 4 && dist < RANGE_CLOSE) {
      this.state = "attack";
      this.run(
        rng.weighted([
          ["fierce", 3],
          ["shoryuken", cfg.specialChance * 6],
          ["sweep", 2],
          ["strong", 2],
        ])
      );
      return;
    }

    // 3. Range-appropriate offence.
    if (dist < RANGE_CLOSE) {
      this.state = "attack";
      this.run(
        rng.weighted([
          ["jab", 3],
          ["crouchJab", 2],
          ["crouchShort", 2],
          ["strong", 2],
          ["sweep", 2],
          ["shoryuken", cfg.specialChance * 4],
          ["walkOut", 3 * (1 - cfg.aggression)],
          ["blockLow", 2 * (1 - cfg.aggression)],
        ])
      );
      return;
    }

    if (dist < RANGE_MID) {
      this.state = rng.chance(cfg.aggression) ? "approach" : "neutral";
      this.run(
        rng.weighted([
          ["walkIn", 4 * cfg.aggression],
          ["forward", 3],
          ["roundhouse", 2],
          ["tatsumaki", cfg.specialChance * 2],
          ["walkOut", 2 * (1 - cfg.aggression)],
          ["crouch", 1],
        ])
      );
      return;
    }

    if (dist < RANGE_FAR) {
      this.state = "approach";
      this.run(
        rng.weighted([
          ["walkIn", 5 * cfg.aggression],
          ["hadouken", cfg.specialChance * 4],
          ["walkOut", 1],
          ["idle", 1],
        ])
      );
      return;
    }

    // Full screen: zone with fireballs or close the gap.
    this.state = "approach";
    this.run(
      rng.weighted([
        ["hadouken", cfg.specialChance * 8],
        ["walkIn", 5],
        ["jumpIn", 1.5 * cfg.aggression],
        ["idle", 1],
      ])
    );
  }

  private run(name: string): void {
    const script = SCRIPTS[name];
    if (!script) return;
    this.script = script;
    this.stepIndex = 0;
    this.stepFrames = script[0]?.frames ?? 0;
    // A short gap after every action, so the AI has recognisable recovery.
    this.thinkTimer = 4;
  }

  private advanceScript(cpu: CharState): RawInput {
    const step = this.script[this.stepIndex];
    if (!step) {
      this.script = [];
      return emptyRawInput();
    }

    const raw = emptyRawInput();
    if (step.dir) {
      // Facing-relative → screen-absolute, since InputDevice re-applies facing.
      raw.dir[0] = step.dir[0] * (cpu.face >= 0 ? 1 : -1);
      raw.dir[1] = step.dir[1];
    }
    for (const b of step.buttons ?? []) raw.buttons[b] = true;

    this.stepFrames--;
    if (this.stepFrames <= 0) {
      this.stepIndex++;
      if (this.stepIndex >= this.script.length) {
        this.script = [];
      } else {
        this.stepFrames = this.script[this.stepIndex].frames;
      }
    }
    return raw;
  }
}
