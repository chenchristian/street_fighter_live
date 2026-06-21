"use client";
// ──────────────────────────────────────────────────────────────────────────────
// PixiJS canvas — renders the game world
// ──────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useCallback } from "react";
import type { GameState, CharState } from "@/lib/game/types";

// ─── Internal game-space constants ────────────────────────────────────────────
const GAME_WIDTH  = 2600;   // stage bounding box width (matches Training.json)
const GAME_HEIGHT = 800;

// ─── Props ───────────────────────────────────────────────────────────────────
interface GameCanvasProps {
  gameState: GameState | null;
}

// ─── Texture cache ────────────────────────────────────────────────────────────
const textureCache = new Map<string, HTMLImageElement>();

function getImage(name: string): HTMLImageElement | null {
  if (textureCache.has(name)) return textureCache.get(name)!;
  const img = new Image();
  img.src = `/assets/images/${name}.png`;
  img.onload = () => {}; // just let it load
  textureCache.set(name, img);
  return img.complete ? img : null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function GameCanvas({ gameState }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef   = useRef<number>(0);
  const gsRef     = useRef<GameState | null>(null);

  // Keep gsRef synced with incoming gameState prop
  useEffect(() => {
    gsRef.current = gameState;
  }, [gameState]);

  const draw = useCallback(() => {
    animRef.current = requestAnimationFrame(draw);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const gs = gsRef.current;

    const cw = canvas.width  = canvas.offsetWidth;
    const ch = canvas.height = canvas.offsetHeight;

    // Background
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, cw, ch);

    if (!gs) {
      ctx.fillStyle = "#444";
      ctx.font = "14px monospace";
      ctx.textAlign = "center";
      ctx.fillText("Loading game…", cw / 2, ch / 2);
      return;
    }

    // ── Coordinate helpers ──────────────────────────────────────────────────
    // Game X: -1300 … +1300 maps exactly to screen X: 0 … cw (static camera)
    const scale   = cw / GAME_WIDTH;

    const originX = cw / 2;             // game x=0 → screen center
    const floorY  = ch * 0.82;         // game y=0 → 82% down the canvas

    const gx = (x: number) => originX + x * scale;
    const gy = (y: number) => floorY  - y * scale;

    // ── Floor line ──────────────────────────────────────────────────────────
    ctx.fillStyle = "#222";
    ctx.fillRect(0, floorY, cw, ch - floorY);
    ctx.strokeStyle = "#555";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, floorY);
    ctx.lineTo(cw, floorY);
    ctx.stroke();

    // ── Draw characters ─────────────────────────────────────────────────────
    drawChar(ctx, gs.player, scale, gx, gy);
    drawChar(ctx, gs.cpu, scale, gx, gy);

    // ── Health bars ─────────────────────────────────────────────────────────
    drawHealthBars(ctx, gs, cw, ch);

    // ── Round timer ─────────────────────────────────────────────────────────
    const timerSecs = Math.ceil(gs.roundTimer / 60);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 20px monospace";
    ctx.textAlign = "center";
    ctx.fillText(String(timerSecs).padStart(2, "0"), cw / 2, 28);

    // ── KO screen ───────────────────────────────────────────────────────────
    if (gs.phase !== "playing") {
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, cw, ch);
      ctx.fillStyle = gs.winner === "player" ? "#e03" : "#fff";
      ctx.font = "bold 40px monospace";
      ctx.textAlign = "center";
      ctx.fillText(gs.winner === "player" ? "YOU WIN" : gs.winner === "cpu" ? "KO" : "DRAW", cw / 2, ch / 2);
    }
  }, []);

  useEffect(() => {
    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [draw]);

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full"
      style={{ imageRendering: "pixelated" }}
    />
  );
}

