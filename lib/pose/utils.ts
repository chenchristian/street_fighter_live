// Mirrors the filtering logic from pose_worker.py

export const REMOVE_INDICES = new Set([1, 3, 4, 6, 17, 18, 19, 20, 21, 22, 31, 32]);

// Landmarks used for left/right movement detection (body + face, no hands/feet)
const BODY_FACE_INDICES = [0,2,5,7,8,9,10,11,12,13,14,15,16,23,24,25,26,27,28,29,30];

export const SEQUENCE_LENGTH = 5;
export const CONFIDENCE_THRESHOLD = 0.8;
export const MOVEMENT_THRESHOLD = 0.015;
export const EDGE_THRESHOLD = 0.15;

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

export function detectMovement(
  lms: NLandmark[],
  prevCx: number | null
): { dir: "LEFT" | "RIGHT" | null; cx: number | null } {
  const vis = BODY_FACE_INDICES
    .map(i => lms[i])
    .filter(lm => lm && (lm.visibility ?? 1) > 0.5);

  if (!vis.length) return { dir: null, cx: null };

  const cx = vis.reduce((s, lm) => s + lm.x, 0) / vis.length;

  if (cx >= 1 - EDGE_THRESHOLD) return { dir: "RIGHT", cx };
  if (cx <= EDGE_THRESHOLD)      return { dir: "LEFT",  cx };
  if (prevCx === null)           return { dir: null, cx };

  const diff = cx - prevCx;
  if (diff >  MOVEMENT_THRESHOLD) return { dir: "RIGHT", cx };
  if (diff < -MOVEMENT_THRESHOLD) return { dir: "LEFT",  cx };
  return { dir: null, cx };
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
