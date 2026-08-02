"use client";
// ──────────────────────────────────────────────────────────────────────────────
// TypeScript port of Util/Common_functions.py + Active_Objects.py
// ──────────────────────────────────────────────────────────────────────────────

import type { CharState, CharData, FrameData, BoxSet, HitboxSet } from "./types";
import { gameRng } from "./rng";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_SUBSTATE: FrameData = { dur: 1 };

// Mirrors Python's default_hitbox — values merged under a framedata hitbox
export const DEFAULT_HITBOX = {
  damage: [0, 0] as [number, number],
  stamina: [0, 0] as [number, number],
  hitstun: [0, 0] as [number, number],
  hitstop: 10,
  juggle: 1,
  knockback: { grounded: [0, 0] as [number, number] },
  hittype: ["medium", "middle"],
};

// Mirrors Python's attack_type_value
export const ATTACK_TYPE_VALUE: Record<string, { scaling: number; min_scaling: number }> = {
  parry: { scaling: 10, min_scaling: 0 },
  block: { scaling: 10, min_scaling: 10 },
  critical: { scaling: 10, min_scaling: 40 },
  super: { scaling: 10, min_scaling: 36 },
  special: { scaling: 10, min_scaling: 16 },
  heavy: { scaling: 10, min_scaling: 14 },
  medium: { scaling: 9, min_scaling: 12 },
  light: { scaling: 8, min_scaling: 10 },
  no_match: { scaling: 8, min_scaling: 40 },
};

// ─── Object registry (mirrors game.object_dict + deferred spawning) ──────────
// createChar during a frame handler (create_object) pushes into spawnQueue;
// the game tick drains it into the live object list.

export const objectRegistry: {
  dict: Record<string, CharData>;
  spawnQueue: CharState[];
} = { dict: {}, spawnQueue: [] };

// Mirrors Python's dummy_json merge at load time: fill in fields that
// projectile/particle JSONs (Hadouken, Sparks) omit.
export function normalizeCharData(data: CharData): CharData {
  data.type = data.type ?? "character";
  data.gravity = data.gravity ?? 0;
  data.gauges = data.gauges ?? {};
  data.states = data.states ?? {};
  data.timekill = data.timekill ?? false;
  const boxDefaults: Record<string, BoxSet> = {
    hurtbox: { boxes: [] },
    hitbox: { boxes: [], hitset: 1 } as HitboxSet,
    takebox: { boxes: [] },
    grabbox: { boxes: [] },
    pushbox: { boxes: [] },
    triggerbox: { boxes: [] },
    boundingbox: { boxes: [], grounded_friction: 0.7 } as BoxSet,
  };
  data.boxes = data.boxes ?? {};
  for (const key in boxDefaults) {
    data.boxes[key] = { ...boxDefaults[key], ...(data.boxes[key] ?? {}) };
  }
  return data;
}

// ─── Character factory ────────────────────────────────────────────────────────

export function createChar(
  data: CharData,
  name: string,
  pos: [number, number],
  face: number,
  team: number,
  initialState: string = "Stand"
): CharState {
  const gauges: Record<string, number> = {};
  for (const g in data.gauges) gauges[g] = data.gauges[g].inicial;

  const commandIndexTimer: Record<string, [number, number][]> = {};
  for (const move in data.states) {
    const cmds = data.states[move].command;
    if (cmds && cmds.length > 0) {
      commandIndexTimer[move] = cmds.map(() => [0, 0] as [number, number]);
    }
  }

  const char: CharState = {
    data,
    name,
    team,
    type: data.type ?? "character",
    killed: false,
    timekill: data.timekill ?? false,
    pos: [pos[0], pos[1], 0],
    speed: [0, 0],
    acceleration: [0, 0],
    conSpeed: [0, 0],
    face,
    fet: "grounded",
    airTime: 0,
    currentState: initialState,
    frame: [0, 0],
    cancel: [null],
    bufferState: {},
    commandIndexTimer,
    currentCommand: [5],
    kara: 0,
    repeat: 0,
    hitstop: 0,
    hitstun: 0,
    ignoreStop: false,
    holdOnStun: false,
    grabed: null,
    influenceObject: null,
    wallbounce: false,
    juggle: 100,
    damageScaling: [100, 100],
    lastDamage: [0, 0],
    combo: 0,
    comboList: [],
    parry: ["", 0],
    guard: [],
    gauges,
    boxes: { ...data.boxes },
    image: "reencor/none",
    imageSize: [...data.def_image_size] as [number, number, number],
    imageOffset: [...data.def_image_offset] as [number, number, number],
    imageMirror: [false, false],
    imageTint: [255, 255, 255, 255],
    imageAngle: [0, 0, 0],
    imageRepeat: false,
    imageGlow: 0,
    drawTextures: [],
    selfMainObject: null,
    otherMainObject: null,
    inputCurrentInput: ["5"],
    inputInterPress: false,
    device: null,
  };

  getState(char, { [initialState]: 2 }, true);
  nextFrame(char, data.states[char.currentState].framedata[0]);
  // A "kill" key in the very first substate is a no-op in Python (the object
  // isn't in object_list yet when remove() runs) — Sparks rely on this.
  char.killed = false;

  return char;
}

