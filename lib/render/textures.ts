// ──────────────────────────────────────────────────────────────────────────────
// Sprite cache and preloader.
//
// Sprites are one PNG per animation frame — ~1400 across Ryu and Ken alone. An
// HTMLImageElement is never `complete` on the tick its src is assigned, so a
// lazily-loaded sprite is undrawable on the very frame it is first needed. The
// renderer used to draw nothing in that case, which read as the character
// blinking out whenever a new action started: idle looked fine because its
// handful of frames load once and then loop forever, while every fresh move
// pulled a dozen cold PNGs.
//
// Fixed on two fronts: everything a loaded character can reference is preloaded
// up front (the whole sprite set is ~9MB), and the renderer holds the previous
// frame if a sprite still isn't decodable.
// ──────────────────────────────────────────────────────────────────────────────

const cache = new Map<string, HTMLImageElement>();

/** Diagnostics; surfaced as window.__spriteStats in dev. */
export const spriteStats = {
  /** getImage calls. */
  requests: 0,
  /** Sprites requested that had never been asked for before. */
  coldRequests: 0,
  /** Frames where the wanted sprite was not yet decodable. */
  notReady: 0,
  /** Frames saved from blanking by falling back to the previous sprite. */
  heldPrevious: 0,
  /** Sprites successfully preloaded. */
  preloaded: 0,
  /** Sprites that 404'd or failed to decode. */
  failed: 0,
};

export function spriteUrl(name: string): string {
  return `/assets/images/${name}.png`;
}

/** Returns the image only when it can actually be drawn this frame. */
export function getImage(name: string): HTMLImageElement | null {
  spriteStats.requests++;
  let img = cache.get(name);
  if (!img) {
    spriteStats.coldRequests++;
    img = new Image();
    img.src = spriteUrl(name);
    cache.set(name, img);
  }
  const ready = img.complete && img.naturalWidth > 0;
  if (!ready) spriteStats.notReady++;
  return ready ? img : null;
}

export function noteHeldPrevious(): void {
  spriteStats.heldPrevious++;
}

// ─── Preloading ───────────────────────────────────────────────────────────────

/**
 * Every sprite name reachable from a character/stage JSON.
 *
 * Walks the whole structure rather than only `states[].framedata[].image`,
 * because sprites also hide in `draw_textures` entries and in the `smear` key
 * on attack frames. A generic walk keeps this correct if the data gains new
 * sprite-bearing fields.
 */
export function collectSpriteRefs(data: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(data)) {
    for (const v of data) collectSpriteRefs(v, out);
    return out;
  }
  if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      // "none" is the engine's explicit empty sprite; portraits aren't drawn in-game.
      if ((k === "image" || k === "smear") && typeof v === "string" && v && v !== "reencor/none") {
        out.add(v);
      } else {
        collectSpriteRefs(v, out);
      }
    }
  }
  return out;
}

/**
 * Load every named sprite into the cache.
 *
 * A failed sprite resolves rather than rejects: one missing PNG must not stop a
 * match from starting, and the renderer already tolerates a missing image.
 */
export async function preloadSprites(
  names: Iterable<string>,
  onProgress?: (loaded: number, total: number) => void,
  concurrency = 24
): Promise<void> {
  const list = [...names].filter(n => {
    const existing = cache.get(n);
    return !(existing && existing.complete && existing.naturalWidth > 0);
  });
  const total = list.length;
  if (total === 0) {
    onProgress?.(0, 0);
    return;
  }

  let loaded = 0;
  let cursor = 0;

  const loadOne = (name: string) =>
    new Promise<void>(resolve => {
      let img = cache.get(name);
      if (!img) {
        img = new Image();
        cache.set(name, img);
      }
      if (img.complete && img.naturalWidth > 0) {
        spriteStats.preloaded++;
        resolve();
        return;
      }
      const done = (ok: boolean) => {
        if (ok) spriteStats.preloaded++;
        else spriteStats.failed++;
        resolve();
      };
      img.addEventListener("load", () => done(true), { once: true });
      img.addEventListener("error", () => done(false), { once: true });
      if (!img.src) img.src = spriteUrl(name);
    });

  const worker = async () => {
    while (cursor < total) {
      const name = list[cursor++];
      await loadOne(name);
      loaded++;
      onProgress?.(loaded, total);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, () => worker())
  );
}

/** Preload everything reachable from a set of loaded JSON documents. */
export async function preloadFrom(
  docs: unknown[],
  onProgress?: (loaded: number, total: number) => void
): Promise<number> {
  const refs = new Set<string>();
  for (const d of docs) collectSpriteRefs(d, refs);
  await preloadSprites(refs, onProgress);
  return refs.size;
}
