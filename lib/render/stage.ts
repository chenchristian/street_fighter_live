// ──────────────────────────────────────────────────────────────────────────────
// Procedural 16-bit stage background.
//
// No stage art ships with this project — Castle.json points at "castle SF3/
// stage11..13" PNGs that exist in neither repo. Rather than invent asset files
// next to the curated SF3 sprites, the stage is drawn from code into parallax
// layer canvases, once, at load.
//
// Two rules make this read as 16-bit pixel art rather than as vector shapes:
//
//   * Flat fills only, on a low-resolution buffer, with integer coordinates.
//     No per-pixel gradients, no antialiased curves.
//   * A hard value ramp between depth layers. Sky is lightest at the horizon,
//     and each layer forward is a clear step darker. Without that separation
//     the silhouettes disappear into each other and the stage reads as mud.
// ──────────────────────────────────────────────────────────────────────────────

import { Rng } from "../game/rng";

const LAYER_H = 200;

export interface StageLayer {
  canvas: HTMLCanvasElement;
  /** 0 = painted on the sky and never moves, 1 = moves with the world. */
  parallax: number;
  /** Height of the layer's baseline above the world floor, in buffer px. */
  baseAboveFloor: number;
}

export interface Stage {
  layers: StageLayer[];
}

// Value ramp, lightest to darkest: sky horizon -> far hills -> treeline/temple
// -> courtyard wall -> floor shadow. Each step is a clear jump in luminance.
const PAL = {
  skyTop: "#1b2a5e",
  skyHigh: "#3f3d86",
  skyMid: "#8a5590",
  skyWarm: "#d97a6e",
  skyHorizon: "#f5b26b",
  sun: "#fff1c4",
  sunRim: "#ffcf7a",

  hillFar: "#8d6a9c",
  hillNear: "#6b4d7e",

  treeDark: "#2f4038",
  treeMid: "#3d5546",
  templeBody: "#4a3550",
  templeBodyHi: "#5d4463",
  templeRoof: "#a83f4e",
  templeRoofHi: "#d1616a",
  templeTrim: "#f0c07a",

  wall: "#3b2d3f",
  wallHi: "#584458",
  wallPost: "#2a2030",
  wallCap: "#6d5468",

  floorLip: "#c98a5a",
  floorA: "#7d5a44",
  floorB: "#6a4b39",
  floorSeam: "#4a3428",
} as const;

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

/** Rolling hills — overlapping triangles with hard edges. */
function drawHills(
  ctx: CanvasRenderingContext2D,
  w: number,
  baseY: number,
  color: string,
  rng: Rng,
  minH: number,
  maxH: number
): void {
  ctx.fillStyle = color;
  let x = -80;
  while (x < w + 80) {
    const peakH = minH + rng.next() * (maxH - minH);
    const halfW = peakH * (1.1 + rng.next() * 0.8);
    ctx.beginPath();
    ctx.moveTo(Math.round(x), baseY);
    ctx.lineTo(Math.round(x + halfW), Math.round(baseY - peakH));
    ctx.lineTo(Math.round(x + halfW * 2), baseY);
    ctx.closePath();
    ctx.fill();
    x += halfW * (1.0 + rng.next() * 0.5);
  }
  // Flat skirt so no sky shows through between the triangle feet.
  ctx.fillRect(0, baseY - 2, w, 3);
}

