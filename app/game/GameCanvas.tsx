"use client";
// ──────────────────────────────────────────────────────────────────────────────
// Renderer. Implements UI_SHELL_SPEC §1.
//
// ONE canvas, backing store permanently 384×224 (CPS-1 arcade resolution).
// Stage, sprites, HUD and menus all share that single pixel grid — nothing is
// drawn in DOM on top, and the backing store is never resized. Only the CSS
// size changes, driven by the shell's scaling algorithm.
// ──────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useCallback } from "react";
import type { GameState, CharState, BoxSet } from "@/lib/game/types";
import { worldBox } from "@/lib/game/collision";
import { buildStage, drawStage, type Stage } from "@/lib/render/stage";
import { drawText, textWidth, rgba } from "@/lib/render/font";
import { INK } from "@/lib/render/palette";

export const GAME_W = 384;
export const GAME_H = 224;

// Camera framing, in world units. Zoom is anchored to the vertical extent, so a
// ~310-unit-tall character keeps a constant on-screen size whatever the viewport
// aspect. 700 puts them at ~99px of the 224px screen — a little under half,
// which is the classic Street Fighter proportion and leaves the 384px width
// showing ~1200 units of stage rather than crowding the pair together.
const CAM_VIEW_HEIGHT = 700;
const CAM_MAX_WIDTH = 1500;
const CAM_PAD = 250;
const FLOOR_FRAC = 0.86;
const STAGE_HALF = 1300;

const BOX_COLORS: Record<string, string> = {
  hurtbox: "rgb(20,20,255)",
  hitbox: "rgb(255,20,20)",
  takebox: "rgb(20,255,255)",
  grabbox: "rgb(20,255,20)",
  pushbox: "rgb(255,0,255)",
  triggerbox: "rgb(255,128,0)",
  boundingbox: "rgb(255,255,255)",
};

// ─── Menu model, drawn in-canvas ─────────────────────────────────────────────

export interface MenuRow {
  label: string;
  value?: string;
}

export interface MenuModel {
  title: string;
  subtitle?: string;
  rows: MenuRow[];
  cursor: number;
  footer: string[];
}

interface GameCanvasProps {
  gameState: GameState | null;
  showBoxes?: boolean;
  /** CSS scale factor from the shell. Backing store stays 384×224. */
  scale: number;
  /** When set, drawn over a dimmed stage instead of the HUD. */
  menu?: MenuModel | null;
  /** Replaces the menu with a single centred status line. */
  status?: string | null;
}

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
  x: number;
  scale: number;
  floorPy: number;
}

