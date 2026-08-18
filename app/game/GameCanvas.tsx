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
import { getImage, noteHeldPrevious } from "@/lib/render/textures";
import { INK } from "@/lib/render/palette";
import { TUNING } from "@/lib/tuning";

export const GAME_W = 384;
export const GAME_H = 224;

// Camera framing, in world units.
//
// The rule the camera has to obey is absolute: both fighters' bodies are fully
// on screen on every frame, with no exceptions for fast movement or for a
// smoothing lag. Everything below is in service of that.
//
// CAM_VIEW_HEIGHT is the *tightest* the camera ever gets: a ~310-unit fighter
// then occupies ~99px of the 224px screen, the classic Street Fighter
// proportion. From there the camera only ever zooms out. These three are
// player-tunable — see lib/tuning.ts (camera.*).
const CAM_VIEW_HEIGHT = TUNING.camera.viewHeight;
/** Clear space kept between a body and the left/right frame edge. */
const CAM_PAD_X = TUNING.camera.padX;
/** Clear space kept above the higher fighter's head. */
const CAM_PAD_TOP = TUNING.camera.padTop;
/** Body size assumed when a state carries no bounding box. */
const BODY_HALF_W = 90;
const BODY_H = 330;
const FLOOR_FRAC = 0.86;
/**
 * How far down the floor may be pushed to make room for a jump, as a fraction
 * of screen height. Panning is preferred over zooming — it keeps the fighters
 * at a readable size — but the floor has to stay on screen, so past this point
 * the camera zooms out instead.
 */
const FLOOR_MAX_FRAC = 0.97;
/** Never zoom out further than this, whatever the numbers say. */
const MIN_SCALE = 0.06;

const BOX_COLORS: Record<string, string> = {
  hurtbox: "rgb(20,20,255)",
  hitbox: "rgb(255,20,20)",
  takebox: "rgb(20,255,255)",
  grabbox: "rgb(20,255,20)",
  pushbox: "rgb(255,0,255)",
  triggerbox: "rgb(255,128,0)",
  boundingbox: "rgb(255,255,255)",
};

// ─── Attract menu ─────────────────────────────────────────────────────────────
// The pre-game options screen, drawn inside the game buffer like an arcade
// attract screen. Layout lives in MENU so drawing and mouse hit-testing can
// never drift apart.

export interface MenuRow {
  label: string;
  value?: string;
  /** Draws ‹ › around the value: this option cycles through a list. */
  cycles?: boolean;
  /** Greyed out — shown but currently has no effect. */
  dim?: boolean;
  /** Renders the row as a segmented strip — all options visible at once, the
   *  chosen one highlighted — instead of a single cycling value. */
  strip?: { options: string[]; index: number };
}

export interface MenuModel {
  title: string;
  subtitle?: string;
  rows: MenuRow[];
  cursor: number;
  footer: string[];
}

/** Row geometry, in buffer pixels. */
const MENU = {
  startY: 76,
  rowH: 16,
  hlLeft: 56,
  hlRight: GAME_W - 56,
  labelX: 76,
  arrowLX: 230,
  arrowRX: 318,
  valueCX: 277,
  /** Click slop around each arrow glyph. */
  arrowPad: 5,
} as const;

/** What a click at buffer coordinates (mx, my) landed on, if anything. */
export interface MenuHit {
  row: number;
  /** -1 previous value, +1 next value, 0 select/confirm the row. */
  dir: -1 | 0 | 1;
  /** Which segment was clicked on a strip row (picks that option directly). */
  seg?: number;
}

/** Height of one strip row — a label line plus the segment strip below it. */
const STRIP_H = 30;
const rowHeight = (row: MenuRow) => (row.strip ? STRIP_H : MENU.rowH);

/** Top y of each row, so drawing and hit-testing share one source of truth. */
function rowTops(menu: MenuModel): number[] {
  const tops: number[] = [];
  let y = MENU.startY;
  for (const r of menu.rows) { tops.push(y); y += rowHeight(r); }
  return tops;
}

export function hitTestMenu(menu: MenuModel, mx: number, my: number): MenuHit | null {
  if (mx < MENU.hlLeft || mx > MENU.hlRight) return null;
  const tops = rowTops(menu);
  const row = tops.findIndex((t, i) => my >= t - 3 && my < t - 3 + rowHeight(menu.rows[i]));
  if (row < 0) return null;

  const def = menu.rows[row];
  if (def.strip) {
    const w = MENU.hlRight - MENU.hlLeft;
    const seg = Math.floor(((mx - MENU.hlLeft) / w) * def.strip.options.length);
    return { row, dir: 0, seg: Math.max(0, Math.min(def.strip.options.length - 1, seg)) };
  }
  if (def.cycles) {
    const p = MENU.arrowPad;
    if (mx >= MENU.arrowLX - p && mx <= MENU.arrowLX + GLYPH_HIT + p) return { row, dir: -1 };
    if (mx >= MENU.arrowRX - p && mx <= MENU.arrowRX + GLYPH_HIT + p) return { row, dir: 1 };
  }
  return { row, dir: 0 };
}

