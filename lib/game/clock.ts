// ──────────────────────────────────────────────────────────────────────────────
// Fixed-step clock.
//
// A fighting game has to advance in exact 1/60s steps or frame data stops
// meaning anything. Neither obvious timer survives a backgrounded tab:
//
//   requestAnimationFrame  stops entirely
//   setInterval / setTimeout  is clamped to ~1Hz
//
// Timers inside a Web Worker are exempt from that clamping, so the worker is
// the metronome and the main thread does the stepping. Falls back to
// setInterval where workers aren't available.
// ──────────────────────────────────────────────────────────────────────────────

const WORKER_SRC = `
let id = null;
self.onmessage = (e) => {
  if (e.data && e.data.type === 'start') {
    if (id !== null) clearInterval(id);
    id = setInterval(() => self.postMessage(0), e.data.ms);
  } else if (e.data && e.data.type === 'stop') {
    if (id !== null) clearInterval(id);
    id = null;
  }
};
`;

export interface FixedClockOptions {
  /** Simulation rate. */
  fps?: number;
  /**
   * Most steps run in one burst when catching up. Caps the "spiral of death"
   * after a long stall, at the cost of letting the sim fall behind wall clock.
   */
  maxCatchUp?: number;
}

export class FixedClock {
  private readonly stepMs: number;
  private readonly maxCatchUp: number;
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private acc = 0;
  private running = false;
  private onStep: (() => void) | null = null;
  private onFlush: (() => void) | null = null;

  constructor(options: FixedClockOptions = {}) {
    const fps = options.fps ?? 60;
    this.stepMs = 1000 / fps;
    this.maxCatchUp = options.maxCatchUp ?? 8;
  }

  /**
   * @param step   advance the simulation exactly one frame
   * @param flush  called once per tick after any steps ran (e.g. to re-render)
   */
  start(step: () => void, flush?: () => void): void {
    this.stop();
    this.onStep = step;
    this.onFlush = flush ?? null;
    this.last = performance.now();
    this.acc = 0;
    this.running = true;

    const pump = () => this.pump();

    if (typeof Worker !== "undefined" && typeof Blob !== "undefined") {
      try {
        const blob = new Blob([WORKER_SRC], { type: "application/javascript" });
        this.workerUrl = URL.createObjectURL(blob);
        this.worker = new Worker(this.workerUrl);
        this.worker.onmessage = pump;
        // Tick faster than the step rate so the accumulator stays fed and
        // jitter in the timer doesn't turn into dropped frames.
        this.worker.postMessage({ type: "start", ms: this.stepMs / 2 });
        return;
      } catch {
        // Fall through to the timer path.
        this.worker = null;
      }
    }

    this.intervalId = setInterval(pump, this.stepMs / 2);
  }

  stop(): void {
    this.running = false;
    if (this.worker) {
      this.worker.postMessage({ type: "stop" });
      this.worker.terminate();
      this.worker = null;
    }
    if (this.workerUrl) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
    }
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.onStep = null;
    this.onFlush = null;
  }

  private pump(): void {
    if (!this.running || !this.onStep) return;
    const now = performance.now();
    this.acc += now - this.last;
    this.last = now;

    let steps = 0;
    while (this.acc >= this.stepMs && steps < this.maxCatchUp) {
      this.onStep();
      this.acc -= this.stepMs;
      steps++;
    }
    // Drop whatever we couldn't catch up on rather than banking it.
    if (this.acc > this.stepMs * this.maxCatchUp) this.acc = 0;

    if (steps > 0) this.onFlush?.();
  }
}