/** Pagoda: stacked tiers, each a body block under a wider stepped roof. */
function drawPagoda(
  ctx: CanvasRenderingContext2D,
  cx: number,
  baseY: number,
  scale: number,
  tiers: number
): void {
  let y = baseY;
  let bodyW = 30 * scale;
  const tierH = 17 * scale;

  for (let t = 0; t < tiers; t++) {
    const bx = Math.round(cx - bodyW / 2);
    const bw = Math.round(bodyW);
    ctx.fillStyle = PAL.templeBody;
    ctx.fillRect(bx, Math.round(y - tierH), bw, Math.round(tierH));
    // Lit left face, so the tier reads as a solid rather than a flat rectangle.
    ctx.fillStyle = PAL.templeBodyHi;
    ctx.fillRect(bx, Math.round(y - tierH), Math.max(1, Math.round(bw * 0.28)), Math.round(tierH));
    // Window slits
    ctx.fillStyle = PAL.templeTrim;
    const wins = Math.max(1, Math.round(bodyW / 12));
    for (let i = 0; i < wins; i++) {
      ctx.fillRect(
        Math.round(bx + bw * ((i + 0.5) / wins) - 1),
        Math.round(y - tierH * 0.7),
        2,
        Math.max(2, Math.round(tierH * 0.3))
      );
    }

    // Stepped roof — drawn a scanline at a time so edges stay hard.
    const roofW = bodyW * 1.8;
    const roofH = Math.max(4, Math.round(7 * scale));
    for (let s = 0; s < roofH; s++) {
      const f = s / roofH;
      const wAt = roofW * (1 - f * 0.45);
      ctx.fillStyle = s === 0 ? PAL.templeRoofHi : PAL.templeRoof;
      ctx.fillRect(Math.round(cx - wAt / 2), Math.round(y - tierH - roofH + s), Math.round(wAt), 1);
    }
    // Upturned eaves
    ctx.fillStyle = PAL.templeRoofHi;
    ctx.fillRect(Math.round(cx - roofW / 2), Math.round(y - tierH - roofH - 1), 3, 2);
    ctx.fillRect(Math.round(cx + roofW / 2 - 3), Math.round(y - tierH - roofH - 1), 3, 2);

    y -= tierH + roofH;
    bodyW *= 0.8;
  }

  ctx.fillStyle = PAL.templeTrim;
  ctx.fillRect(Math.round(cx - 1), Math.round(y - 6 * scale), 2, Math.round(6 * scale));
}

/** Conifer silhouette — stacked triangles. */
function drawTree(ctx: CanvasRenderingContext2D, cx: number, baseY: number, h: number, color: string): void {
  ctx.fillStyle = color;
  for (let t = 0; t < 3; t++) {
    const f = t / 3;
    const tierY = baseY - h * (0.22 + f * 0.6);
    const halfW = h * 0.3 * (1 - f * 0.4);
    const tierH = h * 0.36;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx), Math.round(tierY - tierH));
    ctx.lineTo(Math.round(cx - halfW), Math.round(tierY));
    ctx.lineTo(Math.round(cx + halfW), Math.round(tierY));
    ctx.closePath();
    ctx.fill();
  }
}

export function buildStage(seed = 0x5f3a91): Stage {
  const rng = new Rng(seed);

  // ── Far: hills ──
  const farW = 760;
  const [farCanvas, far] = makeCanvas(farW, LAYER_H);
  drawHills(far, farW, LAYER_H, PAL.hillFar, rng, 26, 58);
  drawHills(far, farW, LAYER_H, PAL.hillNear, rng, 16, 36);

  // ── Mid: temple and treeline ──
  const midW = 1040;
  const [midCanvas, mid] = makeCanvas(midW, LAYER_H);
  drawPagoda(mid, Math.round(midW * 0.24), LAYER_H, 1.7, 4);
  drawPagoda(mid, Math.round(midW * 0.68), LAYER_H, 1.15, 3);
  for (let i = 0; i < 30; i++) {
    const x = rng.next() * midW;
    const h = 26 + rng.next() * 30;
    drawTree(mid, x, LAYER_H, h, rng.chance(0.5) ? PAL.treeDark : PAL.treeMid);
  }

  // ── Near: courtyard wall ──
  // Deliberately short. A tall wall becomes a featureless slab behind the
  // fighters and hides everything built above it.
  const nearW = 880;
  const wallH = 34;
  const [nearCanvas, near] = makeCanvas(nearW, LAYER_H);
  const top = LAYER_H - wallH;
  near.fillStyle = PAL.wall;
  near.fillRect(0, top, nearW, wallH);
  near.fillStyle = PAL.wallCap;              // coping along the top
  near.fillRect(0, top, nearW, 3);
  near.fillStyle = PAL.wallHi;
  near.fillRect(0, top + 3, nearW, 2);
  near.fillStyle = PAL.wallPost;
  for (let x = 0; x < nearW; x += 44) {
    near.fillRect(x, top + 5, 4, wallH - 5);           // posts
  }
  near.fillStyle = "rgba(0,0,0,0.25)";
  near.fillRect(0, LAYER_H - 6, nearW, 6);             // grounding shadow

  return {
    layers: [
      { canvas: farCanvas, parallax: 0.1, baseAboveFloor: 44 },
      { canvas: midCanvas, parallax: 0.26, baseAboveFloor: 30 },
      { canvas: nearCanvas, parallax: 0.5, baseAboveFloor: 0 },
    ],
  };
}

