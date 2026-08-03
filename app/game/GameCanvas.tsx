"use client";
// ──────────────────────────────────────────────────────────────────────────────
// Renderer.
//
// Two-stage pipeline. The world (stage + sprites + boxes) is drawn into a
// low-resolution offscreen buffer and then blitted to the display canvas with
// nearest-neighbour upscaling — that is what produces honest chunky pixels
// rather than a blurry stretch. The HUD is drawn afterwards at native
// resolution so text stays legible.
// ──────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useCallback } from "react";
import type { GameState, CharState, BoxSet } from "@/lib/game/types";
import { worldBox } from "@/lib/game/collision";
import { buildStage, drawStage, type Stage } from "@/lib/render/stage";

// Internal world-buffer height. SF3 ran at 384x224; matching that order of
// magnitude is what makes the pixel grid visible after upscaling.
const INTERNAL_H = 240;

// Camera framing, in world units.
//
// Zoom is anchored to the VERTICAL extent, not the horizontal one. Characters
// are ~310 units tall, so showing 640 units of height puts them at roughly half
// the screen — the classic Street Fighter framing — and keeps them that size no
// matter what aspect ratio the viewport happens to be.
const CAM_VIEW_HEIGHT = 640;
const CAM_MAX_WIDTH = 1600;   // widest pull-back before the camera stops zooming out
const CAM_PAD = 260;          // slack kept outside the pair
const FLOOR_FRAC = 0.88;      // where the world floor sits in the buffer

interface GameCanvasProps {
  gameState: GameState | null;
  showBoxes?: boolean;
}

const BOX_COLORS: Record<string, string> = {
  hurtbox: "rgb(20,20,255)",
  hitbox: "rgb(255,20,20)",
  takebox: "rgb(20,255,255)",
  grabbox: "rgb(20,255,20)",
  pushbox: "rgb(255,0,255)",
  triggerbox: "rgb(255,128,0)",
  boundingbox: "rgb(255,255,255)",
};

// ─── Texture cache ────────────────────────────────────────────────────────────
const textureCache = new Map<string, HTMLImageElement>();

