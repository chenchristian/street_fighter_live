"use client";
// Simple CPU AI — randomly picks moves, weighted toward attacks when close
import type { CharState } from "./types";

// CV label → buffer-state name (Ryu.json state names)
export const CV_TO_STATE: Record<string, string> = {
  jab:                     "Stand Jab",
  cross:                   "Stand Strong",
  lead_hook:               "Stand Fierce",
  rear_hook:               "Crouch Strong",
  uppercut:                "Crouch Fierce",
  jumping_cross:           "Front Jump",
  rear_low_kick:           "Stand Short",
  side_kick:               "Stand Forward",
  spinning_back_high_kick: "Stand Roundhouse",
  crouching_low_sweep:     "Crouch Roundhouse",
  grab:                    "Grab",
  hadouken:                "Hadouken Jab",     // animation plays; no projectile (create_object not yet implemented)
  shoryuken:               "Shoryuken Jab",
};

// CPU state pool weighted by distance
const CPU_IDLE_STATES = ["Stand", "Walk Forward", "Walk Backward", "Crouch"];
const CPU_ATTACK_STATES = [
  "Stand Jab", "Stand Short", "Stand Strong", "Stand Fierce",
  "Crouch Jab", "Crouch Short",
];
const CPU_TIMER_IDLE = 60;    // frames between CPU decisions when idle
const CPU_TIMER_ATTACK = 30;  // frames between decisions when close
const CPU_TIMER_SPECIAL = 45; // longer commitment after a special

let cpuTimer = 0;

export function updateCpuInput(cpu: CharState, player: CharState): void {
  cpuTimer--;
  if (cpuTimer > 0) return;

  const dist = Math.abs(cpu.pos[0] - player.pos[0]);
  const isClose = dist < 250;

  let stateName: string;

  // From full-screen, occasionally throw a fireball to zone the player.
  if (dist > 550 && Math.random() < 0.4) {
    stateName = "Hadouken Jab";
    cpuTimer = CPU_TIMER_SPECIAL;
  } else if (isClose && Math.random() < 0.15) {
    // Up close, sometimes go for the Shoryuken (launcher) as a reversal.
    stateName = "Shoryuken Jab";
    cpuTimer = CPU_TIMER_SPECIAL;
  } else if (isClose && Math.random() < 0.6) {
    stateName = CPU_ATTACK_STATES[Math.floor(Math.random() * CPU_ATTACK_STATES.length)];
    cpuTimer = CPU_TIMER_ATTACK;
  } else if (dist > 300) {
    // Move toward player if far (auto-face already orients toward opponent)
    stateName = "Walk Forward";
    cpuTimer = CPU_TIMER_IDLE;
  } else {
    stateName = CPU_IDLE_STATES[Math.floor(Math.random() * CPU_IDLE_STATES.length)];
    cpuTimer = CPU_TIMER_IDLE;
  }

  // Fall back to a basic poke if this character lacks the chosen special.
  if (!cpu.data.states[stateName]) stateName = "Stand Jab";

  if (cpu.data.states[stateName]) {
    cpu.bufferState[stateName] = 8;
    cpu.inputInterPress = true;
  }
}
