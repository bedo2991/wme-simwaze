# SimWaze — Live Traffic & Chaos Simulator

Turn the Waze Map Editor (WME) into a living, breathing, top-down traffic simulator!

## Features

- **Real WME Network Physics:** Tiny Wazers spawn primarily on highways (Freeways, Major/Minor Highways, Ramps) and navigate to random destination streets using your actual **turn restrictions**, **speed limits** (km/h or mph), **one-way directions**, **lane capacities**, and **active road closures**.
- **Road-Type Capacity & Multi-Lane Flow:** Multi-lane freeways support dense, fast-moving streams with lane-changing, while narrow local streets and alleys saturate quickly and back up if fed by heavy highway traffic.
- **Chaos Bug Detector:** If you accidentally leave a **disconnected node** (including tiny unmerged phantom gaps), an **impossible turn restriction**, a **one-way trap**, or an un-detourable **road closure**, Wazers legally drive right up to the mistake, pile up in a growing traffic jam, honk tiny horns (`BEEP!`), and eventually catch fire!
- **Chaos Radar & Instant Live Recovery:** Open the **SimWaze** sidebar tab to click any burning hotspot—your map centers directly on the broken node or segment. Fix the turn or connect the node, and watch the fire extinguish as the jam clears in real time!
- **Optional Tiny SFX & Overlays:** Toggle synthesized Web Audio car horns & fire crackle, congestion heatmap glow, hover route previews, and floating bug badges.

## Installation Instructions

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or another userscript manager).
2. Install **SimWaze** [latest release](https://github.com/bedo2991/wme-simwaze/releases/latest/download/release.user.js).
3. Open the Waze Map Editor at zoom level **16+** and open the **SimWaze** tab in the Scripts sidebar (or press `Alt + Shift + S` to toggle simulation).

## Development

```bash
npm install
npm test
npx tsc --noEmit
npm run build      # Development bundle -> releases/release-<version>.user.js
npm run release    # Minified production bundle
```

## Disclaimer

**SimWaze** is an independent, community-developed userscript and is **not** affiliated with, provided by, endorsed by, sponsored by, or supported in any way by **Waze Mobile Ltd.** or **Google LLC**. "Waze", the Waze logo, Waze mood icons, and related marks and assets are trademarks or copyrighted property of Waze Mobile Ltd. All rights belong to their respective owners and are reserved.

This script is provided **"as is"**, without warranty of any kind, express or implied. Users use it at their own risk and remain solely responsible for verifying all map edits and for any errors or issues caused to the map that may occur while using it.

## License

MIT — see [LICENSE](./LICENSE).
