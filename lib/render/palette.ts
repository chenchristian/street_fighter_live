// ──────────────────────────────────────────────────────────────────────────────
// Shared colour tokens. Implements UI_SHELL_SPEC §7 and the histogram palette
// from §6, in both CSS-string and packed-word form (the bitmap font takes words).
// ──────────────────────────────────────────────────────────────────────────────

import { rgba } from "./font";

/** CSS tokens — mirrored in globals.css as custom properties. */
export const CSS = {
  ink: "#0b0a10",
  sand: "#d9b779",
  gold: "#ffcc44",
  blood: "#c8323c",
  steel: "#6d7ea8",
  paper: "#f4e7cd",

  panel: "rgba(10,8,16,.82)",
  border: "#2a2438",
  field: "#14111f",
  fieldBorder: "#241f36",
  muted: "#5c557a",
  ok: "#7de08a",
} as const;

/** Packed words for anything drawn with the bitmap font. */
export const INK = {
  paper: rgba(244, 231, 205),
  gold: rgba(255, 204, 68),
  sand: rgba(217, 183, 121),
  blood: rgba(200, 50, 60),
  steel: rgba(109, 126, 168),
  white: rgba(255, 255, 255),
  ok: rgba(125, 224, 138),
  muted: rgba(92, 85, 122),
  shadow: rgba(11, 10, 16),
  black: rgba(0, 0, 0),
} as const;

// ─── Histogram ────────────────────────────────────────────────────────────────

export const HIST = {
  bg: "#14111f",
  barIdle: "#221e33",
  rowWin: "rgba(255,255,255,.10)",
  winFrame: "rgba(255,255,255,.85)",
  threshold: "rgba(255,255,255,.42)",
  peak: "rgba(255,255,255,.45)",
  label: rgba(150, 142, 180),
  labelHot: rgba(255, 255, 255),
  labelDead: rgba(88, 82, 112),
  text: rgba(255, 255, 255),
  dim: rgba(120, 114, 150),
} as const;

export const HIST_LAYOUT = {
  NAME_W: 56,
  VAL_W: 26,
  ROW_H: 13,
  WIDTH: 300,
} as const;

export const FALLBACK_COLOUR = "hsl(220 30% 55%)";

/**
 * Fixed identity hue per class. These never change when a class fires — the
 * colour is for naming the class from across the room, so "did it fire" is
 * carried by the row highlight and the white cap instead.
 *
 * Grouped by family so the category reads too: punches warm, kicks green→cyan,
 * specials blue→magenta. `jumping_cross` is the one aerial normal and takes the
 * neutral fallback rather than muddying either family's ramp.
 */
export const MOVE_COLOUR: Record<string, string> = {
  idle: "hsl(218 14% 50%)",

  // Punches — warm ramp
  jab: "hsl(52 90% 60%)",
  cross: "hsl(30 92% 58%)",
  lead_hook: "hsl(14 88% 60%)",
  rear_hook: "hsl(0 78% 60%)",
  uppercut: "hsl(340 76% 64%)",

  // Kicks — green → cyan
  rear_low_kick: "hsl(88 62% 52%)",
  side_kick: "hsl(140 58% 50%)",
  spinning_back_high_kick: "hsl(168 62% 48%)",
  crouching_low_sweep: "hsl(192 74% 54%)",

  // Specials / throws — blue → magenta
  hadouken: "hsl(216 84% 64%)",
  shoryuken: "hsl(272 72% 68%)",
  grab: "hsl(310 60% 62%)",

  jumping_cross: FALLBACK_COLOUR,
};

/**
 * Display names, capped at 8 characters — anything longer overflows the 56px
 * name column at scale 1 (5px glyph + 1px tracking = 6px per character).
 */
export const SHORT: Record<string, string> = {
  idle: "IDLE",
  jab: "JAB",
  cross: "CROSS",
  lead_hook: "L HOOK",
  rear_hook: "R HOOK",
  uppercut: "UPPERCUT",
  jumping_cross: "JMP CRS",
  rear_low_kick: "LOW KICK",
  side_kick: "SIDEKICK",
  spinning_back_high_kick: "SPIN HK",
  crouching_low_sweep: "SWEEP",
  grab: "GRAB",
  hadouken: "HADOUKEN",
  shoryuken: "SHORYUKN",
};

/** Presentation order. Never reorder the model's output indices — map to them. */
export const DISPLAY_ORDER = [
  "idle",
  "jab",
  "cross",
  "lead_hook",
  "rear_hook",
  "uppercut",
  "jumping_cross",
  "rear_low_kick",
  "side_kick",
  "spinning_back_high_kick",
  "crouching_low_sweep",
  "grab",
  "hadouken",
  "shoryuken",
];

/** No class is currently disabled; kept so dropping one stays a one-line change. */
export const DROPPED = new Set<string>();
