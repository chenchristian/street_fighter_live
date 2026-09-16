// ──────────────────────────────────────────────────────────────────────────────
// Procedural stage background — "Stage Rig" (behind-the-scenes movie set).
//
// No stage art ships with this project, so the backdrop is drawn from code, the
// same as the old pagoda stage it replaces. This one frames the fight like a
// filmed theatre stage: an overhead lighting truss with par-cans throwing
// coloured shafts, red curtains at the wings, and a plank floor.
//
// The truss, curtains and light shafts are a fixed proscenium — anchored to the
// viewport so the stage reads as a framed set — while the floor's plank seams
// and tape marks scroll with the camera so lateral movement still reads.
//
// Two rules keep it pixel-art rather than vector: flat fills on integer
// coordinates, and a dark centre void so the fighters (drawn on top) stay
// readable against it.
// ──────────────────────────────────────────────────────────────────────────────

/** Kept as an opaque handle so callers can cache one; the render is procedural. */
export interface Stage {
  readonly kind: "stagerig";
}

const PAL = {
  void0: "#171320",   // upper haze
  void1: "#0e0b12",   // stage void
  beamWarm: "rgba(255,200,110,.10)",
  beamCool: "rgba(90,150,255,.09)",
  beamPink: "rgba(255,90,160,.08)",
  truss: "#3a3a44",
  trussDark: "#26262e",
  parBody: "#2c2c34",
  parWarm: "#ffcf7a",
  parCool: "#7fb0ff",
  parPink: "#ff6aa2",
  curtainA: "#7a2531",
  curtainB: "#5e1a24",
  curtainHi: "#93303c",
  curtainDark: "#3f0f18",
  floor: "#3a2a1c",
  floorDark: "#2c2015",
  floorLip: "#5a4327",
  plankSeam: "#241a10",
  tape: "#d8d8d8",
} as const;

export function buildStage(): Stage {
  return { kind: "stagerig" };
}

/** Translucent light shaft, narrow at the lamp, wide at the floor. */
function beam(
  ctx: CanvasRenderingContext2D,
  cx: number, topW: number, botW: number, ty: number, by: number, colour: string
): void {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(cx - topW, ty);
  ctx.lineTo(cx + topW, ty);
  ctx.lineTo(cx + botW, by);
  ctx.lineTo(cx - botW, by);
  ctx.closePath();
  ctx.fill();
}

/** Overhead truss (lattice beam) with par-cans hung beneath at the lamp x's. */
function drawTruss(
  ctx: CanvasRenderingContext2D, w: number, cans: readonly [number, string][]
): void {
  const y = 4;
  ctx.fillStyle = PAL.truss;
  ctx.fillRect(0, y, w, 2);
  ctx.fillRect(0, y + 11, w, 2);
  ctx.strokeStyle = PAL.trussDark;
  ctx.lineWidth = 1;
  for (let i = 0; i < w; i += 16) {
    ctx.beginPath(); ctx.moveTo(i, y + 1.5); ctx.lineTo(i + 16, y + 11.5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(i + 16, y + 1.5); ctx.lineTo(i, y + 11.5); ctx.stroke();
  }
  for (const [cx, col] of cans) {
    ctx.fillStyle = PAL.parBody;
    ctx.fillRect(cx - 7, y + 13, 14, 9);
    ctx.fillStyle = col;
    ctx.fillRect(cx - 5, y + 20, 10, 3);
  }
}

/** A wing curtain of alternating folds, hung from the top down to the floor. */
function drawCurtain(
  ctx: CanvasRenderingContext2D, edgeX: number, width: number, floorPy: number, dir: 1 | -1
): void {
  const foldW = 8;
  for (let i = 0; i < width; i += foldW) {
    ctx.fillStyle = (Math.floor(i / foldW) % 2) ? PAL.curtainA : PAL.curtainB;
    const x = dir > 0 ? edgeX + i : edgeX - i - foldW;
    ctx.fillRect(x, 0, foldW, floorPy);
  }
  // Lit fold along the inner edge, dark hem along the bottom.
  ctx.fillStyle = PAL.curtainHi;
  ctx.fillRect(dir > 0 ? edgeX + width - 2 : edgeX - width, 0, 2, floorPy);
  ctx.fillStyle = PAL.curtainDark;
  ctx.fillRect(dir > 0 ? 0 : edgeX - width, floorPy - 7, width, 7);
}

/** Plank floor whose seams and tape marks scroll with the camera. */
function drawFloor(
  ctx: CanvasRenderingContext2D, w: number, h: number, floorPy: number, camX: number
): void {
  ctx.fillStyle = PAL.floor;
  ctx.fillRect(0, floorPy, w, h - floorPy);
  ctx.fillStyle = PAL.floorDark;
  ctx.fillRect(0, floorPy + 2, w, Math.round((h - floorPy) * 0.3));
  ctx.fillStyle = PAL.floorLip;
  ctx.fillRect(0, floorPy, w, 2);

  const tileW = 26;
  const sx = -(((camX + 100000) % tileW));
  ctx.fillStyle = PAL.plankSeam;
  for (let x = sx; x < w; x += tileW) {
    ctx.fillRect(Math.round(x), floorPy + 2, 1, h - floorPy - 2);
  }

  // Gaffer-tape marks, spaced out and drifting with the camera.
  const period = 760;
  const phase = ((camX % period) + period) % period;
  ctx.fillStyle = PAL.tape;
  for (let mx = 220 - phase; mx < w; mx += period) {
    if (mx > 6 && mx < w - 10) {
      ctx.fillRect(Math.round(mx), floorPy + 12, 7, 2);
      ctx.fillRect(Math.round(mx) + 2, floorPy + 8, 2, 6);
    }
  }
}

/**
 * Paint the stage into the low-res world buffer.
 *
 * @param camX     camera centre in world units (scrolls the floor)
 * @param floorPy  buffer y of the world floor
 */
export function drawStage(
  ctx: CanvasRenderingContext2D,
  _stage: Stage,
  w: number,
  h: number,
  camX: number,
  floorPy: number
): void {
  const fp = Math.round(floorPy);

  // Dark theatre void behind everything.
  ctx.fillStyle = PAL.void1;
  ctx.fillRect(0, 0, w, fp);
  ctx.fillStyle = PAL.void0;
  ctx.fillRect(0, 0, w, Math.round(fp * 0.45));

  // Coloured light shafts from the rig (fixed house lights).
  const px1 = Math.round(w * 0.30), px2 = Math.round(w * 0.50), px3 = Math.round(w * 0.70);
  beam(ctx, px1, 7, 30, 16, fp, PAL.beamWarm);
  beam(ctx, px2, 7, 34, 16, fp, PAL.beamCool);
  beam(ctx, px3, 7, 30, 16, fp, PAL.beamPink);

  // Wing curtains framing the stage.
  const cw = Math.max(34, Math.round(w * 0.13));
  drawCurtain(ctx, 0, cw, fp, 1);
  drawCurtain(ctx, w, cw, fp, -1);

  // Overhead truss with par-cans over each shaft.
  drawTruss(ctx, w, [[px1, PAL.parWarm], [px2, PAL.parCool], [px3, PAL.parPink]]);

  // Plank stage floor.
  drawFloor(ctx, w, h, fp, camX);
}
