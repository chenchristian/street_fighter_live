// ──────────────────────────────────────────────────────────────────────────────
// Types mirroring the Python game engine's JSON character data + runtime state
// ──────────────────────────────────────────────────────────────────────────────

// ─── JSON data types (loaded from /assets/objects/*.json) ────────────────────

export interface BoxSet {
  boxes: [number, number, number, number][];
  crouch?: number;
  guard?: string[];
  [key: string]: unknown;
}

export interface HitboxSet extends BoxSet {
  hitset?: number;
  damage?: [number, number];
  gain?: [number, number];
  stamina?: [number, number];
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
  timekill: boolean;
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
  guard: string;

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

  // Input (set externally each frame)
  inputCurrentInput: Set<string>;
  inputInterPress: boolean;
}

export type GamePhase = "playing" | "ko" | "victory";

export interface GameState {
  player: CharState;
  cpu: CharState;
  phase: GamePhase;
  frameCount: number;
  winner: "player" | "cpu" | null;
  roundTimer: number;   // frames remaining
}