function computeCamera(gs: GameState, prev: Camera | null): Camera {
  const px = gs.player.pos[0];
  const cx = gs.cpu.pos[0];

  const heightScale = GAME_H / CAM_VIEW_HEIGHT;
  const span = Math.abs(px - cx) + CAM_PAD * 2;
  const widthScale = GAME_W / Math.min(CAM_MAX_WIDTH, span);
  const scale = Math.min(heightScale, widthScale);

  const viewW = GAME_W / scale;
  let centre = (px + cx) / 2;

  // Clamp to the stage, with a little overscan so a cornered fighter is inset
  // from the frame edge rather than clipped by it.
  const overscan = 120;
  const limit = STAGE_HALF + overscan - viewW / 2;
  centre = limit <= 0 ? 0 : Math.max(-limit, Math.min(limit, centre));

  let floorPy = GAME_H * FLOOR_FRAC;
  const highest = Math.max(gs.player.pos[1], gs.cpu.pos[1]);
  const headroom = floorPy - highest * scale;
  if (headroom < GAME_H * 0.14) floorPy += GAME_H * 0.14 - headroom;

  const target: Camera = { x: centre, scale, floorPy };
  if (!prev) return target;

  const k = 0.12;
  return {
    x: prev.x + (target.x - prev.x) * k,
    scale: prev.scale + (target.scale - prev.scale) * k,
    floorPy: prev.floorPy + (target.floorPy - prev.floorPy) * k,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function GameCanvas({
  gameState, showBoxes = false, scale, menu = null, status = null,
}: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const gsRef = useRef<GameState | null>(null);
  const showBoxesRef = useRef(showBoxes);
  const menuRef = useRef<MenuModel | null>(menu);
  const statusRef = useRef<string | null>(status);
  const stageRef = useRef<Stage | null>(null);
  const camRef = useRef<Camera | null>(null);

  useEffect(() => { gsRef.current = gameState; }, [gameState]);
  useEffect(() => { showBoxesRef.current = showBoxes; }, [showBoxes]);
  useEffect(() => { menuRef.current = menu; }, [menu]);
  useEffect(() => { statusRef.current = status; }, [status]);

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    if (!stageRef.current) stageRef.current = buildStage();
    const stage = stageRef.current;
    const gs = gsRef.current;

    if (gs) {
      const cam = computeCamera(gs, camRef.current);
      camRef.current = cam;
      const gx = (x: number) => (x - cam.x) * cam.scale + GAME_W / 2;
      const gy = (y: number) => cam.floorPy - y * cam.scale;

      drawStage(ctx, stage, GAME_W, GAME_H, cam.x, Math.round(cam.floorPy));

      const objects = gs.objects ?? [gs.player, gs.cpu];
      // Characters last so projectiles and sparks never cover them.
      const ordered = [...objects].sort(
        (a, b) => (a.type === "character" ? 1 : 0) - (b.type === "character" ? 1 : 0)
      );
      for (const obj of ordered) drawChar(ctx, obj, cam.scale, gx, gy);

      if (showBoxesRef.current) {
        for (const obj of objects) drawBoxes(ctx, obj, cam.scale, gx, gy);
      }

      if (!menuRef.current && !statusRef.current) drawHud(ctx, gs);
    } else {
      // No game yet — show the stage behind the menu so the screen isn't dead.
      drawStage(ctx, stage, GAME_W, GAME_H, 0, Math.round(GAME_H * FLOOR_FRAC));
    }

    if (menuRef.current) drawMenu(ctx, menuRef.current);
    else if (statusRef.current) drawStatus(ctx, statusRef.current);
  }, []);

  useEffect(() => {
    const loop = () => {
      drawFrame();
      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [drawFrame]);

  // width/height attributes are fixed in JSX and never touched again; scaling is
  // purely CSS. Changing the attributes would reallocate the backing store at a
  // different resolution, which is the one thing the spec forbids outright.
  return (
    <canvas
      ref={canvasRef}
      id="game"
      width={GAME_W}
      height={GAME_H}
      style={{
        width: `${Math.round(GAME_W * scale)}px`,
        height: `${Math.round(GAME_H * scale)}px`,
      }}
    />
  );
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

  const anchorXRatio = ox / iw;
  const anchorYRatio = (ih + oy) / ih;

  const screenX = gx(char.pos[0]);
  const screenY = gy(char.pos[1]);

  let drawX = screenX - anchorXRatio * sw;
  const drawY = screenY - anchorYRatio * sh;

  // Source sprites face LEFT; flip when the character faces right.
  const flipX = char.face > 0 !== char.imageMirror[0];

  if (char.type === "character") {
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(gx(char.pos[0]), gy(0) + 1, (90 * scale) / 2, (10 * scale) / 2, 0, 0, Math.PI * 2);
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
    else ctx.drawImage(img, Math.round(drawX), Math.round(drawY), Math.round(sw), Math.round(sh));
  }
  ctx.restore();
}

const tintCanvas = typeof document !== "undefined" ? document.createElement("canvas") : null;

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
  // source-atop clips the fill to the sprite's own pixels; compositing straight
  // onto the scene would tint everything already drawn behind it.
  tctx.globalCompositeOperation = "source-atop";
  tctx.fillStyle = `rgb(${r},${g},${b})`;
  tctx.fillRect(0, 0, tw, th);
  tctx.globalCompositeOperation = "source-over";

  ctx.save();
  ctx.globalAlpha = a;
  ctx.drawImage(tintCanvas, 0, 0, tw, th, Math.round(x), Math.round(y), w, h);
  ctx.restore();
}

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
      ctx.strokeRect(
        Math.round(gx(wx)) + 0.5, Math.round(gy(wy + h)) + 0.5,
        Math.round(w * scale), Math.round(h * scale)
      );
    }
  }
  ctx.restore();
}

// ─── HUD, all inside the 384×224 grid ────────────────────────────────────────

