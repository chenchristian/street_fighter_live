"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  landmarksToVector,
  detectMovement,
  drawSkeleton,
  SEQUENCE_LENGTH,
  CONFIDENCE_THRESHOLD,
  type NLandmark,
} from "@/lib/pose/utils";
import { loadOnnxSession, runInference } from "@/lib/pose/onnx";

export type PipelineStatus = "idle" | "loading" | "ready" | "error";

export interface PredictionState {
  label: string;
  confidence: number;
  direction: "LEFT" | "RIGHT" | null;
  allProbs: number[];
  /** Argmax index in the model's own output order. */
  index: number;
}

export interface PipelineStats {
  /** Inferences per second, smoothed. */
  hz: number;
  /** Latency of the last inference, ms. */
  ms: number;
  /** Whether a body is currently detected. */
  body: boolean;
}

export function usePosePipeline() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const prevCxRef = useRef<number | null>(null);
  const seqBuf = useRef<Float32Array[]>([]);

  const [status, setStatus] = useState<PipelineStatus>("idle");
  const [prediction, setPrediction] = useState<PredictionState | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [stats, setStats] = useState<PipelineStats>({ hz: 0, ms: 0, body: false });
  /** Real camera aspect ratio, so the dock can adopt it instead of assuming 4:3. */
  const [camAspect, setCamAspect] = useState<string | null>(null);

  const start = useCallback(async () => {
    setStatus("loading");
    try {
      // 1. Webcam
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
      });
      const video = videoRef.current!;
      video.srcObject = stream;
      await new Promise<void>(res => {
        video.onloadedmetadata = () => { video.play(); res(); };
      });

      // The overlay must share the video's aspect ratio, not merely sit on top
      // of it. Left at a fixed 320×240 it letterboxes differently from a 16:9
      // feed and the skeleton drifts out of alignment with the body.
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw && vh) {
        setCamAspect(`${vw} / ${vh}`);
        const overlay = canvasRef.current;
        if (overlay) {
          overlay.width = vw;
          overlay.height = vh;
        }
      }

      // 2. Labels + models (concurrent)
      const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");

      const [fetchedLabels, vision, onnxSession] = await Promise.all([
        fetch("/model/labels.json").then(r => r.json()) as Promise<string[]>,
        FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm"
        ),
        loadOnnxSession("/model/lstm_pose.onnx"),
      ]);

      const labelList = fetchedLabels;
      setLabels(labelList);

      const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numPoses: 1,
      });

      setStatus("ready");

      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      let lastTs = -1;
      let inferring = false;

      // Rolling inference-rate estimate.
      let inferCount = 0;
      let windowStart = performance.now();
      let smoothedHz = 0;
      let lastMs = 0;
      let bodySeen = false;

      const loop = () => {
        if (!video.videoWidth) {
          rafRef.current = requestAnimationFrame(loop);
          return;
        }

        // Keep the overlay matched to the feed. It stays transparent — the
        // visible picture is the <video> element behind it, not a copy blitted
        // into this canvas.
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.imageSmoothingEnabled = false; // resizing resets context state
        }

        const ts = performance.now();
        if (ts === lastTs) { rafRef.current = requestAnimationFrame(loop); return; }
        lastTs = ts;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const results = poseLandmarker.detectForVideo(video, ts);

        if (results.landmarks.length > 0) {
          bodySeen = true;
          const lms = results.landmarks[0] as unknown as NLandmark[];

          drawSkeleton(ctx, lms, canvas.width, canvas.height);

          const vec = landmarksToVector(lms);
          seqBuf.current.push(vec);
          if (seqBuf.current.length > SEQUENCE_LENGTH) seqBuf.current.shift();

          const { dir, cx } = detectMovement(lms, prevCxRef.current);
          prevCxRef.current = cx;

          if (seqBuf.current.length === SEQUENCE_LENGTH && !inferring) {
            inferring = true;
            const windowSnap = seqBuf.current.map(v => v.slice() as unknown as Float32Array);
            const t0 = performance.now();
            runInference(onnxSession, windowSnap, labelList).then(result => {
              inferring = false;
              if (!result) return;
              lastMs = performance.now() - t0;
              inferCount++;

              const label = result.confidence < CONFIDENCE_THRESHOLD ? "idle" : result.label;
              setPrediction({
                label,
                confidence: result.confidence,
                direction: dir,
                // Copy: the panel holds this across frames, and inference output
                // buffers are commonly reused.
                allProbs: result.allProbs.slice(),
                index: result.index,
              });
            });
          }
        } else {
          bodySeen = false;
          prevCxRef.current = null;
          seqBuf.current = [];
        }

        // Publish stats about twice a second rather than every frame.
        const elapsed = ts - windowStart;
        if (elapsed >= 500) {
          const hz = (inferCount * 1000) / elapsed;
          smoothedHz = smoothedHz === 0 ? hz : smoothedHz * 0.6 + hz * 0.4;
          inferCount = 0;
          windowStart = ts;
          setStats({ hz: smoothedHz, ms: lastMs, body: bodySeen });
        }

        rafRef.current = requestAnimationFrame(loop);
      };

      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      setStatus("error");
      setErrorMsg(e instanceof Error ? e.message : "Unknown error");
    }
  }, []);

  // Cleanup on unmount. The <video> is captured on mount rather than read in the
  // cleanup, where the ref may already have been detached — otherwise the
  // camera's tracks are never stopped and the webcam light stays on.
  useEffect(() => {
    const video = videoRef.current;
    const raf = rafRef;
    return () => {
      cancelAnimationFrame(raf.current);
      if (video?.srcObject) {
        (video.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  return { videoRef, canvasRef, status, prediction, labels, errorMsg, stats, camAspect, start };
}
