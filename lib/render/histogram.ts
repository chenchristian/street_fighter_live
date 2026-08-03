// ──────────────────────────────────────────────────────────────────────────────
// Live model-output histogram. Implements UI_SHELL_SPEC §6.
//
// One row per class, each keeping a fixed identity hue. Whether a class fired is
// carried by a row highlight plus a white cap on the bar end — never by hue,
// because recolouring the winner is exactly what destroys at-a-glance identity.
// ──────────────────────────────────────────────────────────────────────────────

import { drawText } from "./font";
import {
  DISPLAY_ORDER, DROPPED, FALLBACK_COLOUR, HIST, HIST_LAYOUT, MOVE_COLOUR, SHORT,
} from "./palette";

const { NAME_W, VAL_W, ROW_H } = HIST_LAYOUT;

/** Canvas height for a given class count, per the spec's formula. */
export const histogramHeight = (classCount: number) => classCount * ROW_H + 4;

/**
 * Map display rows to model output indices.
 *
 * Label files are alphabetical because that is what the training LabelEncoder
 * produced, and the model's output indices are bound to that order. Reordering
 * the labels would silently mislabel every prediction, so build a row → index
 * map instead, and append anything the display list doesn't know about rather
 * than dropping it.
 */
export function buildOrder(labels: string[]): number[] {
  const order: number[] = [];
  for (const name of DISPLAY_ORDER) {
    const i = labels.indexOf(name);
    if (i >= 0) order.push(i);
  }
  for (let i = 0; i < labels.length; i++) if (!order.includes(i)) order.push(i);
  return order;
}

export interface HistogramFrame {
  probs: number[];
  index: number;
  confidence: number;
}

/** Peak-hold state, decayed once per inference. */
export class PeakHold {
  private peak: number[] = [];

  update(probs: number[]): void {
    if (this.peak.length !== probs.length) this.peak = new Array(probs.length).fill(0);
    for (let i = 0; i < probs.length; i++) {
      const v = probs[i] || 0;
      this.peak[i] = v > this.peak[i] ? v : this.peak[i] * 0.92;
    }
  }

  at(i: number): number {
    return this.peak[i] ?? 0;
  }

  reset(): void {
    this.peak = [];
  }
}

export function drawHistogram(
  ctx: CanvasRenderingContext2D,
  opts: {
    labels: string[];
    order: number[];
    frame: HistogramFrame | null;
    peak: PeakHold;
    threshold: number;
    width: number;
    height: number;
  }
): void {
  const { labels, order, frame, peak, threshold, width: W, height: H } = opts;

  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = HIST.bg;
  ctx.fillRect(0, 0, W, H);

  const barX = NAME_W + 2;
  const barW = W - barX - VAL_W - 2;
  const gateX = barX + Math.round(barW * threshold);

  for (let row = 0; row < order.length; row++) {
    const i = order[row];
    const name = labels[i];
    if (name === undefined) continue;
    const y = 2 + row * ROW_H;
    const v = frame?.probs[i] ?? 0;
    const isWin = frame != null && i === frame.index;
    const dropped = DROPPED.has(name);
    const fired = isWin && (frame?.confidence ?? 0) >= threshold && !dropped;

    if (isWin) {
      // Highlight the ROW, not the bar colour.
      ctx.fillStyle = HIST.rowWin;
      ctx.fillRect(0, y, W, ROW_H - 1);
    }

    drawText(ctx, SHORT[name] ?? name.slice(0, 8), 2, y + 3, {
      colour: dropped ? HIST.labelDead : isWin ? HIST.labelHot : HIST.label,
    });

    ctx.fillStyle = HIST.barIdle;
    ctx.fillRect(barX, y + 2, barW, ROW_H - 5);

    const w = Math.max(0, Math.round(barW * v));
    ctx.fillStyle = MOVE_COLOUR[name] ?? FALLBACK_COLOUR;
    ctx.fillRect(barX, y + 2, w, ROW_H - 5);

    // Peak-hold tick: where this class peaked recently, decaying away.
    const pv = peak.at(i);
    if (pv > 0.04) {
      ctx.fillStyle = HIST.peak;
      ctx.fillRect(Math.round(barX + barW * pv), y + 2, 1, ROW_H - 5);
    }

    // Bright cap marks what actually fired — brightness, never hue.
    if (fired && w > 1) {
      ctx.fillStyle = HIST.winFrame;
      ctx.fillRect(barX + w - 2, y + 2, 2, ROW_H - 5);
    }

    drawText(ctx, `${Math.round(v * 100)}`, W - 2, y + 3, {
      colour: isWin ? HIST.text : HIST.dim,
      align: "right",
    });
  }

  // The fire gate.
  ctx.fillStyle = HIST.threshold;
  ctx.fillRect(gateX, 0, 1, H);
}
