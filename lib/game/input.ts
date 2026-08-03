// ──────────────────────────────────────────────────────────────────────────────
// Input device — port of Util/Input_device.py's get_press()
//
// The engine's command system (getCommand) is driven entirely by string tokens
// emitted once per frame. Nothing else may write to bufferState directly:
// every move — normals, specials, blocks, dashes, throws — is expressed as a
// command gate in the character JSON, matched against these tokens.
//
// Token vocabulary (as used by SF3/Ryu.json and SF3/Ken.json):
//   "1".."9"     numpad direction, RELATIVE to facing (6 = toward opponent)
//   "45","56",…  two-frame direction transition (dash gates key off these)
//   "p_bN"       button N pressed this frame
//   "r_bN"       button N released this frame
//   "h_bN"       button N held (down on this frame and the previous one)
//   "charge_bN"  button N held for 40+ frames
//   "QCF","QCB","DP"   motion inputs, detected over the input history buffer
//   "Doble_tap_forward"  dash motion (spelling matches the character JSON)
// ──────────────────────────────────────────────────────────────────────────────

/** Buttons are 1-indexed to match the p_bN token names. Index 0 is unused. */
export const BUTTON_COUNT = 6;

// Button semantics, from CV_to_StreetFighter/keyboardguide.txt:
//   b6 = jab (LP)     b5 = cross (MP)      b4 = lead hook (HP)
//   b3 = leg kick(LK) b2 = body kick (MK)  b1 = high kick (HK)
export const BTN = {
  HK: 1, MK: 2, LK: 3,
  HP: 4, MP: 5, LP: 6,
} as const;

export interface RawInput {
  /** Screen-absolute direction. x: -1 left, +1 right. y: -1 down, +1 up. */
  dir: [number, number];
  /** buttons[1..6] — true while held. Index 0 unused. */
  buttons: boolean[];
}

export function emptyRawInput(): RawInput {
  return { dir: [0, 0], buttons: new Array(BUTTON_COUNT + 1).fill(false) };
}

// Numpad lookup, mirroring Python's
//   [["8","2","5"], ["9","3","6"], ["7","1","4"]][x * face][y - 1]
// Rows are indexed by facing-relative x (-1 away, 0 neutral, +1 toward);
// columns by y (+1 up, -1 down, 0 neutral).
const DPAD: Record<number, Record<number, string>> = {
  0:  { 1: "8", [-1]: "2", 0: "5" },
  1:  { 1: "9", [-1]: "3", 0: "6" },
  [-1]: { 1: "7", [-1]: "1", 0: "4" },
};

/** How many frames of direction history motion detection may look back over. */
export const INPUT_HISTORY_LENGTH = 10;

interface MotionDef {
  command: string;
  sequence: string[];
}

// Ordered longest-first so the most specific motion wins when several match.
const MOTIONS: MotionDef[] = [
  { command: "DP",  sequence: ["6", "3", "2", "3"] },
  { command: "DP",  sequence: ["3", "2", "1", "3"] },
  { command: "DP",  sequence: ["3", "2", "3"] },
  { command: "DP",  sequence: ["3", "2", "6"] },
  { command: "DP",  sequence: ["6", "2", "6"] },
  { command: "DP",  sequence: ["6", "2", "3"] },
  { command: "QCF", sequence: ["2", "3", "6"] },
  { command: "QCF", sequence: ["2", "6"] },
  { command: "QCB", sequence: ["2", "1", "4"] },
  { command: "QCB", sequence: ["2", "4"] },
  { command: "Doble_tap_forward", sequence: ["5", "6", "5", "6"] },
];

/**
 * Match `seq` against the tail of `hist`, newest-last.
 *
 * The newest entry must equal the final element of the sequence — a motion
 * completes on the frame the last direction is reached. Earlier elements are
 * matched backwards allowing gaps and repeats, so holding a direction for
 * several frames (which is what a human actually does) still registers.
 */
function matchMotion(hist: string[], seq: string[], window: number): boolean {
  const n = hist.length;
  if (n === 0 || hist[n - 1] !== seq[seq.length - 1]) return false;
  let si = seq.length - 2;
  const start = Math.max(0, n - window);
  for (let i = n - 2; i >= start && si >= 0; i--) {
    if (hist[i] === seq[si]) si--;
  }
  return si < 0;
}

export interface DeviceState {
  currentInput: string[];
  interPress: boolean;
  last: RawInput;
  pressCharge: number[];
  history: string[];
  motionCooldown: number[];
}

export class InputDevice {
  /** Tokens for the current frame — read by updateChar via inputCurrentInput. */
  currentInput: string[] = ["5"];
  /** True on frames carrying a real press, forcing a state-transition check. */
  interPress = false;

