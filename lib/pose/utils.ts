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
  /** Signed displacement from home, in body widths. + = image-right. */
  deltaNorm: number;
  /** Current resting-centre x (normalised frame coords), null before seeded. */
  baseline: number | null;
  /** Reference scale used this frame (shoulder width, floored). */
  scale: number;
  /** True if the baseline was held this frame (i.e. you were displaced). */
  frozen: boolean;
}

const NEUTRAL: WalkDebug = { dir: null, deltaNorm: 0, baseline: null, scale: 0, frozen: false };

/**
 * Position-based walk detection.
 *
 * The old detector measured frame-to-frame VELOCITY: you walked only while you
 * were physically moving, so a held lean decayed to neutral the instant you
 * stopped. This measures DISPLACEMENT from a slowly-adapting resting centre
 * ("home") instead — so leaning off-centre and holding keeps you walking, the
 * way a joystick held to one side keeps the fighter moving. Step back to home
 * to stop.
 *
 * Home follows you (EMA) only while you are near neutral; it FREEZES the moment
 * you lean past the walk threshold, so an intentional hold is never quietly
 * absorbed into home. That freeze is the one subtle rule the whole feel rests
 * on — see the block-decay note in lib/tuning.ts (cv.baselineAdapt).
 *
 * Stateful, so it lives as an instance the pipeline holds across frames and
 * resets when the body leaves view.
 */
export class WalkTracker {
  private baseline: number | null = null;

  reset(): void {
    this.baseline = null;
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
    if (torso.length < 2) return NEUTRAL;
    const cx = torso.reduce((s, p) => s + p.x, 0) / torso.length;

    // Reference scale: shoulder width (survives crouching, unlike torso
    // height); fall back to torso height if a shoulder is hidden; floor it so a
    // foreshortened torso when you turn can't spike the displacement.
    let scale = ls && rs ? Math.abs(ls.x - rs.x) : 0;
    if (scale < MIN_REF_SCALE && (ls || rs) && (lh || rh)) {
      const sy = (ls ?? rs)!.y;
      const hy = (lh ?? rh)!.y;
      scale = Math.abs(hy - sy);
    }
    scale = Math.max(MIN_REF_SCALE, scale);

    // Seed home on first sight, so the first frame reads as dead neutral rather
    // than a huge jump from nothing.
    if (this.baseline === null) this.baseline = cx;

    const deltaNorm = (cx - this.baseline) / scale;

    // Direction: displacement past the threshold, or the edge failsafe.
    const { walkThreshold, walkEdge, baselineAdapt } = TUNING.cv;
    let dir: WalkDir = null;
    if (cx >= 1 - walkEdge) dir = "RIGHT";
    else if (cx <= walkEdge) dir = "LEFT";
    else if (deltaNorm > walkThreshold) dir = "RIGHT";
    else if (deltaNorm < -walkThreshold) dir = "LEFT";

    // Freeze home while displaced; only let it drift when neutral.
    const frozen = dir !== null;
    if (!frozen) this.baseline = baselineAdapt * cx + (1 - baselineAdapt) * this.baseline;

    return { dir, deltaNorm, baseline: this.baseline, scale, frozen };
  }
}

if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  // Dev handle: the freeze policy is only checkable synthetically here, since
  // the preview pane can't grant camera access. Drive it from the console with
  // a fake torso, e.g.:
  //   const t = new window.__WalkTracker();
  //   const f = (cx, sw=0.2) => t.update([]
  //     .concat(Array(11).fill({x:0,y:0,visibility:0}))
  //     .concat([{x:cx-sw/2,y:.3,visibility:1},{x:cx+sw/2,y:.3,visibility:1}])
  //     .concat(Array(10).fill({x:0,y:0,visibility:0}))
  //     .concat([{x:cx-sw/2,y:.7,visibility:1},{x:cx+sw/2,y:.7,visibility:1}]));
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