/**
 * Paint the stage into the low-res world buffer.
 *
 * @param camX     camera centre in world units
 * @param floorPy  buffer y of the world floor
 */
export function drawStage(
  ctx: CanvasRenderingContext2D,
  stage: Stage,
  w: number,
  h: number,
  camX: number,
  floorPy: number
): void {
  // ── Sky: flat bands, lightest at the horizon ──
  const bands: [number, string][] = [
    [0.0, PAL.skyTop],
    [0.26, PAL.skyHigh],
    [0.5, PAL.skyMid],
    [0.7, PAL.skyWarm],
    [0.85, PAL.skyHorizon],
  ];
  for (let i = 0; i < bands.length; i++) {
    const y0 = Math.round(bands[i][0] * floorPy);
    const y1 = Math.round((bands[i + 1]?.[0] ?? 1) * floorPy);
    ctx.fillStyle = bands[i][1];
    ctx.fillRect(0, y0, w, y1 - y0);
  }

  // Sun, low and behind the hills so they occlude its base.
  const sunR = Math.max(6, Math.round(h * 0.052));
  const sunX = Math.round(w * 0.5 - camX * 0.02);
  const sunY = Math.round(floorPy - h * 0.2);
  ctx.fillStyle = PAL.sunRim;
  ctx.beginPath();
  ctx.arc(sunX, sunY, sunR + 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = PAL.sun;
  ctx.beginPath();
  ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
  ctx.fill();

  // ── Parallax layers, tiled horizontally ──
  for (const layer of stage.layers) {
    const lw = layer.canvas.width;
    const y = Math.round(floorPy - layer.baseAboveFloor - layer.canvas.height);
    let offset = -((camX * layer.parallax) % lw);
    if (offset > 0) offset -= lw;
    for (let x = offset; x < w; x += lw) {
      ctx.drawImage(layer.canvas, Math.round(x), y);
    }
  }

  // ── Floor ──
  ctx.fillStyle = PAL.floorLip;
  ctx.fillRect(0, floorPy, w, 2);
  ctx.fillStyle = PAL.floorA;
  ctx.fillRect(0, floorPy + 2, w, h - floorPy);

  // Receding bands: rows get taller toward the viewer, and the tile seams
  // scroll with the world so lateral movement reads clearly.
  const rows = 6;
  const depth = h - floorPy - 2;
  for (let r = 0; r < rows; r++) {
    const yTop = floorPy + 2 + Math.round(depth * (r / rows) ** 1.7);
    const yBot = floorPy + 2 + Math.round(depth * ((r + 1) / rows) ** 1.7);
    if (r % 2 === 1) {
      ctx.fillStyle = PAL.floorB;
      ctx.fillRect(0, yTop, w, yBot - yTop);
    }
    const tileW = 30 + r * 16;
    ctx.fillStyle = PAL.floorSeam;
    const sx = -((camX + 100000) % tileW);
    for (let x = sx; x < w; x += tileW) {
      ctx.fillRect(Math.round(x), yTop, 1, yBot - yTop);
    }
  }
}