const BAR_MARGIN = 5;
const BAR_W = 163;
const BAR_H = 7;
const BAR_Y = 5;

function drawHud(ctx: CanvasRenderingContext2D, gs: GameState): void {
  const pMax = gs.player.data.gauges.health?.max ?? 200;
  const cMax = gs.cpu.data.gauges.health?.max ?? 200;

  drawHealthBar(ctx, BAR_MARGIN, BAR_Y, (gs.player.gauges.health ?? 0) / pMax, true);
  drawHealthBar(ctx, GAME_W - BAR_MARGIN - BAR_W, BAR_Y, (gs.cpu.gauges.health ?? 0) / cMax, false);

  drawText(ctx, "RYU", BAR_MARGIN, BAR_Y + BAR_H + 2, { colour: INK.sand, outline: INK.black });
  drawText(ctx, "KEN", GAME_W - BAR_MARGIN, BAR_Y + BAR_H + 2, {
    colour: INK.sand, outline: INK.black, align: "right",
  });

  // Round timer, centred in the gap between the bars.
  const secs = Math.ceil(gs.roundTimer / 60);
  drawText(ctx, String(secs).padStart(2, "0"), GAME_W / 2, BAR_Y - 1, {
    colour: secs <= 10 ? INK.blood : INK.gold,
    outline: INK.black,
    scale: 2,
    align: "center",
  });

  // Best-of-3 pips, flanking the timer.
  drawPips(ctx, GAME_W / 2 - 14, BAR_Y + 17, gs.roundsWon[0], true);
  drawPips(ctx, GAME_W / 2 + 14, BAR_Y + 17, gs.roundsWon[1], false);

  // Super meters along the bottom.
  const sMax = gs.player.data.gauges.super?.max ?? 240;
  const sw = 110;
  const sy = GAME_H - 11;
  drawSuperBar(ctx, BAR_MARGIN, sy, sw, (gs.player.gauges.super ?? 0) / sMax, true);
  drawSuperBar(ctx, GAME_W - BAR_MARGIN - sw, sy, sw, (gs.cpu.gauges.super ?? 0) / sMax, false);

  // Combo counter.
  if (gs.combo && gs.combo.count >= 2) {
    const left = gs.combo.owner === "player";
    const x = left ? 8 : GAME_W - 8;
    const align = left ? "left" : "right";
    drawText(ctx, String(gs.combo.count), x, 74, {
      colour: INK.gold, outline: INK.black, scale: 3, align,
    });
    drawText(ctx, "HITS", x, 74 + 23, {
      colour: INK.paper, outline: INK.black, scale: 1, align,
    });
  }

  if (gs.announcer) drawAnnouncer(ctx, gs.announcer);

  if (gs.phase === "matchEnd") {
    const msg = gs.winner === "player" ? "YOU WIN" : "YOU LOSE";
    drawText(ctx, msg, GAME_W / 2, 122, {
      colour: gs.winner === "player" ? INK.ok : INK.blood,
      outline: INK.black,
      scale: 3,
      align: "center",
    });
  }
}

function drawAnnouncer(ctx: CanvasRenderingContext2D, text: string): void {
  const isKo = text === "KO!";
  const scale = isKo ? 5 : text.length > 6 ? 3 : 4;
  drawText(ctx, text, GAME_W / 2, 84, {
    colour: isKo ? INK.blood : INK.gold,
    outline: INK.black,
    scale,
    align: "center",
  });
}

function drawHealthBar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, pct: number, leftToRight: boolean
): void {
  const p = Math.max(0, Math.min(1, pct));
  ctx.fillStyle = "#000";
  ctx.fillRect(x - 1, y - 1, BAR_W + 2, BAR_H + 2);
  ctx.fillStyle = "#4a1f1f";
  ctx.fillRect(x, y, BAR_W, BAR_H);

  const fillW = Math.round(BAR_W * p);
  const fx = leftToRight ? x : x + BAR_W - fillW;
  ctx.fillStyle = p > 0.5 ? "#4ad46a" : p > 0.25 ? "#e8c33a" : "#e04b3a";
  ctx.fillRect(fx, y, fillW, BAR_H);
  // One-pixel bevel highlight along the top of the fill.
  ctx.fillStyle = "rgba(255,255,255,.30)";
  ctx.fillRect(fx, y, fillW, 1);

  ctx.fillStyle = "#d9b779";
  ctx.fillRect(x, y, BAR_W, 1);
  ctx.fillRect(x, y + BAR_H - 1, BAR_W, 1);
  ctx.fillRect(x, y, 1, BAR_H);
  ctx.fillRect(x + BAR_W - 1, y, 1, BAR_H);
}