/** Width of one glyph at scale 1, for arrow hit boxes. */
const GLYPH_HIT = 5;

interface GameCanvasProps {
  gameState: GameState | null;
  showBoxes?: boolean;
  /** CSS scale factor from the shell. Backing store stays 384×224. */
  scale: number;
  /** When set, drawn over a dimmed stage instead of the HUD. */
  menu?: MenuModel | null;
  /** Replaces the menu with a single centred status line. */
  status?: string | null;
  /** Mouse interaction with the attract menu. */
  onMenuHit?: (hit: MenuHit) => void;
}

// ─── Sprites ──────────────────────────────────────────────────────────────────
// Cache and preloading live in lib/render/textures.ts.

/**
 * Last sprite each object was successfully drawn with.
 *
 * A PNG that hasn't finished decoding cannot be drawn, and drawing nothing
 * makes the character blink out of existence for those frames. Showing the
 * previous frame instead is invisible to the player — animation frames are
 * adjacent poses — and it degrades a missing sprite into a one-frame stutter
 * rather than a hole. Keyed weakly so dead projectiles don't pin their sprites.
 */
const lastDrawn = new WeakMap<CharState, HTMLImageElement>();

// ─── Camera ───────────────────────────────────────────────────────────────────

interface Camera {
  x: number;
  scale: number;
  floorPy: number;
}

/** The world-space box a fighter's body actually occupies this frame. */
function bodyExtent(c: CharState): { left: number; right: number; top: number } {
  // boundingbox is the physical body — the same box the stage walls collide
  // against — and states may resize it (crouch, tumble). pushbox is the fallback
  // for anything without one.
  const box =
    c.boxes["boundingbox"]?.boxes?.[0] ?? c.boxes["pushbox"]?.boxes?.[0] ?? null;
  if (!box) {
    return {
      left: c.pos[0] - BODY_HALF_W,
      right: c.pos[0] + BODY_HALF_W,
      top: c.pos[1] + BODY_H,
    };
  }
  const [wx, wy, w, h] = worldBox(box, c);
  return { left: wx, right: wx + w, top: wy + h };
}

/**
 * Frame both fighters.
 *
 * Two things used to let a fighter leave the screen. The zoom-out was capped at
 * a fixed 1500 world units of width, so any separation past ~1000 units simply
 * ran off the edge; and the camera was smoothed toward its target with no
 * guarantee attached, so even a correct target was only reached several frames
 * later — during which a running fighter was already gone.
 *
 * Both are fixed by separating the two jobs. The *target* is computed from the
 * real body extents with no arbitrary cap, and the *smoothed* result is then
 * hard-clamped to contain that extent. Smoothing may only ever make the shot
 * looser than it needs to be, never tighter: the camera zooms out and pans to
 * keep up instantly, and eases only when relaxing back in.
 */
