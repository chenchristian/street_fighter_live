"use client";
// ──────────────────────────────────────────────────────────────────────────────
// TypeScript port of Util/Common_functions.py + Active_Objects.py
// ──────────────────────────────────────────────────────────────────────────────

import type { CharState, CharData, FrameData, BoxSet, HitboxSet } from "./types";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_SUBSTATE: FrameData = { dur: 1 };

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
    guard: "",
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
    inputCurrentInput: new Set(),
    inputInterPress: false,
  };

  getState(char, { [initialState]: 2 }, true);
  nextFrame(char, data.states[char.currentState].framedata[0]);

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
    const canCancel =
      (isFrameEnd && (cancelList as unknown[]).includes("neutral")) ||
      (char.kara && (cancelList as unknown[]).includes("kara") && !(char.data.states[char.currentState].cancel as unknown[] | undefined)?.includes("kara")) ||
      char.cancel.some(c => (cancelList as unknown[]).includes(c));
    const notBlacklisted = !(sd.no_cancel_states ?? []).includes(char.currentState);
    const hasMeter = (char.gauges.super ?? 0) >= (sd.bar_use ?? 0);

    if (force || (stateReq.includes(char.fet) && canCancel && notBlacklisted && hasMeter)) {
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
      c.currentState = stateName;
      c.boxes = { ...c.data.boxes };
      c.frame = [c.data.states[stateName].framedata.length, 0];
      nextFrame(c, c.data.states[stateName].framedata[0]);
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
    let r = Math.random() * total;
    for (const [name, opt] of entries) {
      r -= opt.chance;
      if (r <= 0 && c.data.states[name]) {
        c.currentState = name;
        c.boxes = { ...c.data.boxes };
        c.frame = [c.data.states[name].framedata.length, 0];
        nextFrame(c, c.data.states[name].framedata[0]);
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
  // Deliberately skipped: voice, sound, camera_path, create_object, influence*, draw_shake, light, ambient, smear, hitset, damage, knockback, hitstop, hitstun, stamina, hit_bar_gain, hittype, juggle, wallbounce
};

// Process keys in a stable order matching the Python function_dict order
const HANDLER_ORDER = Object.keys(FRAME_HANDLERS);

// ─── Character update (mirrors BaseActiveObject.update) ───────────────────────

function roundSign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

export function updateChar(char: CharState): void {
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

    // Auto face opponent
    const other = char.otherMainObject;
    if (other && char.fet === "grounded") {
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
      char.speed[1] = char.speed[1] + char.data.gravity;
    }

    // Decay buffer state
    const nextBuffer: Record<string, number> = {};
    for (const k in char.bufferState) {
      if (char.bufferState[k] > 0) nextBuffer[k] = char.bufferState[k] - 1;
    }
    char.bufferState = nextBuffer;
  }

  // Gather input
  const canReadInput =
    char.inputInterPress ||
    isFrameEnd ||
    !char.cancel.every(c => c === null) ||
    char.kara;
  if (canReadInput) {
    char.currentCommand = [...char.currentCommand, ...Array.from(char.inputCurrentInput)];
    getCommand(char, char.currentCommand);
  }

  // Try to transition to a new state
  const canTransition =
    ((char.inputInterPress || Object.keys(char.bufferState).length > 0) &&
      !char.cancel.every(c => c === null) &&
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
    const idx = char.frame[0]; // still pre-decrement value
    if (idx > 0 && idx <= framedata.length) {
      nextFrame(char, framedata[framedata.length - idx]);
    }
  }

  // Continuous speed
  if (char.conSpeed[0] || char.conSpeed[1]) {
    char.speed = [char.speed[0] + char.conSpeed[0], char.speed[1] + char.conSpeed[1]];
  }

  if (char.hitstop > 0) char.hitstop -= 1;
  if (char.kara > 0) char.kara -= 1;

  // Trim currentCommand to avoid unbounded growth
  if (char.currentCommand.length > 20) {
    char.currentCommand = char.currentCommand.slice(-20);
  }

  // When animation ends and nothing is buffered, return to the idle state.
  // In Python the input device continuously sends "5" (neutral) which triggers Stand.
  // We replicate that here: when frame has ended and buffer is empty, queue Stand.
  const isNowFrameEnd = char.frame[0] <= 0 && char.frame[1] <= 0;
  if (isNowFrameEnd && Object.keys(char.bufferState).length === 0 && char.data.states["Stand"]) {
    char.bufferState["Stand"] = 2;
    char.inputInterPress = true;
  }

  // Clear inter_press flag
  char.inputInterPress = false;
}

// ─── Damage application (called from collision system) ───────────────────────

export function applyHit(
  attacker: CharState,
  defender: CharState,
  hitbox: HitboxSet
): void {
  // Determine hit result type based on defender's current command
  const defCmd = defender.currentCommand;
  const isBlock = defCmd.includes("block");
  const isParry = defCmd.includes("parry");
  const hitResult = isParry ? "parry" : isBlock ? "block" : "hurt";

  // Damage
  const [dmgHit, dmgBlock] = hitbox.damage ?? [10, 5];
  const scaling = Math.max(
    attacker.damageScaling[0],
    attacker.damageScaling[1]
  ) / 100;
  const damage = Math.ceil(Math.abs(
    hitResult === "hurt" ? dmgHit * scaling
    : hitResult === "block" ? dmgBlock * scaling
    : 0
  ));
  defender.gauges.health = Math.max(0, (defender.gauges.health ?? 0) - damage);
  defender.lastDamage = [
    defender.hitstun ? defender.lastDamage[0] + damage : damage,
    damage,
  ];

  // Hitstun
  const [stunHit, stunBlock] = hitbox.hitstun ?? [30, 0];
  if (hitResult !== "parry") {
    defender.hitstun = hitResult === "hurt" ? stunHit : stunBlock;
  }

  // Hitstop
  const stop = hitbox.hitstop ?? 10;
  if (hitResult !== "parry") {
    attacker.hitstop = stop;
    defender.hitstop = stop;
  }

  // Knockback
  const kbDef = hitbox.knockback ?? { grounded: [14, 0] };
  let kbSpeed: [number, number] = kbDef.grounded ?? [14, 0];
  if (hitResult === "block") kbSpeed = kbDef.block ?? [kbSpeed[0], 0] as [number, number];
  if (hitResult === "parry") kbSpeed = [0, 0];
  defender.speed = [kbSpeed[0] * attacker.face, kbSpeed[1]];
  if (kbSpeed[1] > 0 && defender.fet === "grounded") {
    defender.fet = "airborne";
    defender.pos[1] += 10;
  }
  defender.face = attacker.selfMainObject && attacker.selfMainObject.pos[0] > defender.pos[0] ? 1 : -1;

  // Hittype / state transition for defender (mirrors Python's object_hit_hittype)
  if (hitResult === "hurt") {
    const hittype = hitbox.hittype ?? ["medium", "middle"];
    // Add "hurt" + hittype to currentCommand so the command system selects the right
    // hit animation (matches Python: other.current_command = ["hurt"] + hittype)
    defender.bufferState = {};  // clear stale buffers (e.g. queued Stand)
    defender.currentCommand = [...defender.currentCommand, "hurt", ...hittype];
    if (defender.gauges.health != null && defender.gauges.health <= 0) {
      defender.currentCommand.push("sidetummble");
    }
    defender.frame = [0, 0];
    defender.cancel = [null];

    // Use command system to select the correct hit state (same as Python's get_command flow)
    getCommand(defender, defender.currentCommand);
    const transitioned = getState(defender, defender.bufferState);
    if (transitioned) nextFrameCurrent(defender);
  }

  // Reset hitbox hit state to prevent multi-hit in same attack
  (attacker.boxes["hitbox"] as HitboxSet).hitset = 0;

  // Damage scaling
  const typeValue: Record<string, { scaling: number; min_scaling: number }> = {
    super: { scaling: 10, min_scaling: 36 },
    special: { scaling: 10, min_scaling: 16 },
    heavy: { scaling: 10, min_scaling: 14 },
    medium: { scaling: 9, min_scaling: 12 },
    light: { scaling: 8, min_scaling: 10 },
  };
  const hittype = hitbox.hittype ?? ["medium"];
  const typeName = Object.keys(typeValue).find(k => hittype.includes(k)) ?? "medium";
  const tv = typeValue[typeName];
  attacker.damageScaling = [
    Math.max(tv.min_scaling, attacker.damageScaling[0] - tv.scaling),
    tv.min_scaling,
  ];
}

function nextFrameCurrent(char: CharState): void {
  const fd = char.data.states[char.currentState].framedata;
  const idx = char.frame[0];
  if (idx > 0 && idx <= fd.length) {
    nextFrame(char, fd[fd.length - idx]);
  }
}
