// Mirrors the filtering logic from pose_worker.py

import { TUNING } from "@/lib/tuning";

export const REMOVE_INDICES = new Set([1, 3, 4, 6, 17, 18, 19, 20, 21, 22, 31, 32]);

export const SEQUENCE_LENGTH = 5;
// Locked to the trained model — do not change here. The tunable gate lives in
// lib/tuning.ts (cv.confidenceGate).
export const CONFIDENCE_THRESHOLD = TUNING.cv.confidenceGate;

// MediaPipe Pose landmark indices for the torso.
const L_SHOULDER = 11, R_SHOULDER = 12, L_HIP = 23, R_HIP = 24;
/** Floor on the reference scale, so a foreshortened torso can't blow up Δ. */
const MIN_REF_SCALE = 0.05;

export interface NLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export function landmarksToVector(lms: NLandmark[]): Float32Array {
  const filtered = lms.filter((_, i) => !REMOVE_INDICES.has(i));
  const v = new Float32Array(filtered.length * 4);
  filtered.forEach((lm, i) => {
    v[i * 4 + 0] = lm.x;
    v[i * 4 + 1] = lm.y;
    v[i * 4 + 2] = lm.z;
    v[i * 4 + 3] = lm.visibility ?? 1;
  });
  return v;
}

export type WalkDir = "LEFT" | "RIGHT" | null;

export interface WalkDebug {
  /** Walk direction in IMAGE space (the downstream mirror-flip is applied
   *  later, in CvSource.setPrediction). null = neutral. */
  dir: WalkDir;
  /** Signed speed envelope driving the walk, body widths/frame. + = image-right. */
  vel: number;
  /** Envelope magnitude this frame (|vel|). */
  speed: number;
  /** Reference scale used this frame (shoulder width, floored). */
  scale: number;
  /** True while the envelope is coasting down after motion stopped. */
  coasting: boolean;
}

const NEUTRAL: WalkDebug = { dir: null, vel: 0, speed: 0, scale: 0, coasting: false };

/**
 * Fixed light smoothing on the torso centre, applied before velocity is
 * measured. Kills single-frame landmark jitter (~2–3 frame denoise) so a still
 * body reads as still. Not exposed — the tunable behaviour is the coast, which
 * shapes the release; this only cleans the raw signal.
 */
const CENTER_SMOOTH = 0.5;
/** Coast can approach but never reach 1, or the envelope would never decay. */
const MAX_COAST = 0.97;

/**
 * Velocity-based walk detection (normalised).
 *
 * You walk while you are MOVING and stop when you stop — the direct, momentary
 * feel. Two things make that usable rather than twitchy:
 *
 *   * Torso-only centre + shoulder-width normalisation, so the trigger is a
 *     speed in *body widths per frame* and means the same close to the camera
 *     or far back (the depth-independence we wanted to keep).
 *   * An asymmetric envelope: it snaps up instantly to new motion (you move →
 *     you walk, no lag on onset) but eases *down* at a tunable rate after you
 *     stop. That release rate is cv.walkCoast: 0 = stop the instant motion
 *     drops, →1 = a long glide. It's what lets a real walk — whose frame-to-
 *     frame speed naturally flickers — read as one continuous walk instead of
 *     stuttering, and it's the single knob for how sharply walking ends.
 *
 * Stateful: the pipeline holds one instance across frames and resets it when
 * the body leaves view.
 */
export class WalkTracker {
  private cxSmooth: number | null = null;
  private prevCx: number | null = null;
  /** Speed-magnitude envelope, body widths/frame. */
  private env = 0;
  /** Latched sign of the current motion (+1 image-right, -1 image-left). */
  private dirSign = 0;

  reset(): void {
    this.cxSmooth = null;
    this.prevCx = null;
    this.env = 0;
    this.dirSign = 0;
  }

