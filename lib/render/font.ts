// ──────────────────────────────────────────────────────────────────────────────
// 5×7 bitmap font. Implements UI_SHELL_SPEC §5.
//
// ctx.fillText with a system font anti-aliases and hints for high-DPI. Drawn
// into a 384×224 buffer that produces grey fringing on every stroke, which the
// eye reads instantly as "modern webpage" rather than "arcade".
//
// Glyphs are pre-rendered once per colour into a strip and blitted with
// drawImage — one call per character, no per-pixel work at runtime. Every glyph
// gets a baked 1px outline so text stays legible over bright and dark art alike.
// ──────────────────────────────────────────────────────────────────────────────

export const GLYPH_W = 5;
export const GLYPH_H = 7;

const G: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  0: [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  1: ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", "#####"],
  2: [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  3: ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  4: ["#...#", "#...#", "#...#", "#####", "....#", "....#", "....#"],
  5: ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  6: [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  7: ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  8: [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  9: [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  ",": [".....", ".....", ".....", ".....", ".##..", ".##..", ".#..."],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  "?": [".###.", "#...#", "....#", "..##.", "..#..", ".....", "..#.."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
  "'": ["..#..", "..#..", ".....", ".....", ".....", ".....", "....."],
  "/": ["....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."],
  "%": ["##..#", "##.#.", "..#..", ".#...", "#.##.", "..##.", "....."],
  "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
  "*": [".....", "#.#.#", ".###.", "#####", ".###.", "#.#.#", "....."],
};

export const CHARS = Object.keys(G);

/** Packed little-endian RGBA word (0xAABBGGRR). */
export const rgba = (r: number, g: number, b: number, a = 255): number =>
  (((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;

interface Atlas {
  canvas: HTMLCanvasElement;
  cw: number;
  ch: number;
  pad: number;
  index: Map<string, number>;
}

const cache = new Map<string, Atlas>();

export function getAtlas(colour: number, outlineColour = 0): Atlas {
  const key = `${colour}|${outlineColour}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const pad = outlineColour ? 1 : 0;
  const cw = GLYPH_W + pad * 2;
  const ch = GLYPH_H + pad * 2;

  const cv = document.createElement("canvas");
  cv.width = cw * CHARS.length;
  cv.height = ch;
  const g = cv.getContext("2d")!;
  g.imageSmoothingEnabled = false;

  const img = g.createImageData(cv.width, cv.height);
  const buf = new Uint32Array(img.data.buffer);
  const put = (x: number, y: number, c: number) => {
    if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return;
    buf[y * cv.width + x] = c;
  };

  CHARS.forEach((c, i) => {
    const rows = G[c];
    const ox = i * cw + pad;
    for (let y = 0; y < GLYPH_H; y++) {
      for (let x = 0; x < GLYPH_W; x++) {
        if (rows[y][x] === "#") put(ox + x, pad + y, colour);
      }
    }
  });

  if (outlineColour) {
    // Wrap every opaque pixel with the outline colour.
    const src = new Uint32Array(buf);
    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        if (src[y * cv.width + x] !== 0) continue;
        const hit2 =
          (x > 0 && src[y * cv.width + x - 1]) ||
          (x < cv.width - 1 && src[y * cv.width + x + 1]) ||
          (y > 0 && src[(y - 1) * cv.width + x]) ||
          (y < cv.height - 1 && src[(y + 1) * cv.width + x]);
        if (hit2) put(x, y, outlineColour);
      }
    }
  }

  g.putImageData(img, 0, 0);
  const atlas: Atlas = {
    canvas: cv,
    cw,
    ch,
    pad,
    index: new Map(CHARS.map((c, i) => [c, i])),
  };
  cache.set(key, atlas);
  return atlas;
}

export function textWidth(str: string | number, scale = 1, tracking = 1): number {
  const n = String(str).length;
  return n <= 0 ? 0 : (n * (GLYPH_W + tracking) - tracking) * scale;
}

export interface TextOpts {
  colour?: number;
  outline?: number;
  scale?: number;
  tracking?: number;
  align?: "left" | "center" | "right";
}

export function drawText(
  ctx: CanvasRenderingContext2D,
  str: string | number,
  x: number,
  y: number,
  opts: TextOpts = {}
): number {
  const {
    colour = 0xffffffff,
    outline = 0,
    scale = 1,
    tracking = 1,
    align = "left",
  } = opts;
  const atlas = getAtlas(colour, outline);
  const text = String(str).toUpperCase(); // the face is uppercase-only
  const w = textWidth(text, scale, tracking);
  let px = Math.round(align === "center" ? x - w / 2 : align === "right" ? x - w : x);
  const py = Math.round(y); // ALWAYS round — a glyph at x=40.5 resamples to mush
  const step = (GLYPH_W + tracking) * scale;

  // Back off by the atlas padding, not a flat `scale`, so the glyph's own top-left
  // lands on (px, py) whether or not an outline was baked in. With an outline the
  // pad is 1 and this matches the spec exactly; without one it avoids shifting the
  // text a pixel up and to the left.
  const off = atlas.pad * scale;

  for (const ch of text) {
    const idx = atlas.index.get(ch);
    if (idx === undefined) {
      px += step;
      continue;
    }
    ctx.drawImage(
      atlas.canvas,
      idx * atlas.cw, 0, atlas.cw, atlas.ch,
      px - off, py - off, atlas.cw * scale, atlas.ch * scale
    );
    px += step;
  }
  return w;
}
