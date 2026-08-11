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
     * how sure the model must be before a move fires,
     * 0–1. Higher = fewer misfires but you must hit the pose cleanly; lower =
     * more responsive but more false triggers. The vertical line in the model
     * output histogram is this value.
     */
    confidenceGate: 0.8,

    /** How many frames a detected move is held as a button press (~one press). */
    pressFrames: 3,

    /** Cooldown before the same held pose can fire again, so a sustained pose
     *  fires once instead of every frame. Raise if moves double-trigger. */
    repeatLockout: 15,

    /**
     * How fast you must be MOVING to register as walking — a speed, in body
     * widths per frame. Normalised by shoulder width, so it means the same
     * whether you stand close to the camera or far back. You walk while you're
     * moving and stop when you stop. LOWER = registers slower, gentler walks
     * (but more sensitive to noise); HIGHER = you must move more briskly.
     */
    walkThreshold: 0.04,

    /**
     * Coast: how long walking lingers after you stop moving, 0–1.
     *   0   = instant — the frame your motion drops, walking stops (crispest,
     *         but twitchiest, since real walking speed flickers frame to frame).
     *   ~0.5 = a short, smooth tail of a few frames after you stop.
     *   →1  = long momentum; walking glides on well after you've stopped.
     * Onset is always immediate (you move → you walk); this only shapes the
     * release. Clamped below 1 internally so it can never stick on forever.
     */
    walkCoast: 0.5,

    /**
     * How fast you must move UP to jump — an upward speed in body widths per
     * frame (torso rising, normalised by shoulder width like the walk). A jump
     * is a one-shot: you launch, the engine plays the whole arc, and no further
     * jump fires until you land. Set high enough to reject the small vertical
     * bob of walking, low enough that a modest hop counts — LOWER = a gentle
     * pop jumps; HIGHER = you must spring harder.
     */
    jumpThreshold: 0.2,

    /** How many frames the up-press is held once a jump launches — just long
     *  enough for the engine to register the jump, like a quick tap of up. */
    jumpPressFrames: 4,
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

if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  // Dev handle: tweak values live from the console, e.g.
  //   window.__TUNING.cv.walkCoast = 0.7
  // Reads are per-frame, so changes take effect immediately without reload.
  (window as unknown as Record<string, unknown>).__TUNING = TUNING;
}