// ─── Draw a single character sprite ──────────────────────────────────────────

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

  // Width & height in screen pixels
  const sw = iw * scale;
  const sh = ih * scale;

  // Sprite anchor: the character's game-position maps to a point inside the sprite.
  // In OpenGL (y-up), the sprite was drawn at (pos[0]-420, pos[1]-86) bottom-left.
  // So the anchor x = ox/iw, anchor y (from top, y-down) = (ih + oy) / ih
  const anchorXRatio = ox / iw;          // ~0.5 for Ryu
  const anchorYRatio = (ih + oy) / ih;  // ~0.866 for Ryu (foot is near bottom)

  // Screen position of the character's origin point
  const screenX = gx(char.pos[0]);
  const screenY = gy(char.pos[1]);

  // Top-left of the sprite in screen space
  let drawX = screenX - anchorXRatio * sw;
  const drawY = screenY - anchorYRatio * sh;

  // Mirror: original sprites face LEFT; when face=1 (right), flip X
  const flipX = (char.face > 0) !== char.imageMirror[0];

  ctx.save();

  // Apply tint if not white
  const [tr, tg, tb, ta] = char.imageTint;
  const isTinted = tr !== 255 || tg !== 255 || tb !== 255 || ta !== 255;

  if (flipX) {
    // Mirror around the anchor X
    ctx.translate(screenX, 0);
    ctx.scale(-1, 1);
    ctx.translate(-screenX, 0);
    drawX = screenX - (1 - anchorXRatio) * sw;
  }

  if (img && img.complete && img.naturalWidth > 0) {
    if (isTinted) {
      // Draw to offscreen canvas then tint
      drawTinted(ctx, img, drawX, drawY, sw, sh, tr, tg, tb, ta / 255);
    } else {
      ctx.drawImage(img, drawX, drawY, sw, sh);
    }
  } else {
    // Placeholder until image loads
    ctx.fillStyle = char.team === 1 ? "rgba(255,80,80,0.5)" : "rgba(80,80,255,0.5)";
    ctx.fillRect(drawX, drawY, sw, sh);
  }

  ctx.restore();

  // Shadow (simple ellipse under character)
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = "#000";
  const shadowY = gy(0) + 2;
  const shadowW = 80 * scale;
  const shadowH = 12 * scale;
  ctx.beginPath();
  ctx.ellipse(gx(char.pos[0]), shadowY, shadowW / 2, shadowH / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Simple tint via globalCompositeOperation (faster than per-pixel manipulation)
function drawTinted(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number, y: number, w: number, h: number,
  r: number, g: number, b: number, a: number
): void {
  ctx.save();
  ctx.drawImage(img, x, y, w, h);
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = a;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

// ─── Health bars ─────────────────────────────────────────────────────────────

function drawHealthBars(
  ctx: CanvasRenderingContext2D,
  gs: GameState,
  cw: number,
  ch: number
): void {
  void ch;
  const barW   = cw * 0.38;
  const barH   = 12;
  const barY   = 8;
  const gap    = cw * 0.04;   // gap at center

  // Player bar (left, fills left to right)
  const pHealth = gs.player.gauges.health ?? 0;
  const pMax    = gs.player.data.gauges.health?.max ?? 200;
  const pPct    = Math.max(0, pHealth / pMax);

  const pBarX = cw / 2 - gap / 2 - barW;
  drawBar(ctx, pBarX, barY, barW, barH, pPct, true, "RYU");

  // CPU bar (right, fills right to left)
  const cHealth = gs.cpu.gauges.health ?? 0;
  const cMax    = gs.cpu.data.gauges.health?.max ?? 200;
  const cPct    = Math.max(0, cHealth / cMax);

  const cBarX = cw / 2 + gap / 2;
  drawBar(ctx, cBarX, barY, barW, barH, cPct, false, "KEN");
}

function drawBar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  pct: number,
  leftToRight: boolean,
  label: string
): void {
  // Background
  ctx.fillStyle = "#222";
  ctx.fillRect(x, y, w, h);

  // Health fill
  const fillW = w * pct;
  const color = pct > 0.5 ? "#0f9" : pct > 0.25 ? "#fa0" : "#f22";
  ctx.fillStyle = color;
  if (leftToRight) {
    ctx.fillRect(x, y, fillW, h);
  } else {
    ctx.fillRect(x + w - fillW, y, fillW, h);
  }

  // Border
  ctx.strokeStyle = "#555";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);

  // Label
  ctx.fillStyle = "#999";
  ctx.font = "9px monospace";
  ctx.textAlign = leftToRight ? "left" : "right";
  ctx.fillText(label, leftToRight ? x + 2 : x + w - 2, y + h - 2);
}
