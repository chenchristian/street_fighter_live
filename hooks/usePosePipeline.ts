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
}

export function usePosePipeline() {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef<number>(0);
  const prevCxRef = useRef<number | null>(null);
  const seqBuf    = useRef<Float32Array[]>([]);

  const [status,     setStatus]     = useState<PipelineStatus>("idle");
  const [prediction, setPrediction] = useState<PredictionState | null>(null);
  const [errorMsg,   setErrorMsg]   = useState("");

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

      // 2. Labels + models (concurrent)
      const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");

      const [labels, vision, onnxSession] = await Promise.all([
        fetch("/model/labels.json").then(r => r.json()) as Promise<string[]>,
        FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm"
        ),
        loadOnnxSession("/model/lstm_pose.onnx"),
      ]);

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
      const ctx    = canvas.getContext("2d")!;
      let lastTs   = -1;
      let inferring = false;

      const loop = () => {
        if (!video.videoWidth) {
          rafRef.current = requestAnimationFrame(loop);
          return;
        }

        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;

        const ts = performance.now();
        if (ts === lastTs) { rafRef.current = requestAnimationFrame(loop); return; }
        lastTs = ts;

        // Draw video (CSS scaleX(-1) mirrors it so it feels like a mirror)
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const results = poseLandmarker.detectForVideo(video, ts);

        if (results.landmarks.length > 0) {
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
            runInference(onnxSession, windowSnap, labels).then(result => {
              inferring = false;
              if (!result) return;
              const label = result.confidence < CONFIDENCE_THRESHOLD ? "idle" : result.label;
              setPrediction({ label, confidence: result.confidence, direction: dir });
            });
          }
        } else {
          prevCxRef.current = null;
          seqBuf.current    = [];
        }

        rafRef.current = requestAnimationFrame(loop);
      };

      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      setStatus("error");
      setErrorMsg(e instanceof Error ? e.message : "Unknown error");
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      const video = videoRef.current;
      if (video?.srcObject) {
        (video.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  return { videoRef, canvasRef, status, prediction, errorMsg, start };
}
