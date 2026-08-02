"use client";
// ──────────────────────────────────────────────────────────────────────────────
// Collision detection — port of Util/Box_Collitions.py
// Pass order matches Python's calculate_boxes_collitions:
//   1. hitbox vs hurtbox (all ordered pairs)
//   2. pushbox vs pushbox (all unordered pairs)
//   3. boundingbox vs stage (floor, walls, landing) — LAST, so pushes get clamped
// ──────────────────────────────────────────────────────────────────────────────

import type { CharState, BoxSet, HitboxSet } from "./types";
import type { GuardResult } from "./engine";
import { applyHit, getCommand, getState, nextFrameCurrent, triggerState } from "./engine";

// Basic AABB test
function boxCollide(
  r1x: number, r1y: number, r1w: number, r1h: number,
  r2x: number, r2y: number, r2w: number, r2h: number
): boolean {
  return r1x < r2x + r2w && r1x + r1w > r2x && r1y < r2y + r2h && r1y + r1h > r2y;
}

// Convert a box definition [ox, oy, w, h] + char position/facing to world AABB
// Matches Python: pos[0] + ox * face - w * (face < 0)
// The -w term shifts the left edge when facing left so the box mirrors correctly.
export function worldBox(
  box: [number, number, number, number],
  char: CharState
): [number, number, number, number] {
  const [ox, oy, w, h] = box;
  const wx = char.pos[0] + ox * char.face - w * (char.face < 0 ? 1 : 0);
  const wy = char.pos[1] + oy;
  return [wx, wy, w, h];
}

// ─── Full collision pass over the live object list ────────────────────────────

export function runCollisions(objects: CharState[], stage: CharState): void {
  const active = objects.filter(
    o => !o.killed && (o.type === "character" || o.type === "projectile")
  );

  // 1. Hits + grabs (ordered pairs, like Python's permutations)
  for (const a of active) {
    for (const b of active) {
      if (a === b) continue;
      applyGrabCollision(a, b);
      applyHitCollision(a, b);
    }
  }

  // 2. Push (unordered pairs)
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      applyPushCollision(active[i], active[j]);
    }
  }

  // 3. Stage bounds last
  for (const o of active) {
    applyBoundingBox(o, stage);
  }
}

// ─── Stage bounding box — floor, landing, walls ───────────────────────────────

export function applyBoundingBox(char: CharState, stage: CharState): void {
  const stageBB = stage.boxes["boundingbox"] as BoxSet;
  if (!stageBB || stageBB.boxes.length === 0) return;
  const [sx, sy, sw, sh] = stageBB.boxes[0];

  const charBB = char.boxes["boundingbox"] as BoxSet;
  if (!charBB || charBB.boxes.length === 0) {
    // No bounding box (projectiles): free flight, never grounded (Python behavior)
    char.fet = "airborne";
    return;
  }

  const friction =
    (charBB as BoxSet & { grounded_friction?: number }).grounded_friction ?? 0.7;
  const floorY = sy + sh; // top edge of the stage box = the floor

  if (char.pos[1] <= floorY) {
    // ── Floor contact ──
    if (char.fet !== "grounded" && char.grabed == null && char.hitstop === 0) {
      // Landing: reset hit state (mirrors Python boundingbox_boundingbox_collide)
      char.fet = "grounded";
      char.frame = [0, 0];
      char.wallbounce = false;
      char.hitstun = 0;
      char.airTime = 0;
      char.juggle = 100;
      char.currentCommand = [...char.currentCommand, "landing"];
      // Landing states are picked by the command system: "landing" + the state
      // we landed in (getCommand includes currentState in its state list).
      getCommand(char, [...char.currentCommand, ...char.inputCurrentInput]);
      const got = getState(char, char.bufferState);
      if (got) nextFrameCurrent(char);
    }
    if (!char.hitstop) {
      // Ground friction (only outside hitstop — otherwise knockback decays to
      // nothing before the defender ever moves)
      char.speed[0] *= char.hitstun ? 0.85 : friction;
    }
    char.pos[1] = floorY;
    if (char.speed[1] < 0) char.speed[1] = 0;
    if (char.hitstop === 0) char.fet = "grounded";
  } else {
    // ── Airborne ──
    if (char.fet === "grounded") char.inputInterPress = true;
    char.fet = "airborne";
    char.airTime++;
    const af =
      ((charBB as BoxSet & { airborne_friction?: [number, number] }).airborne_friction) ??
      [1, 1];
    char.speed = [char.speed[0] * af[0], char.speed[1] * af[1]];
  }

  // ── Walls ──
  const [cbx, , cbw] = worldBox(charBB.boxes[0], char);
  const leftWall = sx;
  const rightWall = sx + sw;

  const hitLeft = cbx < leftWall;
  const hitRight = cbx + cbw > rightWall;

  if (hitLeft || hitRight) {
    // Air-tumble wallbounce (mirrors Python: relaunch off the wall)
    if (char.wallbounce && char.currentState.includes("ummble")) {
      char.frame = [0, 0];
      char.speed = hitLeft ? [14, 24] : [-14, 24];
      char.face = hitLeft ? -1 : 1;
      char.bufferState["Tummble"] = 1;
      char.hitstop = 16;
      char.juggle = 80;
      char.wallbounce = false;
    }
    if (hitLeft) {
      char.pos[0] += leftWall - cbx;
      char.speed[0] = Math.max(0, char.speed[0]);
    } else {
      char.pos[0] -= cbx + cbw - rightWall;
      char.speed[0] = Math.min(0, char.speed[0]);
    }
  }
}

