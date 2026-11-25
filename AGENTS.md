# AGENTS.md — SimWaze (`wme-simwaze`)

Guidelines and architectural context for AI coding agents working on `wme-simwaze`.

## Project Overview
Userscript for the Waze Map Editor (WME) that turns the static map into a live top-down traffic & chaos simulator. Tiny Wazers spawn on major highways, route to random streets obeying real turn restrictions, speed limits, and road closures, and pile up, honk, and catch fire when they hit disconnected nodes, impossible turns, or closures.

---

## Critical Rules & Constraints

1. **WME SDK Mode (`AsyncWmeSDK`):**
   - Always use the **asynchronous `AsyncWmeSDK`** interface (`import { AsyncWmeSDK } from "wme-sdk-typings"`), initialized with `mode: "async"`.
   - Under `AsyncWmeSDK`, SDK calls (`DataModel`, `Editing`, `Map`, `Settings`, `Shortcuts`, `LayerSwitcher`, `Sidebar`, `Events.trackDataModelEvents`) return `Promise`s and must be `await`ed (`Events.on`, `Events.off`, `getSDKVersion()`, and `getWMEVersion()` remain synchronous).
2. **Zero Legacy Globals (`W`, `OpenLayers`, `I18n`, `WazeWrap`):**
   - Never use deprecated or legacy WME globals. All map, data model, selection, layer switcher, shortcut, and event interactions use `wmeSDK`.
3. **Self-Contained Mood Sprites:**
   - Waze mood icons are embedded as compact PNG data URIs in [`src/assets/moods.ts`](./src/assets/moods.ts) via [`scripts/fetch-moods.py`](./scripts/fetch-moods.py) so canvas rendering never depends on expiring URLs or cross-origin image headers.

---

## Architecture & Module Responsibilities

- [`main.user.ts`](./main.user.ts): SDK bootstrap (`window.SDK_INITIALIZED`), settings persistence, WME event wiring, `Alt+Shift+S` shortcut registration, and `requestAnimationFrame` loop.
- [`src/types.ts`](./src/types.ts): Shared types (`SimSettings`, `DirectedEdge`, `RoadGraph`, `WazerAgent`, `ChaosHotspot`, `Particle`).
- [`src/roadProfiles.ts`](./src/roadProfiles.ts): Road-type spawn weights, destination weights, default speeds, lane counts, and capacity formulas.
- [`src/geo.ts`](./src/geo.ts): Haversine/equirectangular metric math, polyline sampling with left/right-hand lane offsets, and synchronous `WebMercatorProjector` calibrated via `wmeSDK.Map`.
- [`src/graph.ts`](./src/graph.ts): Extracts segments, nodes, turns, road closures, turn closures, streets, and user/country settings into a `RoadGraph`, including spatial phantom-gap detection for disconnected nodes (`<= 22m`).
- [`src/router.ts`](./src/router.ts): Two-tier A\* router (Pass 1 strictly legal; Pass 2 diagnostic search that stops Wazers right before any illegal turn, closure, or disconnected node).
- [`src/simulator.ts`](./src/simulator.ts): Headless simulation engine (weighted spawning, car-following, multi-lane overtaking, capacity/intersection merge limits, dynamic rerouting, honk/fire chaos escalation, live bug-fix recovery, and `ChaosHotspot` clustering).
- [`src/audio.ts`](./src/audio.ts): Opt-in procedural Web Audio API tiny horn and fire-ignite SFX.
- [`src/renderer.ts`](./src/renderer.ts): High-DPI `<canvas>` overlay rendering congestion heatmaps, hover route previews, Waze mood sprites, speech bubbles, fire/smoke particles, and floating tooltips.
- [`src/ui.ts`](./src/ui.ts): Sidebar tab (`SimWaze`), LayerSwitcher checkbox, accessible sliders/checkboxes/accordions, and clickable Chaos Radar list.
- [`tests/sim.test.ts`](./tests/sim.test.ts): Deterministic unit and integration tests for road capacities, speed limits, closures, turn restrictions, and disconnected nodes.

---

## Build & Verification Commands

- `npm test`: Bundle and run [`tests/sim.test.ts`](./tests/sim.test.ts).
- `npx tsc --noEmit`: Run strict TypeScript typechecking.
- `npm run compile`: Development Rollup build into `.out/main.user.js`.
- `npm run build`: Development build concatenated with `header.js` into `releases/release-<version>.user.js`.
- `npm run release`: Production build (`NODE_ENV=production`, strips `console.debug`, minifies with Terser).