function getImage(name: string): HTMLImageElement | null {
  let img = textureCache.get(name);
  if (!img) {
    img = new Image();
    img.src = `/assets/images/${name}.png`;
    textureCache.set(name, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

// ─── Camera ───────────────────────────────────────────────────────────────────

interface Camera {
  x: number;      // world centre
  scale: number;  // buffer px per world unit
  floorPy: number;
}

function computeCamera(gs: GameState, bufW: number, bufH: number, prev: Camera | null): Camera {
  const px = gs.player.pos[0];
  const cx = gs.cpu.pos[0];

  // Height sets the baseline zoom; the fighters only pull the camera further
  // out, never closer in, so they never grow past their framed size.
  const heightScale = bufH / CAM_VIEW_HEIGHT;
  const span = Math.abs(px - cx) + CAM_PAD * 2;
  const neededWidth = Math.min(CAM_MAX_WIDTH, span);
  const widthScale = bufW / neededWidth;
  const scale = Math.min(heightScale, widthScale);

  const viewW = bufW / scale;
  let centre = (px + cx) / 2;

  // Keep the camera inside the stage bounds (Training.json: -1300..+1300).
  const half = viewW / 2;
  centre = viewW >= 2600 ? 0 : Math.max(-1300 + half, Math.min(1300 - half, centre));

  let floorPy = bufH * FLOOR_FRAC;

  // Pan down (so the view rises) when someone jumps near the top of frame.
  const highest = Math.max(gs.player.pos[1], gs.cpu.pos[1]);
  const headroom = floorPy - highest * scale;
  if (headroom < bufH * 0.15) floorPy += bufH * 0.15 - headroom;

  const target: Camera = { x: centre, scale, floorPy };
  if (!prev) return target;

  // Smooth toward the target so zoom changes don't snap.
  const k = 0.12;
  return {
    x: prev.x + (target.x - prev.x) * k,
    scale: prev.scale + (target.scale - prev.scale) * k,
    floorPy: prev.floorPy + (target.floorPy - prev.floorPy) * k,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function GameCanvas({ gameState, showBoxes = false }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const gsRef = useRef<GameState | null>(null);
  const showBoxesRef = useRef(showBoxes);
  const bufRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<Stage | null>(null);
  const camRef = useRef<Camera | null>(null);

  useEffect(() => {
    showBoxesRef.current = showBoxes;
  }, [showBoxes]);

  useEffect(() => {
    gsRef.current = gameState;
  }, [gameState]);

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Size the display canvas to its CSS box at device resolution.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.offsetWidth;
    const cssH = canvas.offsetHeight;
    if (cssW === 0 || cssH === 0) return;
    const dispW = Math.round(cssW * dpr);
    const dispH = Math.round(cssH * dpr);
    if (canvas.width !== dispW || canvas.height !== dispH) {
      canvas.width = dispW;
      canvas.height = dispH;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    // World buffer: fixed height, width follows the panel's aspect ratio.
    const bufH = INTERNAL_H;
    const bufW = Math.max(160, Math.round(INTERNAL_H * (cssW / cssH)));
    let buf = bufRef.current;
    if (!buf || buf.width !== bufW || buf.height !== bufH) {
      buf = buf ?? document.createElement("canvas");
      buf.width = bufW;
      buf.height = bufH;
      bufRef.current = buf;
    }
    const bctx = buf.getContext("2d")!;
    bctx.imageSmoothingEnabled = false;

    if (!stageRef.current) stageRef.current = buildStage();
    const stage = stageRef.current;

    const gs = gsRef.current;

    if (!gs) {
      ctx.fillStyle = "#0b0810";
      ctx.fillRect(0, 0, dispW, dispH);
      ctx.fillStyle = "#443b55";
      ctx.font = `${Math.round(12 * dpr)}px monospace`;
      ctx.textAlign = "center";
      ctx.fillText("Loading game…", dispW / 2, dispH / 2);
      return;
    }

    // ── Camera ──
    const cam = computeCamera(gs, bufW, bufH, camRef.current);
    camRef.current = cam;
    const gx = (x: number) => (x - cam.x) * cam.scale + bufW / 2;
    const gy = (y: number) => cam.floorPy - y * cam.scale;

    // ── World ──
    drawStage(bctx, stage, bufW, bufH, cam.x, Math.round(cam.floorPy));

    const objects = gs.objects ?? [gs.player, gs.cpu];
    // Characters last so projectiles and sparks don't cover them.
    const ordered = [...objects].sort((a, b) => (a.type === "character" ? 1 : 0) - (b.type === "character" ? 1 : 0));
    for (const obj of ordered) drawChar(bctx, obj, cam.scale, gx, gy);

    if (showBoxesRef.current) {
      for (const obj of objects) drawBoxes(bctx, obj, cam.scale, gx, gy);
    }

    // ── Blit upscaled ──
    ctx.drawImage(buf, 0, 0, bufW, bufH, 0, 0, dispW, dispH);

    // ── HUD at native resolution ──
    drawHud(ctx, gs, dispW, dispH, dpr);
  }, []);

  useEffect(() => {
    const loop = () => {
      drawFrame();
      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [drawFrame]);

  return <canvas ref={canvasRef} className="h-full w-full" style={{ imageRendering: "pixelated" }} />;
}

// ─── Sprites ──────────────────────────────────────────────────────────────────

function drawChar(
  ctx: CanvasRenderingContext2D,
  char: CharState,
  scale: number,
  gx: (x: number) => number,
  gy: (y: number) => number
): void {
  const img = getImage(char.image);

  const [iw, ih] = char.imageSize;
  const [ox, oy] = char.imageOffset;
  const sw = iw * scale;
  const sh = ih * scale;

  // The sprite quad's origin sits at image_offset within it, so the character's
  // world position maps to that point: anchorX across, anchorY down from top.
  const anchorXRatio = ox / iw;
  const anchorYRatio = (ih + oy) / ih;

  const screenX = gx(char.pos[0]);
  const screenY = gy(char.pos[1]);

  let drawX = screenX - anchorXRatio * sw;
  const drawY = screenY - anchorYRatio * sh;

  // Source sprites face LEFT; flip when the character faces right.
  const flipX = char.face > 0 !== char.imageMirror[0];

  // Shadow first, so the character sits on top of it.
  if (char.type === "character") {
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = "#000";
    const shadowW = 90 * scale;
    const shadowH = 10 * scale;
    ctx.beginPath();
    ctx.ellipse(gx(char.pos[0]), gy(0) + 1, shadowW / 2, shadowH / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  if (flipX) {
    ctx.translate(screenX, 0);
    ctx.scale(-1, 1);
    ctx.translate(-screenX, 0);
    drawX = screenX - (1 - anchorXRatio) * sw;
  }

  const [tr, tg, tb, ta] = char.imageTint;
  const isTinted = tr !== 255 || tg !== 255 || tb !== 255 || ta !== 255;

  if (img) {
    if (isTinted) drawTinted(ctx, img, drawX, drawY, sw, sh, tr, tg, tb, ta / 255);
    else ctx.drawImage(img, drawX, drawY, sw, sh);
  }
  ctx.restore();
}

/**
 * Tint without destroying the sprite's alpha.
 *
 * Compositing straight onto the world buffer would tint everything already
 * drawn behind the sprite, so the work happens on a scratch canvas where
 * `source-atop` can be clipped to the sprite's own pixels.
 */
const tintCanvas =
  typeof document !== "undefined" ? document.createElement("canvas") : null;

function drawTinted(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number, y: number, w: number, h: number,
  r: number, g: number, b: number, a: number
): void {
  if (!tintCanvas || w <= 0 || h <= 0) return;
  const tw = Math.max(1, Math.ceil(w));
  const th = Math.max(1, Math.ceil(h));
  if (tintCanvas.width < tw || tintCanvas.height < th) {
    tintCanvas.width = Math.max(tintCanvas.width, tw);
    tintCanvas.height = Math.max(tintCanvas.height, th);
  }
  const tctx = tintCanvas.getContext("2d")!;
  tctx.imageSmoothingEnabled = false;
  tctx.clearRect(0, 0, tw, th);
  tctx.globalCompositeOperation = "source-over";
  tctx.drawImage(img, 0, 0, tw, th);
  tctx.globalCompositeOperation = "source-atop";
  tctx.fillStyle = `rgb(${r},${g},${b})`;
  tctx.fillRect(0, 0, tw, th);
  tctx.globalCompositeOperation = "source-over";

  ctx.save();
  ctx.globalAlpha = a;
  ctx.drawImage(tintCanvas, 0, 0, tw, th, x, y, w, h);
  ctx.restore();
}

// ─── Debug boxes ──────────────────────────────────────────────────────────────

function drawBoxes(
  ctx: CanvasRenderingContext2D,
  char: CharState,
  scale: number,
  gx: (x: number) => number,
  gy: (y: number) => number
): void {
  ctx.save();
  ctx.lineWidth = 1;
  for (const boxType in char.boxes) {
    const set = char.boxes[boxType] as BoxSet;
    if (!set?.boxes?.length) continue;
    ctx.strokeStyle = BOX_COLORS[boxType] ?? "#888";
    for (const box of set.boxes) {
      const [wx, wy, w, h] = worldBox(box, char);
      ctx.strokeRect(gx(wx), gy(wy + h), w * scale, h * scale);
    }
  }
  ctx.strokeStyle = "#fff";
  const cx = gx(char.pos[0]);
  const cy = gy(char.pos[1]);
  ctx.beginPath();
  ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy);
  ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6);
  ctx.stroke();
  ctx.restore();
}

// ─── HUD ──────────────────────────────────────────────────────────────────────

function drawHud(
  ctx: CanvasRenderingContext2D,
  gs: GameState,
  w: number,
  h: number,
  dpr: number
): void {
  const u = (n: number) => n * dpr;
  const barW = w * 0.4;
  const barH = u(14);
  const barY = u(10);
  const gap = w * 0.06;

  const pMax = gs.player.data.gauges.health?.max ?? 200;
  const cMax = gs.cpu.data.gauges.health?.max ?? 200;

  drawHealthBar(ctx, w / 2 - gap / 2 - barW, barY, barW, barH, (gs.player.gauges.health ?? 0) / pMax, true, dpr);
  drawHealthBar(ctx, w / 2 + gap / 2, barY, barW, barH, (gs.cpu.gauges.health ?? 0) / cMax, false, dpr);

  // Names
  ctx.font = `bold ${u(10)}px monospace`;
  ctx.fillStyle = "#d8cfa8";
  ctx.textAlign = "left";
  ctx.fillText("RYU", w / 2 - gap / 2 - barW, barY + barH + u(11));
  ctx.textAlign = "right";
  ctx.fillText("KEN", w / 2 + gap / 2 + barW, barY + barH + u(11));

  // ── Round timer ──
  const secs = Math.ceil(gs.roundTimer / 60);
  ctx.textAlign = "center";
  ctx.font = `bold ${u(28)}px monospace`;
  ctx.lineWidth = u(3);
  ctx.strokeStyle = "#120c1c";
  ctx.strokeText(String(secs).padStart(2, "0"), w / 2, barY + u(26));
  ctx.fillStyle = secs <= 10 ? "#ff5a4a" : "#ffe9b0";
  ctx.fillText(String(secs).padStart(2, "0"), w / 2, barY + u(26));

  // ── Round pips (best of 3) ──
  drawPips(ctx, w / 2 - gap / 2 - u(10), barY + u(34), gs.roundsWon[0], dpr, true);
  drawPips(ctx, w / 2 + gap / 2 + u(10), barY + u(34), gs.roundsWon[1], dpr, false);

  // ── Super meters ──
  const sMax = gs.player.data.gauges.super?.max ?? 240;
  const sw = w * 0.26;
  const sh = u(9);
  const sy = h - u(34);
  drawSuperBar(ctx, u(16), sy, sw, sh, (gs.player.gauges.super ?? 0) / sMax, true, dpr);
  drawSuperBar(ctx, w - u(16) - sw, sy, sw, sh, (gs.cpu.gauges.super ?? 0) / sMax, false, dpr);

  // ── Combo counter ──
  if (gs.combo && gs.combo.count >= 2) {
    const left = gs.combo.owner === "player";
    const x = left ? u(24) : w - u(24);
    const y = h * 0.36;
    ctx.textAlign = left ? "left" : "right";
    ctx.font = `bold ${u(30)}px monospace`;
    ctx.lineWidth = u(4);
    ctx.strokeStyle = "#120c1c";
    ctx.strokeText(`${gs.combo.count}`, x, y);
    ctx.fillStyle = "#ffd23a";
    ctx.fillText(`${gs.combo.count}`, x, y);
    ctx.font = `bold ${u(12)}px monospace`;
    ctx.strokeText("HITS", x, y + u(14));
    ctx.fillStyle = "#ffe9b0";
    ctx.fillText("HITS", x, y + u(14));
  }

  // ── Announcer ──
  if (gs.announcer) {
    const isKo = gs.announcer === "KO!";
    ctx.textAlign = "center";
    ctx.font = `bold ${u(isKo ? 64 : 44)}px monospace`;
    ctx.lineWidth = u(6);
    ctx.strokeStyle = "#120c1c";
    ctx.strokeText(gs.announcer, w / 2, h * 0.45);
    ctx.fillStyle = isKo ? "#ff3b30" : "#ffe9b0";
    ctx.fillText(gs.announcer, w / 2, h * 0.45);
  }

  // ── Match result ──
  if (gs.phase === "matchEnd") {
    ctx.textAlign = "center";
    ctx.font = `bold ${u(34)}px monospace`;
    ctx.lineWidth = u(5);
    ctx.strokeStyle = "#120c1c";
    const msg = gs.winner === "player" ? "YOU WIN" : "YOU LOSE";
    ctx.strokeText(msg, w / 2, h * 0.6);
    ctx.fillStyle = gs.winner === "player" ? "#5ce08a" : "#ff5a4a";
    ctx.fillText(msg, w / 2, h * 0.6);
  }
}

function drawHealthBar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  pct: number, leftToRight: boolean, dpr: number
): void {
  const p = Math.max(0, Math.min(1, pct));
  ctx.fillStyle = "#120c1c";
  ctx.fillRect(x - dpr, y - dpr, w + dpr * 2, h + dpr * 2);
  ctx.fillStyle = "#4a1f1f";
  ctx.fillRect(x, y, w, h);

  const fillW = w * p;
  const fx = leftToRight ? x : x + w - fillW;
  ctx.fillStyle = p > 0.5 ? "#4ad46a" : p > 0.25 ? "#e8c33a" : "#e04b3a";
  ctx.fillRect(fx, y, fillW, h);
  // Highlight strip along the top of the fill — reads as a bevel.
  ctx.fillStyle = "rgba(255,255,255,0.28)";
  ctx.fillRect(fx, y, fillW, Math.max(1, h * 0.22));

  ctx.strokeStyle = "#d8cfa8";
  ctx.lineWidth = dpr;
  ctx.strokeRect(x, y, w, h);
}

function drawSuperBar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  pct: number, leftToRight: boolean, dpr: number
): void {
  const p = Math.max(0, Math.min(1, pct));
  ctx.fillStyle = "#120c1c";
  ctx.fillRect(x - dpr, y - dpr, w + dpr * 2, h + dpr * 2);
  ctx.fillStyle = "#20203a";
  ctx.fillRect(x, y, w, h);

  const fillW = w * p;
  const fx = leftToRight ? x : x + w - fillW;
  // Flash when the meter is full and a super is available.
  const full = p >= 1;
  ctx.fillStyle = full ? "#ffe9b0" : "#4aa8e0";
  ctx.fillRect(fx, y, fillW, h);

  ctx.strokeStyle = full ? "#ffd23a" : "#6a7fa8";
  ctx.lineWidth = dpr;
  ctx.strokeRect(x, y, w, h);

  ctx.font = `bold ${8 * dpr}px monospace`;
  ctx.fillStyle = "#9fb3d0";
  ctx.textAlign = leftToRight ? "left" : "right";
  ctx.fillText("SUPER", leftToRight ? x : x + w, y - 3 * dpr);
}

function drawPips(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, won: number, dpr: number, leftward: boolean
): void {
  const r = 5 * dpr;
  const gap = 14 * dpr;
  for (let i = 0; i < 2; i++) {
    const px = leftward ? x - i * gap : x + i * gap;
    ctx.beginPath();
    ctx.arc(px, y, r, 0, Math.PI * 2);
    ctx.fillStyle = i < won ? "#ffd23a" : "#3a3346";
    ctx.fill();
    ctx.strokeStyle = "#120c1c";
    ctx.lineWidth = dpr;
    ctx.stroke();
  }
}