function computeCamera(gs: GameState, prev: Camera | null): Camera {
  const a = bodyExtent(gs.player);
  const b = bodyExtent(gs.cpu);

  const left = Math.min(a.left, b.left) - CAM_PAD_X;
  const right = Math.max(a.right, b.right) + CAM_PAD_X;
  const top = Math.max(a.top, b.top) + CAM_PAD_TOP;

  // ── Zoom ──
  const maxScale = GAME_H / CAM_VIEW_HEIGHT;
  let scale = Math.min(maxScale, GAME_W / Math.max(1, right - left));

  // Vertical: pan the floor down first, and only zoom out once the floor has
  // reached the bottom of the screen and there is still a head above the top.
  const baseFloorPy = GAME_H * FLOOR_FRAC;
  const maxFloorPy = GAME_H * FLOOR_MAX_FRAC;
  if (top * scale > maxFloorPy) scale = maxFloorPy / top;
  scale = Math.max(MIN_SCALE, scale);

  const floorPy = Math.min(maxFloorPy, Math.max(baseFloorPy, top * scale));

  // ── Pan ──
  const halfView = GAME_W / scale / 2;
  let x = (left + right) / 2;

  // Don't show past the walls unless the view is wider than the stage itself.
  // A little overscan keeps a cornered fighter inset from the frame edge.
  const overscan = 120;
  const [wallL, wallR] = gs.stageBounds;
  const lo = wallL - overscan + halfView;
  const hi = wallR + overscan - halfView;
  if (lo <= hi) x = Math.max(lo, Math.min(hi, x));
  else x = (wallL + wallR) / 2;

  const target: Camera = { x, scale, floorPy };
  if (!prev) return target;

  const k = 0.12;
  const sm: Camera = {
    x: prev.x + (target.x - prev.x) * k,
    scale: prev.scale + (target.scale - prev.scale) * k,
    floorPy: prev.floorPy + (target.floorPy - prev.floorPy) * k,
  };

  // ── The guarantee ──
  // Zooming out is applied immediately; zooming back in is what eases.
  sm.scale = Math.min(sm.scale, target.scale);
  // Likewise the floor only ever drops instantly, to open headroom.
  sm.floorPy = Math.max(sm.floorPy, target.floorPy);
  // With the scale pinned at or below target, the frame is at least as wide as
  // the extent, so these two bounds cannot cross.
  const half = GAME_W / sm.scale / 2;
  sm.x = Math.max(right - half, Math.min(left + half, sm.x));

  return sm;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function GameCanvas({
  gameState, showBoxes = false, scale, menu = null, status = null, onMenuHit,
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

      if (process.env.NODE_ENV !== "production") {
        // Dev handle: the framing invariant is only checkable against the
        // camera the renderer actually used, not a re-derived one.
        (window as unknown as Record<string, unknown>).__camera = {
          ...cam,
          bodies: [bodyExtent(gs.player), bodyExtent(gs.cpu)].map(e => ({
            l: gx(e.left), r: gx(e.right), t: gy(e.top), b: gy(0),
          })),
        };
      }

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

    if (process.env.NODE_ENV !== "production") {
      // rAF does not run in a hidden tab, which makes the renderer untestable
      // there. __redraw() is the synchronous equivalent of one displayed frame,
      // the counterpart to the engine's __step().
      (window as unknown as Record<string, unknown>).__redraw = drawFrame;
    }
    return () => cancelAnimationFrame(animRef.current);
  }, [drawFrame]);

  /** Client coordinates → buffer coordinates, whatever the CSS scale is. */
  const toBuffer = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * GAME_W,
      y: ((e.clientY - rect.top) / rect.height) * GAME_H,
    };
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const m = menuRef.current;
      if (!m || !onMenuHit) return;
      const { x, y } = toBuffer(e);
      const hit = hitTestMenu(m, x, y);
      if (hit) onMenuHit(hit);
    },
    [onMenuHit, toBuffer]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const m = menuRef.current;
      const canvas = e.currentTarget;
      if (!m || !onMenuHit) {
        if (canvas.style.cursor) canvas.style.cursor = "";
        return;
      }
      const { x, y } = toBuffer(e);
      canvas.style.cursor = hitTestMenu(m, x, y) ? "pointer" : "default";
    },
    [onMenuHit, toBuffer]
  );

  // width/height attributes are fixed in JSX and never touched again; scaling is
  // purely CSS. Changing the attributes would reallocate the backing store at a
  // different resolution, which is the one thing the spec forbids outright.
  return (
    <canvas
      ref={canvasRef}
      id="game"
      width={GAME_W}
      height={GAME_H}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
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

  // The mirror below reflects about screenX, which is the anchor, so the anchor
  // stays put and the art flips around it — the same net result as Python, which
  // mirrors image_offset by facing AND flips the texture. Crucially drawX is the
  // SAME whether or not we flip. Adjusting it to (1 - anchorXRatio) as well
  // double-applied the mirror, displacing the sprite by |2a-1| * width: harmless
  // for characters (Ryu's anchor is 0.501, so 1 unit) but 566 units for hit
  // sparks and 320 for the fireball, which is why those spawned way off.
  const drawX = screenX - anchorXRatio * sw;
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
  }

  const [tr, tg, tb, ta] = char.imageTint;
  const isTinted = tr !== 255 || tg !== 255 || tb !== 255 || ta !== 255;

  // Fall back to the last sprite this object drew rather than drawing nothing.
  let toDraw = img;
  if (!toDraw) {
    toDraw = lastDrawn.get(char) ?? null;
    if (toDraw) noteHeldPrevious();
  }

  if (toDraw) {
    if (isTinted) drawTinted(ctx, toDraw, drawX, drawY, sw, sh, tr, tg, tb, ta / 255);
    else ctx.drawImage(toDraw, Math.round(drawX), Math.round(drawY), Math.round(sw), Math.round(sh));
    if (img) lastDrawn.set(char, img);
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

  // At match end the result supersedes the round announcer — drawing both put
  // "KO!" and "YOU LOSE" on top of each other.
  if (gs.phase === "matchEnd") {
    const msg = gs.winner === "player" ? "YOU WIN" : "YOU LOSE";
    drawText(ctx, msg, GAME_W / 2, 96, {
      colour: gs.winner === "player" ? INK.ok : INK.blood,
      outline: INK.black,
      scale: 3,
      align: "center",
    });
  } else if (gs.announcer) {
    drawAnnouncer(ctx, gs.announcer);
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

/**
 * Solid triangle, 4×7 to match the glyph cell.
 *
 * Drawn as scanlines rather than a path so the edges land on exact pixels —
 * a filled path would antialias and read as soft against the bitmap text.
 * The font has no ‹ › glyphs, hence drawing them.
 */
function triangle(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, dir: -1 | 1
): void {
  // width per scanline: 1,2,3,4,3,2,1 — a 4x7 triangle.
  for (let r = 0; r < 7; r++) {
    const w = 4 - Math.abs(r - 3);
    const sx = dir < 0 ? x + (4 - w) : x;
    ctx.fillRect(Math.round(sx), Math.round(y + r), w, 1);
  }
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, dir: -1 | 1, css: string
): void {
  // Outline by stamping the shape at the four neighbours, matching how the
  // bitmap font bakes its 1px rim, so arrows stay legible over bright stage art.
  ctx.fillStyle = "#000";
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    triangle(ctx, x + dx, y + dy, dir);
  }
  ctx.fillStyle = css;
  triangle(ctx, x, y, dir);
}

/** Selection caret: the same triangle, always pointing at the row. */
function drawCaret(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  drawArrow(ctx, x, y, 1, "#ffcc44");
}

/**
 * Segmented strip: every option on screen at once, the chosen one lit as a
 * solid gold chip with dark text — the classic arcade select look.
 */
function drawStrip(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number,
  strip: { options: string[]; index: number }
): void {
  const n = strip.options.length;
  const cw = w / n;
  for (let k = 0; k < n; k++) {
    const on = k === strip.index;
    const left = Math.round(x + k * cw);
    const cx = Math.round(x + k * cw + cw / 2);

    if (on) {
      ctx.fillStyle = "#ffcc44";
      ctx.fillRect(left + 2, y - 2, Math.round(cw) - 4, 13);
    }
    drawText(ctx, strip.options[k], cx, y, {
      colour: on ? INK.black : INK.steel,
      outline: on ? 0 : INK.black,
      align: "center",
    });
  }
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

  const tops = rowTops(menu);
  for (let i = 0; i < menu.rows.length; i++) {
    const row = menu.rows[i];
    const y = tops[i];
    const selected = i === menu.cursor;

    if (row.strip) {
      if (selected) drawCaret(ctx, 62, y + 1);
      const labelInk = selected ? INK.paper : INK.steel;
      drawText(ctx, row.label, MENU.labelX, y, { colour: labelInk, outline: INK.black });
      drawStrip(ctx, MENU.hlLeft, y + 13, MENU.hlRight - MENU.hlLeft, row.strip);
      continue;
    }

    if (selected) {
      ctx.fillStyle = "rgba(255,204,68,.14)";
      ctx.fillRect(MENU.hlLeft, y - 3, MENU.hlRight - MENU.hlLeft, MENU.rowH - 2);
      drawCaret(ctx, 62, y + 1);
    }

    const labelInk = row.dim ? INK.muted : selected ? INK.paper : INK.steel;
    drawText(ctx, row.label, MENU.labelX, y, { colour: labelInk, outline: INK.black });

    if (row.value) {
      const valueInk = row.dim ? INK.muted : selected ? INK.gold : INK.sand;
      if (row.cycles) {
        // ‹ › make it obvious the value cycles, and give the mouse something to
        // aim at. Brightened on the focused row so the affordance reads without
        // shouting on the rows you aren't on.
        const arrowCss = row.dim ? "#5c557a" : selected ? "#ffcc44" : "#6d7ea8";
        drawArrow(ctx, MENU.arrowLX, y, -1, arrowCss);
        drawArrow(ctx, MENU.arrowRX, y, 1, arrowCss);
        drawText(ctx, row.value, MENU.valueCX, y, {
          colour: valueInk, outline: INK.black, align: "center",
        });
      } else {
        drawText(ctx, row.value, GAME_W - 76, y, {
          colour: valueInk, outline: INK.black, align: "right",
        });
      }
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
