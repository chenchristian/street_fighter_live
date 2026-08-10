// ──────────────────────────────────────────────────────────────────────────────
// Types mirroring the Python game engine's JSON character data + runtime state
// ──────────────────────────────────────────────────────────────────────────────

import type { InputDevice } from "./input";

// ─── JSON data types (loaded from /assets/objects/*.json) ────────────────────

export interface BoxSet {
  boxes: [number, number, number, number][];
  crouch?: number;
  guard?: string[];
  [key: string]: unknown;
}

export interface HitboxSet extends BoxSet {
  hitset?: number;
  /** [damage on hit, damage on block]. Parry always deals 0. */
  damage?: [number, number];
  /** [[self on hit, self on block], [other on hit, other on block]] super meter. */
  hit_bar_gain?: [[number, number], [number, number]];
  gain?: [[number, number], [number, number]];
  stamina?: [number, number];
  /** [hitstun, blockstun] in frames. */
  hitstun?: [number, number];
  hitstop?: number;
  juggle?: number;
  knockback?: Record<string, [number, number]>;
  hittype?: string[];
}

export interface FrameData {
  dur?: number;
  image?: string;
  image_size?: [number, number, number?];
  image_offset?: [number, number, number?];
  image_mirror?: [boolean, boolean];
  image_tint?: [number, number, number, number];
  image_angle?: [number, number, number];
  image_repeat?: boolean;
  image_glow?: number;
  draw_textures?: FrameData[];
  cancel?: string | string[];
  main_cancel?: string | string[];
  speed?: [number, number];
  accel?: [number, number];
  add_speed?: [number, number];
  con_speed?: [number, number];
  pos_offset?: [number, number];
  facing?: number;
  hurtbox?: BoxSet;
  hitbox?: HitboxSet;
  grabbox?: BoxSet;
  pushbox?: BoxSet;
  takebox?: BoxSet;
  triggerbox?: BoxSet;
  boundingbox?: BoxSet;
  ignore_stop?: unknown;
  hold_on_stun?: unknown;
  trigg_state?: string;
  repeat_substate?: [number, number];
  random_state?: Record<string, { chance: number }>;
  bar_gain?: number;
  smear?: unknown;
  draw_shake?: [number, number, number, string];
  voice?: Record<string, { chance: number }>;
  sound?: string;
  create_object?: unknown[];
  influence?: string;
  influence_pos?: [number, number, number];
  influence_speed?: [number, number];
  off_influence?: unknown;
  update_box?: Record<string, Partial<BoxSet>>;
  stop?: number;
  hitset?: unknown;
  [key: string]: unknown;
}

export interface StateData {
  command?: string[][];
  framedata: FrameData[];
  cancel?: (string | number)[];
  no_cancel_states?: string[];
  state?: string;
  buffer?: number;
  bar_use?: number;
  command_link_time?: number;
  reward?: number;
}

export interface GaugeDef {
  inicial: number;
  max: number;
  rate?: number;
}

export interface CharData {
  type: string;
  name: string;
  portrait?: string;
  def_image_size: [number, number, number];
  def_image_offset: [number, number, number];
  gravity: number;
  mass: number;
  terminal_velocity: number;
  timekill: boolean | number;
  scale: number;
  gauges: Record<string, GaugeDef>;
  boxes: Record<string, BoxSet | HitboxSet>;
  states: Record<string, StateData>;
  palette: unknown[][];
}

// ─── Runtime state ────────────────────────────────────────────────────────────

export interface CharState {
  // Character JSON data
  data: CharData;
  name: string;
  team: number;
  type: string;              // "character" | "projectile" | "particle"
  killed: boolean;           // marked for removal from the object list
  timekill: boolean | number; // frames until auto-kill (false = never)

  // Physics
  pos: [number, number, number];
  speed: [number, number];
  acceleration: [number, number];
  conSpeed: [number, number];
  face: number;        // 1 = facing right, -1 = facing left
  fet: "grounded" | "airborne";
  airTime: number;

  // State machine
  currentState: string;
  frame: [number, number];   // [entries remaining, timer for current entry]
  cancel: (string | number | null)[];
  bufferState: Record<string, number>;
  commandIndexTimer: Record<string, [number, number][]>;
  currentCommand: (string | number)[];
  kara: number;
  repeat: number;

  // Hit state
  hitstop: number;
  hitstun: number;
  ignoreStop: boolean;
  holdOnStun: boolean;
  grabed: CharState | null;
  influenceObject: CharState | null;
  wallbounce: boolean;
  juggle: number;
  damageScaling: [number, number];
  lastDamage: [number, number];
  combo: number;
  comboList: unknown[];
  parry: [string, number];
  /** Guard property of the current frame's hurtbox, e.g. ["middle", "block"]. */
  guard: string[];

  // Gauges (health, super, stamina)
  gauges: Record<string, number>;

  // Boxes (hurtbox, hitbox, pushbox, etc.) – runtime copies that get overwritten each frame
  boxes: Record<string, BoxSet | HitboxSet>;

  // Rendering
  image: string;
  imageSize: [number, number, number];
  imageOffset: [number, number, number];
  imageMirror: [boolean, boolean];
  imageTint: [number, number, number, number];
  imageAngle: [number, number, number];
  imageRepeat: boolean;
  imageGlow: number;
  drawTextures: FrameData[];

  // Cross-references (set during update)
  selfMainObject: CharState | null;
  otherMainObject: CharState | null;

  // Input (set externally each frame). Ordered like Python's current_input list:
  // index 0 is always the facing-relative dpad token.
  inputCurrentInput: string[];
  inputInterPress: boolean;
  /** Input source driving this character. Null for projectiles and particles. */
  device: InputDevice | null;
}

export type GamePhase = "intro" | "playing" | "roundEnd" | "matchEnd";

/** Combo display state — a running hit count that expires shortly after it ends. */
export interface ComboState {
  count: number;
  owner: "player" | "cpu";
  timer: number;
}

export interface GameState {
  player: CharState;
  cpu: CharState;
  // All live objects: characters, projectiles, hit sparks. player/cpu are members.
  objects: CharState[];
  phase: GamePhase;
  frameCount: number;
  /** Frames left in the current non-playing phase (intro, round end, match end). */
  phaseTimer: number;
  roundTimer: number;   // frames remaining in the round
  round: number;        // 1-based
  roundsWon: [number, number];  // [player, cpu]
  roundWinner: "player" | "cpu" | null;
  winner: "player" | "cpu" | null;
  /** Big centred announcer text, e.g. "ROUND 1", "FIGHT!", "KO!". */
  announcer: string;
  combo: ComboState | null;
  /**
   * World x of the stage's left and right walls, read from the stage's
   * boundingbox at load. Constant for the match; the camera needs it, and
   * hard-coding it meant a stage of a different width silently broke framing.
   */
  stageBounds: [number, number];
}