// ─── Pushbox collision — prevent characters from overlapping ─────────────────

export function applyPushCollision(a: CharState, b: CharState): void {
  if (a.team === b.team) return;
  const pbA = a.boxes["pushbox"] as BoxSet;
  const pbB = b.boxes["pushbox"] as BoxSet;
  if (!pbA?.boxes.length || !pbB?.boxes.length) return;

  for (const boxA of pbA.boxes) {
    for (const boxB of pbB.boxes) {
      const [ax, ay, aw, ah] = worldBox(boxA, a);
      const [bx, by, bw, bh] = worldBox(boxB, b);
      if (!boxCollide(ax, ay, aw, ah, bx, by, bw, bh)) continue;

      // Perfectly stacked: nudge both backward so left/right resolves next
      if (a.pos[0] === b.pos[0]) {
        a.pos[0] -= a.face;
        b.pos[0] -= b.face;
      }

      // Meet at the midpoint of the facing edges (mirrors Python's resolution)
      if (a.pos[0] < b.pos[0]) {
        const x = Math.round(((ax + aw + bx) / 2) * 100) / 100;
        a.pos[0] = x - boxA[0] * a.face + boxA[2] * (a.face < 0 ? 1 : 0) - boxA[2];
        b.pos[0] = x - boxB[0] * b.face + boxB[2] * (b.face < 0 ? 1 : 0);
      } else if (b.pos[0] < a.pos[0]) {
        const x = Math.round(((bx + bw + ax) / 2) * 100) / 100;
        b.pos[0] = x - boxB[0] * b.face + boxB[2] * (b.face < 0 ? 1 : 0) - boxB[2];
        a.pos[0] = x - boxA[0] * a.face + boxA[2] * (a.face < 0 ? 1 : 0);
      }
      return;
    }
  }
}

// ─── Takebox vs grabbox (throws) ──────────────────────────────────────────────
// Mirrors takebox_grabbox_collide + the take_coll_grab resolution loop in Python.
// The grabber's takebox (present only during a Grab's active frame) carries extra
// keys — influence / other_get_state / trigg_state — that set up the throw.

export function applyGrabCollision(grabber: CharState, victim: CharState): void {
  if (grabber.team === victim.team) return;
  if (grabber.influenceObject || victim.grabed) return;   // already in a throw

  const takebox = grabber.boxes["takebox"] as BoxSet & {
    trigg_state?: string;
    other_get_state?: string[];
    influence?: string;
  };
  const grabbox = victim.boxes["grabbox"] as BoxSet;
  if (!takebox?.boxes.length || !grabbox?.boxes.length) return;

  let hit = false;
  for (const tb of takebox.boxes) {
    const [tx, ty, tw, th] = worldBox(tb, grabber);
    for (const gb of grabbox.boxes) {
      const [gx, gy, gw, gh] = worldBox(gb, victim);
      if (boxCollide(tx, ty, tw, th, gx, gy, gw, gh)) { hit = true; break; }
    }
    if (hit) break;
  }
  if (!hit) return;

  // Resolution order matches Python's function_dict: influence → other_get_state → trigg_state.
  // 1. influence "other": link the victim so influence_pos/_speed can puppet it.
  if (takebox.influence === "other") {
    grabber.influenceObject = victim;
    victim.grabed = grabber;
    grabber.frame = [0, 0];
  }
  // 2. other_get_state: victim transitions to its throw-tumble via the command system.
  //    The gate keys on the grabber's name + current state (still "Grab" at this point).
  //    Like a hit, a throw is a forced transition: reset the victim's cancel/frame so
  //    getState accepts the tumble state (whose cancel defaults to [null]) — otherwise
  //    the victim's idle cancel ("neutral") wouldn't intersect it.
  if (takebox.other_get_state) {
    victim.cancel = [null];
    victim.frame = [0, 0];
    getCommand(victim, [
      ...victim.currentCommand,
      grabber.data.name,
      grabber.currentState,
      ...takebox.other_get_state,
    ]);
    const got = getState(victim, victim.bufferState);
    if (got) nextFrameCurrent(victim);
  }
  // 3. trigg_state: grabber snaps into its throw animation.
  if (takebox.trigg_state) {
    triggerState(grabber, takebox.trigg_state);
  }
}

