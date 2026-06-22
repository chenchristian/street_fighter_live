"use client";
// ──────────────────────────────────────────────────────────────────────────────
// Collision detection — port of Util/Box_Collitions.py
// ──────────────────────────────────────────────────────────────────────────────

import type { CharState, BoxSet, HitboxSet } from "./types";
import { applyHit } from "./engine";

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
function worldBox(
  box: [number, number, number, number],
  char: CharState
): [number, number, number, number] {
  const [ox, oy, w, h] = box;
  const wx = char.pos[0] + ox * char.face - w * (char.face < 0 ? 1 : 0);
  const wy = char.pos[1] + oy;
  return [wx, wy, w, h];
}

// Stage bounding box collision — keeps character on floor and within walls
export function applyBoundingBox(
  char: CharState,
  stage: CharState
): void {
  const bb = stage.boxes["boundingbox"] as BoxSet;
  if (!bb || bb.boxes.length === 0) return;
  const stageBox = bb.boxes[0];
  const [sx, sy, sw, sh] = stageBox;
  const friction = (bb as BoxSet & { grounded_friction?: number }).grounded_friction ?? 0.7;

  // Floor (top of bounding box in Y-up space)
  const floorY = sy + sh;

  // Check character's pushbox vs stage floor
  const pb = char.boxes["pushbox"] as BoxSet;
  if (pb && pb.boxes.length > 0) {
    const [, cpy, , cph] = worldBox(pb.boxes[0], char);
    // Character bottom of pushbox should not go below floorY
    if (char.pos[1] <= floorY) {
      if (char.fet === "airborne") {
        // Landing
        char.speed[1] = 0;
        // Add "landing" to command buffer for landing-state transitions
        char.currentCommand = [...char.currentCommand, "landing", char.currentState];
        char.inputInterPress = true;
        // Open a cancel window so canTransition fires even inside infinite repeat_substate loops
        char.cancel = ["neutral"];
        char.bufferState = {
          ...char.bufferState,
          "Neutral Landing": 4,
        };
        // Check if current state triggers a specific landing state
        const stateData = char.data.states[char.currentState];
        if (stateData) {
          // Force landing state lookup
          for (const stateName in char.data.states) {
            const sd = char.data.states[stateName];
            if (!sd.command) continue;
            for (const cmdSeq of sd.command) {
              if (cmdSeq.some(part => part.includes("landing") && part.includes(char.currentState))) {
                char.bufferState[stateName] = 8;
              }
            }
          }
        }
      }
      char.speed[0] *= friction;  // apply every grounded frame (matches Python behavior)
      char.fet = "grounded";
      char.pos[1] = floorY;
      char.airTime = 0;
    } else {
      char.fet = "airborne";
      char.airTime++;
    }
    void cpy; void cph;
  }

  // Wall collision (character bounded to stage X)
  const char_bb = char.boxes["boundingbox"] as BoxSet;
  if (char_bb && char_bb.boxes.length > 0) {
    const [cbx, , cbw] = worldBox(char_bb.boxes[0], char);
    const leftWall = sx;
    const rightWall = sx + sw;

    if (cbx < leftWall) {
      char.pos[0] += leftWall - cbx;
      if (char.wallbounce) {
        char.speed[0] = Math.abs(char.speed[0]);
        char.wallbounce = false;
      } else {
        char.speed[0] = Math.max(0, char.speed[0]);
      }
    }
    if (cbx + cbw > rightWall) {
      char.pos[0] -= cbx + cbw - rightWall;
      if (char.wallbounce) {
        char.speed[0] = -Math.abs(char.speed[0]);
        char.wallbounce = false;
      } else {
        char.speed[0] = Math.min(0, char.speed[0]);
      }
    }
  }
}

// Pushbox collision — prevent characters from overlapping
export function applyPushCollision(a: CharState, b: CharState): void {
  const pbA = a.boxes["pushbox"] as BoxSet;
  const pbB = b.boxes["pushbox"] as BoxSet;
  if (!pbA?.boxes.length || !pbB?.boxes.length) return;

  const [ax, ay, aw, ah] = worldBox(pbA.boxes[0], a);
  const [bx, by, bw, bh] = worldBox(pbB.boxes[0], b);

  if (!boxCollide(ax, ay, aw, ah, bx, by, bw, bh)) return;

  // Push them apart horizontally
  const overlap = Math.min(ax + aw - bx, bx + bw - ax) / 2;
  if (a.pos[0] < b.pos[0]) {
    a.pos[0] -= overlap;
    b.pos[0] += overlap;
  } else {
    a.pos[0] += overlap;
    b.pos[0] -= overlap;
  }
}

// Hitbox vs hurtbox collision — check if attacker hits defender
export function applyHitCollision(attacker: CharState, defender: CharState): void {
  const hitbox = attacker.boxes["hitbox"] as HitboxSet;
  const hurtbox = defender.boxes["hurtbox"] as BoxSet;

  if (!hitbox?.boxes.length || !hurtbox?.boxes.length) return;
  if (!(hitbox.hitset ?? 1)) return;  // already hit this frame

  // Check each hitbox rect against each hurtbox rect
  for (const hb of hitbox.boxes) {
    const [hx, hy, hw, hh] = worldBox(hb, attacker);
    for (const hurt of hurtbox.boxes) {
      const [ux, uy, uw, uh] = worldBox(hurt, defender);
      if (boxCollide(hx, hy, hw, hh, ux, uy, uw, uh)) {
        applyHit(attacker, defender, hitbox);
        return;
      }
    }
  }
}