// ─── get_command ─────────────────────────────────────────────────────────────

export function getCommand(char: CharState, stateList: (string | number)[]): void {
  const state: (string | number)[] = [
    char.currentState,
    char.boxes["hurtbox"] && (char.boxes["hurtbox"] as BoxSet & { crouch?: number }).crouch != null
      ? "crouch"
      : "stand",
    (char.gauges.health ?? 1) <= 0 ? "defeated" : "alive",
    ...stateList,
  ];

  for (const move in char.commandIndexTimer) {
    const cmdDefs = char.data.states[move].command!;
    for (let index = 0; index < char.commandIndexTimer[move].length; index++) {
      const timer = char.commandIndexTimer[move][index];
      const step = timer[0];
      if (step >= cmdDefs[index].length) continue;
      const inputGate = cmdDefs[index][step].split(",");
      let intersection = 0;
      for (const input of inputGate) {
        if (input.includes("|")) {
          const parts = input.split("|");
          if (parts.some(p => state.includes(p))) intersection++;
        } else if (input.startsWith("!")) {
          if (!state.includes(input.slice(1))) intersection++;
        } else if (state.includes(input)) {
          intersection++;
        }
      }
      if (intersection >= inputGate.length) {
        timer[0] += 1;
        timer[1] = char.data.states[move].command_link_time ?? 14;
        if (timer[0] >= cmdDefs[index].length) {
          char.bufferState[move] = char.data.states[move].buffer ?? 1;
          char.commandIndexTimer[move][index] = [0, 0];
        }
      }
    }
  }
}

// ─── get_state ────────────────────────────────────────────────────────────────

export function getState(
  char: CharState,
  buffer: Record<string, number>,
  force = false
): string | false {
  const ordered = Object.keys(char.data.states).filter(m => m in buffer);
  for (const move of ordered) {
    const sd = char.data.states[move];
    const cancelList: (string | number | null)[] = (sd.cancel as (string | number | null)[] | undefined) ?? [null];
    const stateReq = sd.state ?? "grounded";
    const isFrameEnd = char.frame[0] <= 0 && char.frame[1] <= 0;
    const cl = cancelList as unknown[];
    const notBlacklisted = !(sd.no_cancel_states ?? []).includes(char.currentState);

    // Precedence matters and is easy to get wrong. Python reads:
    //   (frame == [0,0] and "neutral" in cancel)
    //   or ((kara-clause or cancel-intersection) and current_state not in no_cancel_states)
    // because `and` binds tighter than `or`. So no_cancel_states gates ONLY the
    // cancel branch: a state whose animation has fully ended may always restart
    // itself. That is exactly how the idle and walk loops work — their
    // no_cancel_states lists name themselves, to stop a *cancel* into the state
    // they are already in, not to stop the animation looping.
    const fromNeutral = isFrameEnd && cl.includes("neutral");
    const karaCancel =
      !!char.kara &&
      cl.includes("kara") &&
      !(char.data.states[char.currentState].cancel as unknown[] | undefined)?.includes("kara");
    const cancelInto = char.cancel.some(c => cl.includes(c));
    const canCancel = fromNeutral || ((karaCancel || cancelInto) && notBlacklisted);
    const hasMeter = (char.gauges.super ?? 0) >= (sd.bar_use ?? 0);

    if (force || (stateReq.includes(char.fet) && canCancel && hasMeter)) {
      if (sd.bar_use) char.gauges.super = (char.gauges.super ?? 0) - sd.bar_use;
      char.currentState = move;
      char.boxes = { ...char.data.boxes };
      char.frame = [sd.framedata.length, 0];
      char.kara = 2;
      char.bufferState = {};
      char.acceleration = [0, 0];
      char.conSpeed = [0, 0];
      char.hitstun = move.includes("ummble") && char.fet === "airborne" ? -1 : char.hitstun;
      char.repeat = 0;
      return move;
    }
  }
  return false;
}

