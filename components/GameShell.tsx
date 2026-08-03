"use client";
// ──────────────────────────────────────────────────────────────────────────────
// The shell: sidebar left, cabinet right. Implements UI_SHELL_SPEC §2 and §3.
//
// Owns the scaling algorithm, because the scale depends on how much horizontal
// space the sidebar claims — which only the shell knows.
// ──────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { GAME_W, GAME_H } from "@/app/game/GameCanvas";

interface GameShellProps {
  sidebar?: ReactNode;
  sidebarVisible?: boolean;
  topbar?: ReactNode;
  /** Receives the CSS scale factor for the 384×224 canvas. */
  children: (scale: number) => ReactNode;
}

/**
 * Integer scale when there's room; fractional only to avoid a postage stamp.
 *
 * At 2× or 3× every game pixel maps to an exact square block of screen pixels.
 * Below 2×, rounding 1.9 down to 1 would letterbox the game into a corner with
 * half the window empty — worse than slightly uneven pixel widths. Nearest-
 * neighbour resampling keeps a fractional scale hard-edged, never blurry.
 */
function computeScale(reservedWidth: number): number {
  const availW = Math.max(1, window.innerWidth - 24 - reservedWidth);
  const availH = Math.max(1, window.innerHeight - 24);
  const fit = Math.min(availW / GAME_W, availH / GAME_H);
  return fit >= 2 ? Math.floor(fit) : Math.max(0.5, fit);
}

/** Matches the stacking breakpoint in globals.css. */
const STACK_QUERY = "(max-width: 780px)";

export default function GameShell({
  sidebar, sidebarVisible = true, topbar, children,
}: GameShellProps) {
  const panelRef = useRef<HTMLElement>(null);
  const [scale, setScale] = useState(2);

  const measure = useCallback(() => {
    const panel = panelRef.current;
    // Below the breakpoint the sidebar stacks *below* the cabinet, so it claims
    // no horizontal space. Reserving its width there squeezes the game into a
    // postage stamp with most of the window empty — the exact failure the
    // stacking rule exists to avoid. The page scrolls in that mode, so the
    // panel's height doesn't need reserving either.
    const stacked = window.matchMedia(STACK_QUERY).matches;
    const reserved = sidebarVisible && panel && !stacked ? panel.offsetWidth + 24 : 0;
    setScale(computeScale(reserved));
  }, [sidebarVisible]);

  useLayoutEffect(() => {
    measure();
    // Measure AGAIN next frame: on the first pass the canvas still carries its
    // previous CSS size, which skews the sidebar's reported width.
    const id = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(id);
  }, [measure]);

  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    // Crossing the breakpoint flips whether the sidebar claims width, and that
    // can happen without a resize event (zoom, device rotation).
    const mq = window.matchMedia(STACK_QUERY);
    mq.addEventListener("change", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      mq.removeEventListener("change", onResize);
    };
  }, [measure]);

  // The sidebar's own height changes when the camera dock adopts the real feed
  // ratio, which can change how much vertical room the cabinet has.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(panel);
    return () => ro.disconnect();
  }, [measure]);

  return (
    <div id="app">
      {topbar}
      <aside id="cv-panel" ref={panelRef} hidden={!sidebarVisible}>
        {sidebar}
      </aside>
      <div id="stage-frame">{children(scale)}</div>
    </div>
  );
}
