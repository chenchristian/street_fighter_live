import type { InferenceSession } from "onnxruntime-web";

let cachedSession: InferenceSession | null = null;

export async function loadOnnxSession(modelUrl: string): Promise<InferenceSession> {
  if (cachedSession) return cachedSession;
  const ort = await import("onnxruntime-web");
  // Use CDN for WASM binaries so we don't bundle them
  ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
  cachedSession = await ort.InferenceSession.create(modelUrl);
  return cachedSession;
}

export interface InferenceResult {
  label: string;
  confidence: number;
  allProbs: number[]; // one probability per class, in label order
}

export async function runInference(
  session: InferenceSession,
  window: Float32Array[],
  labels: string[]
): Promise<InferenceResult | null> {
  if (window.length < 5) return null;

  const ort = await import("onnxruntime-web");
  const data = new Float32Array(5 * 84);
  window.slice(-5).forEach((v, i) => data.set(v, i * 84));

  const tensor = new ort.Tensor("float32", data, [1, 5, 84]);
  const out = await session.run({ pose_sequence: tensor });
  const logits = Array.from(out.logits.data as Float32Array);

  // softmax
  const max = Math.max(...logits);
  const exps = logits.map(v => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const allProbs = exps.map(v => v / sum);

  const maxIdx = allProbs.indexOf(Math.max(...allProbs));
  return { label: labels[maxIdx], confidence: allProbs[maxIdx], allProbs };
}