// ─── Hitbox vs hurtbox ────────────────────────────────────────────────────────

export function applyHitCollision(attacker: CharState, defender: CharState): void {
  if (attacker.team === defender.team) return;

  const hitbox = attacker.boxes["hitbox"] as HitboxSet;
  const hurtbox = defender.boxes["hurtbox"] as BoxSet;
  if (!hitbox?.boxes.length || !hurtbox?.boxes.length) return;

  // Gates (mirror Python hitbox_hurtbox_collide):
  if (!(hitbox.hitset ?? 1)) return;                              // already consumed
  if (attacker.hitstop !== 0 && defender.hitstop !== 0) return;   // both frozen
  if (!(defender.juggle > (hitbox.juggle ?? 1))) return;          // juggled out

  for (const hb of hitbox.boxes) {
    const [hx, hy, hw, hh] = worldBox(hb, attacker);
    for (const hurt of hurtbox.boxes) {
      const [ux, uy, uw, uh] = worldBox(hurt, defender);
      if (boxCollide(hx, hy, hw, hh, ux, uy, uw, uh)) {
        const guard = resolveGuard(defender, hitbox);
        applyHit(attacker, defender, hitbox, [hx + hw / 2, hy + hh / 2], guard);
        return;
      }
    }
  }
}

// ─── Guard resolution — port of the block/parry branch in Box_Collitions.py ───
//
// Attack heights: "high" and "middle" are blocked standing, "low" and "middle"
// crouching. Guessing wrong means eating the hit — that mixup is the whole
// point of an overhead vs. a sweep.

// Tokens on a frame's `cancel` that leave the defender free to guard.
// Python spells this "interruption" but every character JSON uses "interrupt";
// accept both so the intended frames actually qualify.
const GUARD_OPEN = ["neutral", "interrupt", "interruption", "blocking"];
const PARRY_OPEN = [...GUARD_OPEN, "parry"];

export function resolveGuard(defender: CharState, hitbox: HitboxSet): GuardResult {
  const hittype = hitbox.hittype ?? ["medium", "middle"];
  const hits = (...heights: string[]) => heights.some(h => hittype.includes(h));
  const cancelOpen = (toks: string[]) => defender.cancel.some(c => toks.includes(c as string));
  const dpad = defender.inputCurrentInput[0];
  const guard = defender.guard ?? [];
  const [parryDir, parryTimer] = defender.parry;

  // ── Parry first: it beats blocking when both would apply ──
  // The window is 24 frames but only its first 8 (timer >= 16) actually parry;
  // a dedicated parry state (guard contains "parry") always succeeds.
  if (cancelOpen(PARRY_OPEN)) {
    const armed = parryTimer > 0;
    const inWindow = parryTimer >= 16 || guard.includes("parry");
    if ((armed && parryDir === "6") || guard.includes("parry")) {
      if (hits("high", "middle") && inWindow) {
        defender.parry[1] = 0;
        return { kind: "parry", stance: "stand" };
      }
    }
    if ((armed && parryDir === "3") || guard.includes("parry")) {
      if (hits("low", "middle") && inWindow) {
        defender.parry[1] = 0;
        return { kind: "parry", stance: "crouch" };
      }
    }
  }

  // ── Block: holding back ("4") stands, down-back ("1") crouches ──
  if (cancelOpen(GUARD_OPEN) && defender.fet === "grounded") {
    const blocking = guard.includes("block");
    if ((dpad === "4" || blocking) && hits("high", "middle")) {
      return { kind: "block", stance: "stand" };
    }
    if ((dpad === "1" || blocking) && hits("low", "middle")) {
      return { kind: "block", stance: "crouch" };
    }
  }

  return { kind: "hurt", stance: null };
}