// ─── next_frame ───────────────────────────────────────────────────────────────

export function nextFrame(char: CharState, rawState: FrameData): void {
  const state: FrameData = { ...DEFAULT_SUBSTATE, ...rawState };
  if (char.frame[0] <= 0) {
    char.frame = [0, 0];
    return;
  }

  // Reset per-frame visual/gameplay properties
  char.imageSize = [...char.data.def_image_size] as [number, number, number];
  char.imageOffset = [...char.data.def_image_offset] as [number, number, number];
  char.imageMirror = [false, false];
  char.imageTint = [255, 255, 255, 255];
  char.imageAngle = [0, 0, 0];
  char.imageRepeat = false;
  char.imageGlow = 0;
  char.drawTextures = [];
  char.ignoreStop = false;
  char.holdOnStun = false;
  char.cancel = [null];

  // Run each handler in order (mirrors Python's function_dict loop)
  for (const key of HANDLER_ORDER) {
    const val = state[key];
    if (val != null) {
      const handler = FRAME_HANDLERS[key];
      if (handler) handler(char, val);
    }
  }

  char.frame[0] -= 1;
}

// ─── Frame handlers (mirrors function_dict in Common_functions.py) ────────────

type Handler = (char: CharState, value: unknown) => void;

const FRAME_HANDLERS: Record<string, Handler> = {
  // First, like Python's function_dict: remove a key from a box set,
  // e.g. ["hitbox", "main_cancel"]
  remove_box_key: (c, v) => {
    const [boxName, key] = v as [string, string];
    if (c.boxes[boxName]) {
      const copy = { ...c.boxes[boxName] };
      delete copy[key];
      c.boxes[boxName] = copy as BoxSet;
    }
  },
  dur: (c, v) => {
    c.frame[1] = v as number;
  },
  image: (c, v) => {
    c.image = v as string;
  },
  image_size: (c, v) => {
    const s = v as number[];
    c.imageSize = [s[0], s[1], s[2] ?? 0];
  },
  image_offset: (c, v) => {
    const o = v as number[];
    c.imageOffset = [o[0], o[1], o[2] ?? 0];
  },
  image_mirror: (c, v) => {
    const m = v as boolean[];
    c.imageMirror = [!!m[0], !!m[1]];
  },
  image_tint: (c, v) => {
    const t = v as number[];
    c.imageTint = [t[0], t[1], t[2], t[3] ?? 255];
  },
  image_angle: (c, v) => {
    const a = v as number[];
    c.imageAngle = [a[0], a[1], a[2] ?? 0];
  },
  image_repeat: (c, v) => {
    c.imageRepeat = !!v;
  },
  image_glow: (c, v) => {
    c.imageGlow = v as number;
  },
  draw_textures: (c, v) => {
    c.drawTextures = v as FrameData[];
  },
  cancel: (c, v) => {
    const val = v as string | string[];
    c.cancel = Array.isArray(val) ? val : [val];
  },
  main_cancel: (c, v) => {
    if (!c.selfMainObject) return;
    const val = v as string | string[];
    c.selfMainObject.cancel = Array.isArray(val) ? val : [val];
  },
  ignore_stop: (c) => {
    c.ignoreStop = true;
  },
  hold_on_stun: (c) => {
    c.holdOnStun = true;
  },
  speed: (c, v) => {
    const s = v as number[];
    c.speed = [s[0] * c.face, s[1]];
  },
  accel: (c, v) => {
    const a = v as number[];
    c.acceleration = [a[0], a[1]];
  },
  add_speed: (c, v) => {
    const a = v as number[];
    c.speed = [c.speed[0] + a[0] * c.face, c.speed[1] + a[1]];
  },
  con_speed: (c, v) => {
    const s = v as number[];
    c.conSpeed = [s[0] * c.face, s[1]];
  },
  pos_offset: (c, v) => {
    const p = v as number[];
    c.pos = [c.pos[0] + p[0] * c.face, c.pos[1] + p[1], c.pos[2]];
  },
  facing: (c, v) => {
    c.face *= v as number;
  },
  hurtbox: (c, v) => {
    c.boxes["hurtbox"] = { ...c.data.boxes["hurtbox"], ...(v as BoxSet) };
  },
  hitbox: (c, v) => {
    c.boxes["hitbox"] = { ...c.data.boxes["hitbox"], ...(v as HitboxSet) };
  },
  grabbox: (c, v) => {
    c.boxes["grabbox"] = { ...c.data.boxes["grabbox"], ...(v as BoxSet) };
  },
  pushbox: (c, v) => {
    c.boxes["pushbox"] = { ...c.data.boxes["pushbox"], ...(v as BoxSet) };
  },
  takebox: (c, v) => {
    c.boxes["takebox"] = { ...c.data.boxes["takebox"], ...(v as BoxSet) };
  },
  triggerbox: (c, v) => {
    c.boxes["triggerbox"] = { ...c.data.boxes["triggerbox"], ...(v as BoxSet) };
  },
  boundingbox: (c, v) => {
    c.boxes["boundingbox"] = { ...c.data.boxes["boundingbox"], ...(v as BoxSet) };
  },
  update_box: (c, v) => {
    const updates = v as Record<string, Partial<BoxSet>>;
    for (const key in updates) {
      c.boxes[key] = { ...c.boxes[key], ...updates[key] };
    }
  },
  trigg_state: (c, v) => {
    const stateName = v as string;
    if (c.data.states[stateName]) {
      const fd = c.data.states[stateName].framedata;
      c.currentState = stateName;
      c.currentCommand = [];
      c.bufferState = {};
      c.boxes = { ...c.data.boxes };
      // +1 compensates for the outer nextFrame's frame[0] -= 1 that fires after this handler
      c.frame = [fd.length + 1, 0];
      nextFrame(c, fd[0]);
    }
  },
  repeat_substate: (c, v) => {
    const [back, maxRepeats] = v as [number, number];
    if (c.repeat < maxRepeats || maxRepeats === -1) {
      c.frame = [c.frame[0] + back, 0];
      c.repeat += 1;
    } else {
      c.frame = [c.frame[0], 0];
    }
  },
  random_state: (c, v) => {
    const options = v as Record<string, { chance: number }>;
    const entries = Object.entries(options);
    const total = entries.reduce((s, [, o]) => s + o.chance, 0);
    // Seeded, not Math.random — see rng.ts. Unseeded draws desync online play.
    let r = gameRng.next() * total;
    for (const [name, opt] of entries) {
      r -= opt.chance;
      if (r <= 0 && c.data.states[name]) {
        const fd = c.data.states[name].framedata;
        c.currentState = name;
        c.currentCommand = [];
        c.bufferState = {};
        c.boxes = { ...c.data.boxes };
        c.frame = [fd.length + 1, 0];
        nextFrame(c, fd[0]);
        break;
      }
    }
  },
  bar_gain: (c, v) => {
    if (c.gauges.super != null) c.gauges.super += v as number;
  },
  stop: (c, v) => {
    c.hitstop = v as number;
  },
  // Throw puppeteering (mirrors object_influence_pos/_speed/_off_influence).
  // The grabber repositions/launches the grabbed victim it holds a reference to.
  // Python is y-down (`pos[1] - p[1]`); this engine is y-up, so we add.
  influence_pos: (c, v) => {
    if (!c.influenceObject) return;
    const p = v as number[];
    c.influenceObject.pos = [c.pos[0] + p[0] * c.face, c.pos[1] + p[1], 0];
  },
  influence_speed: (c, v) => {
    if (!c.influenceObject) return;
    const s = v as number[];
    c.influenceObject.speed = [s[0] * c.face, s[1]];
  },
  off_influence: (c) => {
    if (c.influenceObject) {
      c.influenceObject.grabed = null;
      c.influenceObject = null;
    }
  },
  // Spawn projectiles/particles: [[dictName, [ox, oy], faceMul, initialState, palette?], ...]
  create_object: (c, v) => {
    const list = v as [string, [number, number], number, string, number?][];
    for (const [ref, off, faceMul, initState] of list) {
      const data = objectRegistry.dict[ref];
      if (!data || !data.states[initState]) continue;
      const spawned = createChar(
        data,
        ref,
        [c.pos[0] + off[0] * c.face, c.pos[1] + off[1]],
        c.face * faceMul,
        c.team,
        initState
      );
      spawned.selfMainObject = c.selfMainObject;
      spawned.otherMainObject = c.otherMainObject;
      objectRegistry.spawnQueue.push(spawned);
    }
  },
  // Last, like Python's function_dict: mark object for removal
  kill: (c) => {
    c.killed = true;
  },
  // Deliberately skipped: voice, sound, camera_path, influence*, draw_shake, light, ambient, smear, hitset, damage, knockback, hitstop, hitstun, stamina, hit_bar_gain, hittype, juggle, wallbounce
};

