"use client";
// ──────────────────────────────────────────────────────────────────────────────
// CV sidebar. Implements UI_SHELL_SPEC §4 and §6.
//
// Order is fixed: camera dock, stats line, model-output histogram, legend.
// ──────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { PipelineStats, PredictionState } from "@/hooks/usePosePipeline";
import { CONFIDENCE_THRESHOLD } from "@/lib/pose/utils";
import { buildOrder, drawHistogram, histogramHeight, PeakHold } from "@/lib/render/histogram";
import { DISPLAY_ORDER, HIST_LAYOUT, SHORT } from "@/lib/render/palette";

interface CvPanelProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  overlayRef: RefObject<HTMLCanvasElement | null>;
  labels: string[];
  prediction: PredictionState | null;
  stats: PipelineStats;
  camAspect: string | null;
  status: string;
  errorMsg?: string;
  /** Whether keyboard input is active — shapes the no-camera message. */
  keyboardEnabled?: boolean;
  /** Extra rows rendered under the legend (netplay telemetry). */
  children?: React.ReactNode;
}

export default function CvPanel({
  videoRef, overlayRef, labels, prediction, stats, camAspect, status, errorMsg,
  keyboardEnabled = true, children,
}: CvPanelProps) {
  const barsRef = useRef<HTMLCanvasElement>(null);
  const peakRef = useRef<PeakHold>(new PeakHold());
  const dockRef = useRef<HTMLDivElement>(null);

  // Before the model loads there are no labels yet. Fall back to the display
  // list so the histogram reserves its full height from the first paint instead
  // of collapsing to a strip and shoving the layout around when labels arrive.
  const rowLabels = labels.length ? labels : DISPLAY_ORDER;
  const order = useMemo(() => buildOrder(rowLabels), [rowLabels]);
  const barsH = histogramHeight(rowLabels.length);

  // Adopt the camera's real aspect ratio once metadata arrives.
  useEffect(() => {
    if (camAspect && dockRef.current) dockRef.current.style.aspectRatio = camAspect;
  }, [camAspect]);

  // Decay peaks once per inference, not once per animation frame.
  useEffect(() => {
    if (prediction) peakRef.current.update(prediction.allProbs);
  }, [prediction]);

  useEffect(() => {
    const canvas = barsRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    drawHistogram(ctx, {
      labels: rowLabels,
      order,
      frame: prediction
        ? { probs: prediction.allProbs, index: prediction.index, confidence: prediction.confidence }
        : null,
      peak: peakRef.current,
      threshold: CONFIDENCE_THRESHOLD,
      width: canvas.width,
      height: canvas.height,
    });
  }, [rowLabels, order, prediction, barsH]);

  const label = prediction ? SHORT[prediction.label] ?? prediction.label : "—";
  const conf = prediction ? `${Math.round(prediction.confidence * 100)}%` : "";

  return (
    <>
      <div id="cam-dock" ref={dockRef}>
        <video ref={videoRef} id="cam" playsInline muted autoPlay />
        <canvas ref={overlayRef} id="cam-overlay" width={320} height={240} />
        <div id="cam-readout">
          <span>{status === "ready" ? label : status === "error" ? "NO CAMERA" : "—"}</span>
          <span>{status === "ready" ? conf : ""}</span>
        </div>
      </div>

      <div className="cv-stats">
        <span>{stats.hz > 0 ? `${stats.hz.toFixed(0)} hz` : "— hz"}</span>
        <span>{stats.ms > 0 ? `${stats.ms.toFixed(0)} ms` : "— ms"}</span>
        <span className={`cv-body${stats.body ? " ok" : ""}`}>
          {stats.body ? "body" : "no body"}
        </span>
      </div>

      <h3>
        Model output <em>gate {CONFIDENCE_THRESHOLD.toFixed(2)}</em>
      </h3>
      <canvas ref={barsRef} width={HIST_LAYOUT.WIDTH} height={barsH} />

      <p className="cv-legend">
        Each move keeps its own colour. The vertical line is the fire threshold —
        a bar past it with a white cap is the move that fired.
      </p>

      {status === "error" && (
        <p className="cv-legend" style={{ color: "var(--blood)" }}>
          {errorMsg || "Camera unavailable."}{" "}
          {keyboardEnabled ? "Keyboard controls still work." : "Switch Mode to Keyboard to play."}
        </p>
      )}

      {children}
    </>
  );
}
