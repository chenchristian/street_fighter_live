# Street Fighter Live

A browser fighting game you control with your body. A webcam feed goes through
MediaPipe Pose, a trained LSTM classifies the pose into one of 14 moves via
ONNX Runtime Web, and those moves drive a frame-accurate fighting engine ported
from the original PyGame/OpenGL project in `../CV_to_StreetFighter`.

Modes: **1P vs CPU** (`/game`) and **2P online** over WebRTC (`/versus`).

## Running

```bash
npm install && npm run dev
```

Then open http://localhost:3000. A webcam is required to play with your body;
the debug keyboard controls work without one.

## Controls

The CV classifier is the real input. Keyboard is a debug source, toggled with
the **Keys** checkbox, and uses the mapping from `CV_to_StreetFighter/keyboardguide.txt`:

| Input | Action |
| --- | --- |
| Arrows | move / crouch / jump |
| A / S / D | light / medium / heavy punch |
| Q / W / E | light / medium / heavy kick |
| ↓ ↘ → + punch | Hadouken |
| → ↓ ↘ + punch | Shoryuken |
| Hold ← | block high · hold ↙ block low |
| Tap → | parry |

## Architecture

Nothing writes game state directly; every move goes through the command system,
so CV, keyboard, CPU and network inputs are all interchangeable.

```
input source ──▶ InputDevice ──▶ command tokens ──▶ getCommand ──▶ getState
(CV / keys /                     "5" "6" "p_b6"     matches the     transitions
 CPU / peer)                     "QCF" "block"      character JSON  the fighter
```

| Path | Role |
| --- | --- |
| `lib/game/engine.ts` | State machine, frame data, hit resolution — port of `Util/Common_functions.py` + `Active_Objects.py` |
| `lib/game/collision.ts` | Hitbox/hurtbox/pushbox/throw AABBs, block & parry resolution |
| `lib/game/input.ts` | Raw input → command tokens, 10-frame history buffer for motion inputs |
| `lib/game/sources.ts` | Keyboard and CV input sources |
| `lib/game/cpu.ts` | CPU AI state machine — drives a virtual controller, no privileged access |
| `lib/game/match.ts` | Tick loop, rounds, announcer |
| `lib/game/clock.ts` | Fixed 60Hz step, clocked from a Web Worker |
| `lib/game/rng.ts` | Seeded RNG — every nondeterministic draw goes through it |
| `lib/net/` | PeerJS transport, input bitmasks, rollback snapshots |
| `lib/render/stage.ts` | Procedurally drawn parallax stage |
| `app/game/GameCanvas.tsx` | Low-res world buffer, nearest-neighbour upscale, HUD |

### Why a Web Worker clock

`requestAnimationFrame` stops in a background tab and `setInterval` is clamped
to 1 Hz there, which ran the simulation at 15 fps. Worker timers are exempt from
that throttling, so the worker is the metronome and the main thread steps the
simulation.

### Netplay

Only inputs cross the wire — both peers run the identical deterministic
simulation over the identical input stream. Local input is applied `delay`
frames later (delay chosen from measured RTT) to give the network time to
deliver it. If a remote input hasn't arrived, the frame runs on the peer's last
known input; when the truth arrives and differs, the sim rewinds to that frame
and replays. Peers exchange state checksums once a second so a divergence is
reported rather than silently played out.

Determinism is verifiable in the browser without a second peer:

```js
window.__clock.stop();
const snap = window.__snapshot();
const stream = Array.from({length: 180}, () => [Math.random()*1024|0, Math.random()*1024|0]);
const a = stream.map(([p1,p2]) => (window.__tickRaw(p1,p2), window.__checksum()));
window.__restore(snap);
const b = stream.map(([p1,p2]) => (window.__tickRaw(p1,p2), window.__checksum()));
console.log(a.every((v,i) => v === b[i]));  // true
```

## Python tooling

`export_model.py` converts the trained PyTorch LSTM to the ONNX graph in
`public/model/`. Managed with [uv](https://docs.astral.sh/uv/):

```bash
uv sync
```

The export validates itself against the PyTorch output before writing:

```bash
cd ../CV_to_StreetFighter && ../street_fighter_live/.venv/bin/python ../street_fighter_live/export_model.py
```

## Assets

Character sprites are from *Street Fighter III*, used for educational purposes,
and are unmodified from the original project — see `CV_to_StreetFighter/README.md`
for sources. The stage background is drawn procedurally in `lib/render/stage.ts`;
no stage art ships with the project.