// Process keys in a stable order matching the Python function_dict order
const HANDLER_ORDER = Object.keys(FRAME_HANDLERS);

// ─── Character update (mirrors BaseActiveObject.update) ───────────────────────

function roundSign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

export function updateChar(char: CharState): void {
  // Parry window: tapping toward the opponent ("6") or down-forward ("3") arms
  // a 24-frame window during which a matching attack is parried instead of
  // blocked. The dpad token is already facing-relative, so no face term here.
  const dpad = char.inputCurrentInput[0];
  if (
    (dpad === "6" || dpad === "3") &&
    char.inputInterPress &&
    char.parry[1] === 0
  ) {
    char.parry = [dpad, 24];
  }
  if (char.parry[1] > 0) char.parry[1] -= 1;

  // Guard property of the current frame's hurtbox, e.g. ["middle", "block"] on
  // a blocking frame or ["middle", "parry"] on a parry frame. Drives automatic
  // guarding in the hit resolution.
  const hb = char.boxes["hurtbox"] as (BoxSet & { guard?: string[] }) | undefined;
  char.guard = hb?.guard ?? [];

  // Clamp gauges
  for (const g in char.gauges) {
    const def = char.data.gauges[g];
    if (!def) continue;
    if (char.gauges[g] < 0) char.gauges[g] = 0;
    if (char.gauges[g] > def.max) char.gauges[g] = def.max;
  }

  // Tick command index timers (decay step timers)
  for (const move in char.commandIndexTimer) {
    for (const t of char.commandIndexTimer[move]) {
      if (t[1] > 0) {
        t[1] -= 1;
        if (t[1] === 0) t[0] = 0;
      }
    }
  }

  const isFrameEnd = char.frame[0] <= 0 && char.frame[1] <= 0;

  if (!char.hitstop && char.grabed == null) {
    if (char.hitstun) char.hitstun -= 1;

    // Auto face opponent (characters only — projectiles keep their direction)
    const other = char.otherMainObject;
    if (other && char.type === "character" && char.fet === "grounded") {
      const inNeutral =
        char.cancel.some(c => ["neutral", "turn", "kara"].includes(c as string)) || isFrameEnd;
      if (inNeutral && char.face !== roundSign(other.pos[0] - char.pos[0]) && Math.abs(other.pos[0] - char.pos[0]) > 32) {
        char.face = roundSign(other.pos[0] - char.pos[0]);
        char.currentCommand = ["turn", ...char.currentCommand];
        char.inputInterPress = true;
      }
    }

    // Physics
    char.speed = [
      char.speed[0] + char.acceleration[0] * char.face,
      char.speed[1] + char.acceleration[1],
    ];
    char.pos = [
      char.pos[0] + char.speed[0],
      char.pos[1] + char.speed[1],
      char.pos[2],
    ];
    if (char.fet === "airborne") {
      char.speed[1] = char.speed[1] + (char.data.gravity ?? 0);
    }

    // When I'm out of hitstun, the opponent's combo scaling resets (mirrors Python)
    if (char.hitstun === 0 && char.otherMainObject) {
      char.otherMainObject.damageScaling = [100, 100];
    }

    // Decay buffer state
    const nextBuffer: Record<string, number> = {};
    for (const k in char.bufferState) {
      if (char.bufferState[k] > 0) nextBuffer[k] = char.bufferState[k] - 1;
    }
    char.bufferState = nextBuffer;
  }

  // `cancel` holds the tokens this frame may be cancelled into; a bare [null]
  // means "not cancellable". Python tests `not set(cancel).intersection([None])`
  // — i.e. no null present at all — which is stricter than "not every entry is
  // null", so a frame like ["neutral", null] stays uncancellable.
  const cancellable = !char.cancel.includes(null);

  // Gather input. Characters (Active_Objects.update) read input on any frame
  // they could act on, not just on a press or at the end of an animation —
  // without the cancellable/kara terms a motion input like QCF, which lands on
  // a frame with no button press, never reaches the command timers at all.
  if (char.inputInterPress || isFrameEnd || cancellable || char.kara > 0) {
    char.currentCommand = [...char.currentCommand, ...char.inputCurrentInput];
    getCommand(char, char.currentCommand);
  }

  // Try to transition to a new state.
  const canTransition =
    ((char.inputInterPress || Object.keys(char.bufferState).length > 0) &&
      (cancellable || char.kara > 0) &&
      (char.hitstop === 0 || (char.hitstop > 0 && char.ignoreStop))) ||
    isFrameEnd;
  if (canTransition) {
    getState(char, char.bufferState);
  }

  // Advance frame timer
  const shouldAdvance =
    ((char.hitstop && char.ignoreStop) || !char.hitstop) &&
    ((char.holdOnStun && !char.hitstun) || !char.holdOnStun);
  if (shouldAdvance) char.frame[1] -= 1;

  if (char.frame[1] <= 0) {
    const framedata = char.data.states[char.currentState].framedata;
    // Python indexes framedata[-frame[0]] unconditionally and lets next_frame's
    // own `frame[0] <= 0` guard clamp frame back to [0, 0]. Skipping the call
    // when frame[0] is 0 (as this port used to) means the clamp never runs and
    // frame[1] free-runs negative forever — the character sticks on its last
    // animation frame and every `frame == [0,0]` test silently stops matching.
    const idx = char.frame[0];
    const entry = idx > 0 && idx <= framedata.length
      ? framedata[framedata.length - idx]
      : framedata[0];
    nextFrame(char, entry);
  }

  // Continuous speed
  if (char.conSpeed[0] || char.conSpeed[1]) {
    char.speed = [char.speed[0] + char.conSpeed[0], char.speed[1] + char.conSpeed[1]];
  }

  if (char.hitstop > 0) char.hitstop -= 1;
  if (char.kara > 0) char.kara -= 1;

  // Commands live exactly one frame (mirrors Python's `self.current_command = []`
  // at the end of update). Without this, stale "hurt"/"landing" tokens keep
  // re-matching hit states and the defender loops in hit animations forever.
  char.currentCommand = [];

  // Auto-kill timer (projectiles/particles)
  if (typeof char.timekill === "number") {
    char.timekill -= 1;
    if (char.timekill <= 0) char.killed = true;
  }

  // No idle fallback here on purpose. The input device emits "5" (neutral)
  // every frame, which matches Stand's command gate and buffers it naturally —
  // same as Python. Forcing Stand from the engine masked the real defect and
  // stomped on states that legitimately end without returning to idle.

  // Clear inter_press flag
  char.inputInterPress = false;
}