  private last: RawInput = emptyRawInput();
  private pressCharge: number[] = new Array(BUTTON_COUNT + 1).fill(0);
  /** Facing-relative direction history, newest last, capped at INPUT_HISTORY_LENGTH. */
  private history: string[] = [];
  /** Per-motion cooldown so one quarter-circle can't fire on every frame it stays matched. */
  private motionCooldown: number[] = MOTIONS.map(() => 0);

  reset(): void {
    this.currentInput = ["5"];
    this.interPress = false;
    this.last = emptyRawInput();
    this.pressCharge.fill(0);
    this.history = [];
    this.motionCooldown.fill(0);
  }

  /**
   * Capture everything that affects future token output.
   *
   * Rollback has to rewind the input device alongside the simulation: the
   * history buffer and press-edge state decide whether a motion fires, so a
   * device left at the present would resolve a re-simulated frame differently.
   */
  save(): DeviceState {
    return {
      currentInput: [...this.currentInput],
      interPress: this.interPress,
      last: { dir: [...this.last.dir] as [number, number], buttons: [...this.last.buttons] },
      pressCharge: [...this.pressCharge],
      history: [...this.history],
      motionCooldown: [...this.motionCooldown],
    };
  }

  restore(s: DeviceState): void {
    this.currentInput = [...s.currentInput];
    this.interPress = s.interPress;
    this.last = { dir: [...s.last.dir] as [number, number], buttons: [...s.last.buttons] };
    this.pressCharge = [...s.pressCharge];
    this.history = [...s.history];
    this.motionCooldown = [...s.motionCooldown];
  }

  /**
   * Convert one frame of raw input into tokens.
   *
   * @param face          +1 if the character faces right; flips the dpad so "6"
   *                      always means "toward the opponent".
   * @param extraInputs   tokens injected verbatim (CV adapter, netplay).
   * @param extraCommands motion tokens injected verbatim — how the CV adapter
   *                      fires a Hadouken from a single classified pose, the
   *                      same trick Python's combo_trail_macros uses.
   */
  poll(
    raw: RawInput,
    face: number,
    extraInputs: string[] = [],
    extraCommands: string[] = []
  ): void {
    const macroPress = extraInputs.length > 0 || extraCommands.length > 0;

    const relX = Math.sign(raw.dir[0]) * (face >= 0 ? 1 : -1);
    const relY = Math.sign(raw.dir[1]);
    const dpad = DPAD[relX]?.[relY] ?? "5";

    const lastRelX = Math.sign(this.last.dir[0]) * (face >= 0 ? 1 : -1);
    const lastRelY = Math.sign(this.last.dir[1]);
    const lastDpad = DPAD[lastRelX]?.[lastRelY] ?? "5";
    const transition = lastDpad + dpad;

    const pressed: string[] = [];
    const released: string[] = [];
    const held: string[] = [];
    for (let i = 1; i <= BUTTON_COUNT; i++) {
      const now = !!raw.buttons[i];
      const before = !!this.last.buttons[i];
      if (now && !before) pressed.push(`p_b${i}`);
      else if (!now && before) released.push(`r_b${i}`);
      else if (now && before) held.push(`h_b${i}`);

      this.pressCharge[i] = now && before ? this.pressCharge[i] + 1 : 0;
      if (this.pressCharge[i] > 40) held.push(`charge_b${i}`);
    }

    // ── Motion detection over the input history buffer ──
    this.history.push(dpad);
    if (this.history.length > INPUT_HISTORY_LENGTH) this.history.shift();

    const commands: string[] = [...extraCommands];
    for (let i = 0; i < MOTIONS.length; i++) {
      if (this.motionCooldown[i] > 0) { this.motionCooldown[i]--; continue; }
      if (matchMotion(this.history, MOTIONS[i].sequence, INPUT_HISTORY_LENGTH)) {
        if (!commands.includes(MOTIONS[i].command)) commands.push(MOTIONS[i].command);
        this.motionCooldown[i] = INPUT_HISTORY_LENGTH;
      }
    }

    this.currentInput = [
      dpad,
      transition,
      ...extraInputs,
      ...pressed,
      ...released,
      ...held,
      ...commands,
    ];

    // "Something changed this frame" — the same rule Python's interface devices
    // use (`inter_press = current_input != last_input`). Covering direction
    // changes as well as buttons matters: tapping toward the opponent is what
    // arms a parry, and a motion input completes on a frame with no button on it.
    this.interPress =
      macroPress ||
      pressed.length > 0 ||
      released.length > 0 ||
      commands.length > 0 ||
      dpad !== lastDpad;

    this.last = { dir: [...raw.dir] as [number, number], buttons: [...raw.buttons] };
  }
}
