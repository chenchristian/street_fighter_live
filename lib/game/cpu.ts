"use client";
// Simple CPU AI — randomly picks moves, weighted toward attacks when close
import type { CharState } from "./types";

// CV label → buffer-state name (Ryu.json state names)
export const CV_TO_STATE: Record<string, string> = {
  jab:                     "Stand Jab",
  cross:                   "Stand Strong",
  lead_hook:               "Stand Fierce",
  rear_hook:               "Stand Strong",
  uppercut:                "Shoryuken Jab",
  jumping_cross:           "Front Jump",
  rear_low_kick:           "Stand Roundhouse",
  side_kick:               "Stand Forward",
  spinning_back_high_kick: "Stand Roundhouse",
  crouching_low_sweep:     "Crouch Short",
  grab:                    "Grab",
  hadouken:                "Stand Jab",    // Hadouken needs QCF; use Jab instead
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

let cpuTimer = 0;

export function updateCpuInput(cpu: CharState, player: CharState): void {
  cpuTimer--;
  if (cpuTimer > 0) return;

  const dist = Math.abs(cpu.pos[0] - player.pos[0]);
  const isClose = dist < 250;

  // Pick next move
  cpuTimer = isClose ? CPU_TIMER_ATTACK : CPU_TIMER_IDLE;

  let stateName: string;
  if (isClose && Math.random() < 0.65) {
    stateName = CPU_ATTACK_STATES[Math.floor(Math.random() * CPU_ATTACK_STATES.length)];
  } else {
    // Move toward player if far (auto-face already orients toward opponent)
    if (dist > 300) {
      stateName = "Walk Forward";
    } else {
      stateName = CPU_IDLE_STATES[Math.floor(Math.random() * CPU_IDLE_STATES.length)];
    }
  }

  if (cpu.data.states[stateName]) {
    cpu.bufferState[stateName] = 8;
    cpu.inputInterPress = true;
  }
}
