// ──────────────────────────────────────────────────────────────────────────────
// TUNING — the one place to change how the game feels.
//
// Every number here is safe to edit by hand. They used to be scattered across
// six files; they now live together so you can tweak the feel without hunting.
// Change a value, save, and the dev server hot-reloads it.
//
// Times are in frames at 60fps unless a field says otherwise: 60 = one second.
//
// What is NOT here, on purpose:
//   * Stage size — that is data. Edit the `boundingbox` in the stage JSON
//     (public/assets/objects/Training.json). Walls at ±900 = 1800 wide.
//   * The pose sequence length and the 14 move labels — those are locked to the
//     trained model and changing them breaks inference, not just the feel.
//   * Per-move frame data (startup/active/recovery, damage, knockback) — that
//     lives per-move in each character JSON, e.g. Ryu.json.
// ──────────────────────────────────────────────────────────────────────────────

export const TUNING = {
  // ── Webcam move detection ──────────────────────────────────────────────────
  // How the classified body pose becomes a controller press.
  cv: {
    /**
     * The "moving threshold": how sure the model must be before a move fires,
     * 0–1. Higher = fewer misfires but you must hit the pose cleanly; lower =
     * more responsive but more false triggers. The vertical line in the model
     * output histogram is this value.
     */
    confidenceGate: 0.8,
    /** How many frames a detected move is held as a button press (~one press). */
    pressFrames: 4,
    /** Cooldown before the same held pose can fire again, so a sustained pose
     *  fires once instead of every frame. Raise if moves double-trigger. */
    repeatLockout: 20,
    /**
     * How far you must lean/step frame-to-frame to register as walking, as a
     * fraction of frame width (0–1). LOWER = walks on the slightest movement;
     * HIGHER = you must step further before the fighter walks.
     */
    walkThreshold: 0.015,
    /**
     * If your body's centre is within this fraction of the left/right edge of
     * the camera frame, you walk that way regardless of movement. Lets you hold
     * a walk by standing to one side.
     */
    walkEdge: 0.15,
  },

  // ── CPU opponent ────────────────────────────────────────────────────────────
  // One row per difficulty. reactionFrames is the delay between the world
  // changing and the AI being allowed to respond (lower = sharper). The four
  // chances are probabilities, 0–1.
  cpu: {
    easy:   { reactionFrames: 24, blockChance: 0.25, aggression: 0.35, comboChance: 0.10, specialChance: 0.15 },
    medium: { reactionFrames: 14, blockChance: 0.55, aggression: 0.55, comboChance: 0.35, specialChance: 0.30 },
    hard:   { reactionFrames: 6,  blockChance: 0.85, aggression: 0.75, comboChance: 0.60, specialChance: 0.50 },
  },

  // ── Camera ──────────────────────────────────────────────────────────────────
  // The camera always keeps both fighters fully on screen; these control how it
  // frames them within that guarantee.
  camera: {
    /** Tightest zoom, in world units of visible height. SMALLER = more zoomed
     *  in (fighters bigger). The camera only ever zooms out from here. */
    viewHeight: 700,
    /** Clear space kept between a fighter and the left/right edge, world units. */
    padX: 150,
    /** Clear space kept above the higher fighter's head, world units. */
    padTop: 70,
  },

  // ── Match ─────────────────────────────────────────────────────────────────
  match: {
    /** Round clock, in seconds. */
    roundSeconds: 99,
    /** Rounds one player must win to take the match (2 = best of 3). */
    roundsToWin: 2,
    /** How far from centre each fighter starts, world units (±this). */
    startDistance: 300,
  },
} as const;