  update(lms: NLandmark[]): WalkDebug {
    const pt = (i: number): NLandmark | null => {
      const lm = lms[i];
      return lm && (lm.visibility ?? 1) > 0.5 ? lm : null;
    };
    const ls = pt(L_SHOULDER), rs = pt(R_SHOULDER);
    const lh = pt(L_HIP), rh = pt(R_HIP);

    // Torso centre from whatever torso points are visible. Shoulders and hips
    // only — no face or limbs, so head-turns and arm-swings don't drift it.
    const torso = [ls, rs, lh, rh].filter((p): p is NLandmark => p !== null);
    if (torso.length < 2) return { ...NEUTRAL, speed: this.env };
    const cx = torso.reduce((s, p) => s + p.x, 0) / torso.length;

    // Reference scale: shoulder width (survives crouching, unlike torso
    // height); fall back to torso height if a shoulder is hidden; floor it so a
    // foreshortened torso when you turn can't spike the measured speed.
    let scale = ls && rs ? Math.abs(ls.x - rs.x) : 0;
    if (scale < MIN_REF_SCALE && (ls || rs) && (lh || rh)) {
      const sy = (ls ?? rs)!.y;
      const hy = (lh ?? rh)!.y;
      scale = Math.abs(hy - sy);
    }
    scale = Math.max(MIN_REF_SCALE, scale);

    // Denoise the centre, then take its frame-to-frame velocity.
    this.cxSmooth = this.cxSmooth === null
      ? cx
      : CENTER_SMOOTH * cx + (1 - CENTER_SMOOTH) * this.cxSmooth;
    if (this.prevCx === null) {
      this.prevCx = this.cxSmooth;
      return { dir: null, vel: 0, speed: 0, scale, coasting: false };
    }
    const d = (this.cxSmooth - this.prevCx) / scale;   // body widths / frame
    this.prevCx = this.cxSmooth;

    // Asymmetric envelope: instant attack, coasted release.
    const { walkThreshold, walkCoast } = TUNING.cv;
    const coast = Math.min(Math.max(walkCoast, 0), MAX_COAST);
    const mag = Math.abs(d);
    let coasting = false;
    if (mag >= this.env) {
      this.env = mag;                       // new/faster motion: respond now
      if (d !== 0) this.dirSign = Math.sign(d);
    } else {
      this.env *= coast;                    // slower/stopped: glide down
      coasting = true;
    }

    const dir: WalkDir =
      this.env > walkThreshold && this.dirSign !== 0
        ? (this.dirSign > 0 ? "RIGHT" : "LEFT")
        : null;

    return { dir, vel: this.dirSign * this.env, speed: this.env, scale, coasting };
  }
}

if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  // Dev handle: walk logic is only checkable synthetically here, since the
  // preview pane can't grant camera access. Feed it a moving fake torso —
  // velocity comes from the CHANGE in cx between frames, e.g.:
  //   const t = new window.__WalkTracker(), mk = (cx, sw=0.2) => {
  //     const a = Array(33).fill(0).map(() => ({x:0,y:0,visibility:0}));
  //     a[11]={x:cx-sw/2,y:.3,visibility:1}; a[12]={x:cx+sw/2,y:.3,visibility:1};
  //     a[23]={x:cx-sw/2,y:.7,visibility:1}; a[24]={x:cx+sw/2,y:.7,visibility:1};
  //     return a; };
  //   t.update(mk(0.50)); t.update(mk(0.47));  // stepped left → dir LEFT
  (window as unknown as Record<string, unknown>).__WalkTracker = WalkTracker;
}

// Skeleton connections for drawing
export const POSE_CONNECTIONS: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [24, 26], [25, 27], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32],
  [0, 1],  [1, 2],  [2, 3],  [3, 7],
  [0, 4],  [4, 5],  [5, 6],  [6, 8],
  [9, 10],
];

export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  lms: NLandmark[],
  w: number,
  h: number
) {
  ctx.strokeStyle = "rgba(255, 50, 50, 0.85)";
  ctx.lineWidth = 2;
  for (const [a, b] of POSE_CONNECTIONS) {
    const la = lms[a], lb = lms[b];
    if ((la?.visibility ?? 1) > 0.3 && (lb?.visibility ?? 1) > 0.3) {
      ctx.beginPath();
      ctx.moveTo(la.x * w, la.y * h);
      ctx.lineTo(lb.x * w, lb.y * h);
      ctx.stroke();
    }
  }
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  for (const lm of lms) {
    if ((lm.visibility ?? 1) > 0.3) {
      ctx.beginPath();
      ctx.arc(lm.x * w, lm.y * h, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