// ─── Damage application (called from collision system) ───────────────────────

/** How the defender met the attack. Mirrors Python's `type` list. */
export interface GuardResult {
  kind: "hurt" | "block" | "parry";
  stance: "stand" | "crouch" | null;
}

export function applyHit(
  attacker: CharState,
  defender: CharState,
  rawHitbox: HitboxSet,
  hitPoint: [number, number],
  guard: GuardResult = { kind: "hurt", stance: null }
): void {
  // Merge Python's default_hitbox under the actual hitbox values
  const hitbox: HitboxSet = { ...DEFAULT_HITBOX, ...rawHitbox };
  const attackerMain = attacker.selfMainObject ?? attacker;
  const hittype = hitbox.hittype ?? ["medium", "middle"];
  const { kind } = guard;
  const isHit = kind === "hurt";
  const isParry = kind === "parry";

  // A fresh hit on a non-stunned defender starts a new combo (mirrors Python)
  if (!defender.hitstun) {
    attackerMain.damageScaling = [100, 100];
    attackerMain.combo = 0;
    attackerMain.comboList = [];
  }
  attacker.damageScaling = attackerMain.damageScaling;

  // Consume this hitbox (re-arms only when framedata defines a new hitbox)
  (attacker.boxes["hitbox"] as HitboxSet).hitset = 0;

  // ── Damage: [onHit, onBlock], zero on parry, scaled by combo scaling ──
  const dmgPair = hitbox.damage ?? [0, 0];
  const rawDamage = isParry ? 0 : isHit ? dmgPair[0] : (dmgPair[1] ?? 0);
  const scaling = Math.max(attackerMain.damageScaling[0], attackerMain.damageScaling[1]) / 100;
  const damage = Math.ceil(Math.abs(rawDamage * scaling));
  defender.gauges.health = Math.max(0, (defender.gauges.health ?? 0) - damage);
  defender.lastDamage = [
    defender.hitstun ? defender.lastDamage[0] + damage : damage,
    damage,
  ];
  const isKO = (defender.gauges.health ?? 1) <= 0;

  // ── Super meter: hit_bar_gain is [[selfHit, selfBlock], [otherHit, otherBlock]] ──
  const gainDef = (rawHitbox.hit_bar_gain ?? rawHitbox.gain) as
    | [[number, number], [number, number]]
    | undefined;
  if (gainDef && Array.isArray(gainDef[0]) && Array.isArray(gainDef[1])) {
    const idx = isHit ? 0 : 1;
    if (attackerMain.gauges.super != null) {
      attackerMain.gauges.super += isParry ? 0 : (gainDef[0][idx] ?? 0);
    }
    if (defender.gauges.super != null) {
      // Parrying is rewarded with a flat 8 meter, as in Python.
      defender.gauges.super += isParry ? 8 : (gainDef[1][idx] ?? 0);
    }
  }

  // ── Stun meter ──
  const stamPair = hitbox.stamina ?? [0, 0];
  if (defender.gauges.stamina != null) {
    defender.gauges.stamina += isParry ? 0 : isHit ? stamPair[0] : (stamPair[1] ?? 0);
  }

  // ── Knockback ──
  // A parry leaves the defender planted; a block only pushes them back along
  // the ground — never launches, however vertical the hit's knockback is.
  if (!isParry) {
    const kbDef = hitbox.knockback ?? { grounded: [14, 0] };
    let kbSpeed: [number, number] = [...(kbDef.grounded ?? [14, 0])] as [number, number];
    if (defender.fet === "airborne" && kbDef.airborne) {
      kbSpeed = [...kbDef.airborne] as [number, number];
    }
    if (!isHit) kbSpeed = [Math.abs(kbSpeed[0]) * 0.5, 0];

    const launch = isHit && kbSpeed[1] > 0 && defender.fet === "grounded";
    defender.speed = [kbSpeed[0] * attacker.face, kbSpeed[1]];
    defender.face = attackerMain.pos[0] > defender.pos[0] ? 1 : -1;
    if (launch) {
      defender.fet = "airborne";
      defender.pos[1] += 10;
    }
    if (isKO) {
      defender.speed[1] = 20;
      defender.fet = "airborne";
    }
  }

  // ── Hitstop: a parry freezes both fighters for a fixed 16 frames ──
  const stop = isParry ? 16 : (hitbox.hitstop ?? 10);
  attacker.hitstop = stop;
  defender.hitstop = stop;

  // ── Hitstun / blockstun: [onHit, onBlock], zero on parry ──
  const stunPair = hitbox.hitstun ?? [30, 0];
  defender.hitstun = isParry ? 0 : isHit ? stunPair[0] : (stunPair[1] ?? 0);

  // Juggle counter (airborne defenders can only take so many hits)
  if (isHit && defender.fet === "airborne") {
    defender.juggle -= hitbox.juggle ?? 1;
  }

  if (isHit && rawHitbox.wallbounce != null) defender.wallbounce = true;

  // Attacker gets its on-hit cancel options (jab → jab chains, special cancels)
  if (rawHitbox.cancel != null) {
    const val = rawHitbox.cancel as string | string[];
    attacker.cancel = Array.isArray(val) ? val : [val];
  }
  if (rawHitbox.main_cancel != null && attacker.selfMainObject) {
    const val = rawHitbox.main_cancel as string | string[];
    attacker.selfMainObject.cancel = Array.isArray(val) ? val : [val];
  }

  // ── Defender transitions via the command system ──
  // Python builds `type + hittype`, e.g. ["block","stand","light","middle"],
  // which is exactly what Stand Block's gate [["block","stand"]] matches.
  const typeTokens = guard.stance ? [kind, guard.stance] : [kind];
  defender.bufferState = {};
  defender.currentCommand = [...typeTokens, ...hittype];
  if (isKO) defender.currentCommand.push("sidetummble");
  defender.frame = [0, 0];
  defender.cancel = [null];
  getCommand(defender, defender.currentCommand);
  const transitioned = getState(defender, defender.bufferState);
  if (transitioned) nextFrameCurrent(defender);

  // Tell the attacker's own framedata how the attack landed, so on-hit-only
  // cancel routes can gate on it.
  attacker.currentCommand = [
    ...attacker.currentCommand,
    isParry ? "parried" : isHit ? "hited" : "blocked",
  ];

  // ── Combo bookkeeping — blocked and parried attacks don't extend a combo ──
  const attackClass = Object.keys(ATTACK_TYPE_VALUE).find(k => hittype.includes(k)) ?? "medium";
  if (isHit) {
    attackerMain.combo += 1;
    attackerMain.comboList.push(`${attacker.data.name} ${attacker.currentState}`);
    const tv = ATTACK_TYPE_VALUE[attackClass];
    attackerMain.damageScaling = [
      Math.max(tv.min_scaling, attackerMain.damageScaling[0] - tv.scaling),
      tv.min_scaling,
    ];
  }

  // ── Hit spark at the point of contact ──
  // Python picks the first attack_type_value key present in the defender's
  // command, so a block/parry shows its own spark rather than the hit spark.
  const sparkState =
    Object.keys(ATTACK_TYPE_VALUE).find(k => defender.currentCommand.includes(k)) ?? attackClass;
  const sparkData = objectRegistry.dict["SF3/Sparks"];
  if (sparkData && sparkData.states[sparkState]) {
    const spark = createChar(sparkData, "SF3/Sparks", hitPoint, attacker.face, attacker.team, sparkState);
    spark.selfMainObject = attacker.selfMainObject;
    spark.otherMainObject = attacker.otherMainObject;
    objectRegistry.spawnQueue.push(spark);
  }

  // Hitbox-triggered spawns (e.g. fireball death spark) and projectile death
  if (rawHitbox.create_object != null) {
    FRAME_HANDLERS["create_object"](attacker, rawHitbox.create_object);
  }
  if (rawHitbox.kill != null) attacker.killed = true;
}

export function nextFrameCurrent(char: CharState): void {
  const fd = char.data.states[char.currentState].framedata;
  const idx = char.frame[0];
  if (idx > 0 && idx <= fd.length) {
    nextFrame(char, fd[fd.length - idx]);
  }
}

// Instantly switch a character into a state (mirrors object_trigger_state).
// Use this from collision resolution — NOT the `trigg_state` frame handler, which
// adds +1 to compensate for the outer nextFrame decrement it runs inside of.
export function triggerState(char: CharState, stateName: string): void {
  const sd = char.data.states[stateName];
  if (!sd) return;
  char.currentState = stateName;
  char.currentCommand = [];
  char.bufferState = {};
  char.boxes = { ...char.data.boxes };
  char.frame = [sd.framedata.length, 0];
  nextFrame(char, sd.framedata[0]);
}
