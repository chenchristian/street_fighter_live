// ──────────────────────────────────────────────────────────────────────────────
// Seeded RNG.
//
// Every nondeterministic decision in the simulation — CPU action choice,
// `random_state` framedata, voice lines — must draw from here, not Math.random.
// Online play replays the same input stream on both peers, so any unseeded
// randomness desynchronises the two games within seconds.
// ──────────────────────────────────────────────────────────────────────────────

export class Rng {
  private state: number;

  constructor(seed = 0x9e3779b9) {
    // Avoid the zero state, which mulberry32 cannot escape.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** mulberry32 — small, fast, and good enough for gameplay decisions. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  /** Weighted pick. Entries are [item, weight]; weights need not sum to 1. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of entries) total += w;
    let r = this.next() * total;
    for (const [item, w] of entries) {
      r -= w;
      if (r <= 0) return item;
    }
    return entries[entries.length - 1][0];
  }

  /** Snapshot / restore, so rollback can rewind the RNG along with the sim. */
  save(): number {
    return this.state;
  }

  restore(state: number): void {
    this.state = state >>> 0;
  }
}

/** Shared instance for the local game. Reseeded at the start of every match. */
export const gameRng = new Rng();
