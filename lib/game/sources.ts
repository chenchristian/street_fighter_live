// ──────────────────────────────────────────────────────────────────────────────
// Input sources — each produces the RawInput (+ macro tokens) that InputDevice
// turns into command tokens. Keyboard is the debug source; the CV pipeline is
// the real one.
// ──────────────────────────────────────────────────────────────────────────────

import { BTN, BUTTON_COUNT, emptyRawInput, type RawInput } from "./input";

// ─── Keyboard (debug) ────────────────────────────────────────────────────────
// Layout from CV_to_StreetFighter/keyboardguide.txt:
//   arrows = direction, A/S/D = LP/MP/HP, Q/W/E = LK/MK/HK

const KEY_TO_BUTTON: Record<string, number> = {
  KeyA: BTN.LP, KeyS: BTN.MP, KeyD: BTN.HP,
  KeyQ: BTN.LK, KeyW: BTN.MK, KeyE: BTN.HK,
};

export class KeyboardSource {
  private down = new Set<string>();
  private attached = false;

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.isGameKey(e.code)) e.preventDefault();
    this.down.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
  };
  private onBlur = () => this.down.clear();

  private isGameKey(code: string): boolean {
    return code in KEY_TO_BUTTON || code.startsWith("Arrow");
  }

  attach(): void {
    if (this.attached || typeof window === "undefined") return;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.down.clear();
    this.attached = false;
  }

  read(): RawInput {
    const raw = emptyRawInput();
    if (this.down.has("ArrowRight")) raw.dir[0] += 1;
    if (this.down.has("ArrowLeft"))  raw.dir[0] -= 1;
    if (this.down.has("ArrowUp"))    raw.dir[1] += 1;
    if (this.down.has("ArrowDown"))  raw.dir[1] -= 1;
    for (const code in KEY_TO_BUTTON) {
      if (this.down.has(code)) raw.buttons[KEY_TO_BUTTON[code]] = true;
    }
    return raw;
  }
}

// ─── Computer vision ─────────────────────────────────────────────────────────
// The LSTM classifies a whole pose into one of 14 labels, so a label maps to a
// button (plus a direction, plus a motion token for specials) rather than to a
// state name. Feeding the command system instead of writing bufferState keeps
// specials, cancels and buffering working exactly as the character JSON defines.

export interface CvMove {
  /** Buttons to hold for this move's press window. */
  buttons: number[];
  /** Direction held alongside — screen-absolute [x, y], y +1 = up. */
  dir?: [number, number];
  /** Motion token injected directly, e.g. "QCF" for a classified Hadouken pose. */
  motion?: string;
}

export const CV_MOVES: Record<string, CvMove> = {
  jab:                     { buttons: [BTN.LP] },
  cross:                   { buttons: [BTN.MP] },
  lead_hook:               { buttons: [BTN.HP] },
  rear_hook:               { buttons: [BTN.MP], dir: [0, -1] },  // crouching MP
  uppercut:                { buttons: [BTN.HP], dir: [0, -1] },  // crouching HP
  jumping_cross:           { buttons: [BTN.MP], dir: [0, 1] },   // jumping MP
  rear_low_kick:           { buttons: [BTN.LK] },
  side_kick:               { buttons: [BTN.MK] },
  spinning_back_high_kick: { buttons: [BTN.HK] },
  crouching_low_sweep:     { buttons: [BTN.HK], dir: [0, -1] },  // sweep
  grab:                    { buttons: [BTN.LP, BTN.LK] },        // SF3 throw = LP+LK
  hadouken:                { buttons: [BTN.LP], motion: "QCF" },
  shoryuken:               { buttons: [BTN.LP], motion: "DP" },
};

/**
 * Holds a classified pose for a few frames so the engine sees a real
 * press → hold → release edge, then locks the label out until it changes.
 *
 * Without the hold, a single-frame press can land on a frame where the
 * character can't act and is silently dropped; without the lockout, one
 * sustained pose retriggers every frame the classifier repeats it.
 */
export class CvSource {
  /** Frames a classified move stays held. Roughly one press at 60fps. */
  static readonly PRESS_FRAMES = 4;
  /** Frames a fired label is ignored for, so a held pose fires once. */
  static readonly REPEAT_LOCKOUT = 20;

  private move: CvMove | null = null;
  private pressTimer = 0;
  private lockout = 0;
  private lastLabel = "idle";
  private walk = 0;

  reset(): void {
    this.move = null;
    this.pressTimer = 0;
    this.lockout = 0;
    this.lastLabel = "idle";
    this.walk = 0;
  }

  /** Feed a new classification. Safe to call at the classifier's own rate. */
  setPrediction(label: string, direction: "LEFT" | "RIGHT" | null): void {
    // Walking is a continuous signal, not an edge. The camera preview is
    // CSS-mirrored while MediaPipe reports unmirrored coordinates, so the
    // detector's LEFT is the player stepping to their own right — which is
    // screen-right. Facing is applied later by InputDevice, not here.
    this.walk = direction === "LEFT" ? 1 : direction === "RIGHT" ? -1 : 0;

    if (label === "idle" || label === this.lastLabel) {
      this.lastLabel = label;
      return;
    }
    this.lastLabel = label;
    if (this.lockout > 0) return;

    const move = CV_MOVES[label];
    if (!move) return;
    this.move = move;
    this.pressTimer = CvSource.PRESS_FRAMES;
    this.lockout = CvSource.REPEAT_LOCKOUT;
  }

  /** Advance one game frame and produce this frame's raw input. */
  read(): { raw: RawInput; commands: string[] } {
    const raw = emptyRawInput();
    const commands: string[] = [];

    if (this.lockout > 0) this.lockout--;

    if (this.move && this.pressTimer > 0) {
      for (const b of this.move.buttons) {
        if (b >= 1 && b <= BUTTON_COUNT) raw.buttons[b] = true;
      }
      if (this.move.dir) {
        raw.dir[0] = this.move.dir[0];
        raw.dir[1] = this.move.dir[1];
      }
      // The motion token must land on the same frame as the button press so the
      // command's two steps link within command_link_time.
      if (this.move.motion && this.pressTimer === CvSource.PRESS_FRAMES) {
        commands.push(this.move.motion);
      }
      this.pressTimer--;
      if (this.pressTimer === 0) this.move = null;
    } else if (this.walk !== 0) {
      raw.dir[0] = this.walk;
    }

    return { raw, commands };
  }
}