function drawSuperBar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, pct: number, leftToRight: boolean
): void {
  const p = Math.max(0, Math.min(1, pct));
  const h = 5;
  const full = p >= 1;

  drawText(ctx, "SUPER", leftToRight ? x : x + w, y - 8, {
    colour: full ? INK.gold : INK.steel,
    outline: INK.black,
    align: leftToRight ? "left" : "right",
  });

  ctx.fillStyle = "#000";
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = "#20203a";
  ctx.fillRect(x, y, w, h);

  const fillW = Math.round(w * p);
  ctx.fillStyle = full ? "#ffe9b0" : "#4aa8e0";
  ctx.fillRect(leftToRight ? x : x + w - fillW, y, fillW, h);

  ctx.fillStyle = full ? "#ffd23a" : "#6a7fa8";
  ctx.fillRect(x, y, w, 1);
  ctx.fillRect(x, y + h - 1, w, 1);
}

function drawPips(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, won: number, leftward: boolean
): void {
  const size = 4;
  const gap = 7;
  for (let i = 0; i < 2; i++) {
    const px = Math.round(leftward ? x - i * gap : x + i * gap);
    ctx.fillStyle = "#000";
    ctx.fillRect(px - 1, y - 1, size + 2, size + 2);
    ctx.fillStyle = i < won ? "#ffd23a" : "#3a3346";
    ctx.fillRect(px, y, size, size);
  }
}

// ─── In-canvas menu ───────────────────────────────────────────────────────────

function dim(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "rgba(7,6,10,.78)";
  ctx.fillRect(0, 0, GAME_W, GAME_H);
}

function drawMenu(ctx: CanvasRenderingContext2D, menu: MenuModel): void {
  dim(ctx);

  drawText(ctx, menu.title, GAME_W / 2, 22, {
    colour: INK.gold, outline: INK.black, scale: 3, align: "center",
  });
  if (menu.subtitle) {
    drawText(ctx, menu.subtitle, GAME_W / 2, 48, {
      colour: INK.steel, outline: INK.black, align: "center",
    });
  }

  const startY = 76;
  const rowH = 16;
  for (let i = 0; i < menu.rows.length; i++) {
    const row = menu.rows[i];
    const y = startY + i * rowH;
    const selected = i === menu.cursor;

    if (selected) {
      ctx.fillStyle = "rgba(255,204,68,.14)";
      ctx.fillRect(56, y - 3, GAME_W - 112, rowH - 2);
      // Cursor caret
      drawText(ctx, "*", 62, y, { colour: INK.gold, outline: INK.black });
    }

    drawText(ctx, row.label, 76, y, {
      colour: selected ? INK.paper : INK.steel,
      outline: INK.black,
    });
    if (row.value) {
      drawText(ctx, row.value, GAME_W - 76, y, {
        colour: selected ? INK.gold : INK.sand,
        outline: INK.black,
        align: "right",
      });
    }
  }

  let fy = GAME_H - 8 - menu.footer.length * 9;
  for (const line of menu.footer) {
    drawText(ctx, line, GAME_W / 2, fy, {
      colour: INK.muted, outline: INK.black, align: "center",
    });
    fy += 9;
  }
}

function drawStatus(ctx: CanvasRenderingContext2D, status: string): void {
  dim(ctx);
  // Wrap on the caller's newlines; each line is centred.
  const lines = status.split("\n");
  let y = GAME_H / 2 - (lines.length * 12) / 2;
  for (const line of lines) {
    const big = line.startsWith("*");
    const text = big ? line.slice(1) : line;
    drawText(ctx, text, GAME_W / 2, y, {
      colour: big ? INK.gold : INK.steel,
      outline: INK.black,
      scale: big ? 3 : 1,
      align: "center",
    });
    y += big ? 26 : 12;
  }
}

/** Exposed so callers can size a room-code display without guessing. */
export const measureText = textWidth;
export const packColour = rgba;
