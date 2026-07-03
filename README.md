# Soil Studio

An interactive, real-time **procedural soil sandbox** built with [Three.js](https://threejs.org/). A single displaced ground plane is reshaped and re-shaded entirely on the GPU into mounded, cracked, mossy, wind-blown terrain — then framed with a cinematic post-processing stack (volumetric clouds, depth of field, bloom and film grade). Everything is driven live from an on-screen control panel.

> Despite the repository name (`GrassSystemThreeJS`), the app has grown into a full soil/terrain studio: soil shaping, moss, grass, models, weather and camera all in one scene.

## Features

- **Procedural soil surface** — a shared world-space noise field raises broad mounds and fine relief, breaks up the albedo with dry/rich tone variation, and darkens/glosses damp moisture patches. All controls (scale, coverage, edge softness, seed) are exposed live.
- **Dry cracks** — a warped cellular (Worley) plate network carves recessed, sun-baked fissures that actually groove the surface normals (not a flat decal).
- **Moss cover** — an FBM coverage mask lays a real moss texture set (color / roughness / normal / AO) over the ground *and* gives it height volume, so the moss lifts the geometry into a raised living carpet.
- **GPU-instanced grass** — the whole field is one draw call; every blade is placed, curled and wind-animated in the vertex shader and glued to the same terrain height field, so grass follows the mounds and moss live.
- **Wind field** — a coherent world-space gust flow plus per-blade flutter, with direction, strength, speed and gust size controls.
- **Model drop-in** — load a bundled GLB (Rusty Car / Porsche 911) or import your own `.glb` at runtime. Upward-facing faces accumulate their own displaced moss layer, sharing the ground's moss textures.
- **Volumetric clouds** — a true box-confined raymarch with height-falloff coverage, self-shadowing light march, Henyey–Greenstein backlight glow and detail erosion. Renders at reduced resolution and upsamples for performance.
- **Cinematic post-processing** — depth of field (with an Unreal-style focus-plane visualizer), Unreal bloom, tone mapping, and a film grade pass (chromatic aberration, contrast/saturation, vignette, grain). Plus MSAA, auto-orbit camera, adjustable FOV and letterbox bars.
- **Three-point lighting rig** — warm key (shadow-casting), cool fill, warm rim/back light, ambient, and neutral image-based lighting from a `RoomEnvironment`.

## Tech Stack

- [Three.js](https://threejs.org/) `^0.185` — rendering, shaders, post-processing passes
- [lil-gui](https://lil-gui.georgealways.com/) `^0.20` — the control panel
- [Vite](https://vitejs.dev/) `^6` — dev server and build

Shaders are injected into `MeshStandardMaterial` via `onBeforeCompile`, so the procedural soil, grass and moss all receive the scene's real lighting, shadows and fog.

## Getting Started

**Prerequisites:** [Node.js](https://nodejs.org/) (18+ recommended) and a browser with WebGL2.

```bash
# install dependencies
npm install

# start the dev server (Vite)
npm run dev

# build for production into dist/
npm run build

# preview the production build
npm run preview
```

Then open the URL Vite prints (defaults to `http://localhost:5173`).

## Usage

- **Orbit** — drag to rotate the camera.
- **Zoom** — scroll.
- **Sculpt** — open the panel (top-right) and tweak any folder live.

Most heavy features (**Grass**, **Moss Cover**, **Dry Cracks**, **Clouds**, **Model**, **Depth of Field**) are **off by default** — enable them from their folders. Use the 🎲 *Randomize Seed* buttons to pan each noise field to a fresh layout.

## Project Structure

```
index.html      # canvas, styled lil-gui panel, letterbox + credit overlay
vite.config.js  # Vite config
src/
  main.js       # scene, lighting, soil shader injection, all GUI wiring, render loop
  grass.js      # GPU-instanced, wind-reactive grass glued to the terrain height field
  clouds.js     # volumetric cloud raymarch (depth prepass → low-res march → composite)
  postfx.js     # EffectComposer stack: DoF → bloom → tone map → film grade
  model.js      # GLB loader + per-model moss-accumulation shader
public/
  Ground048_*   # PBR soil texture sets (color/AO/displacement/normal/roughness)
  Ground103_*
  Moss002_*     # PBR moss texture set
  *.glb         # bundled models
```

## Credits

- Soil and moss PBR textures follow the [ambientCG](https://ambientcg.com/) naming convention (`Ground048`, `Ground103`, `Moss002`).
- Simplex noise by Ashima Arts; cellular (Worley) and FBM helpers implemented in-shader.

## License

[MIT](LICENSE) © 2026 mohamedachrefelouafi
