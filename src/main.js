import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import GUI from 'lil-gui';
import { createPostFX } from './postfx.js';
import { createGrass } from './grass.js';

/* -------------------------------------------------------------------------- */
/*  Renderer                                                                   */
/* -------------------------------------------------------------------------- */
const canvas = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;

/* -------------------------------------------------------------------------- */
/*  Scene & Camera                                                             */
/* -------------------------------------------------------------------------- */
const scene = new THREE.Scene();
// Warm, hazy dusk so the bare earth reads with a little atmosphere. Fog blends
// each fragment toward the background by its distance FROM THE CAMERA, so keep
// it light (exposed in the GUI) and zooming won't read as a lighting change.
scene.background = new THREE.Color(0x171311);
scene.fog = new THREE.FogExp2(0x171311, 0.006);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  500
);
camera.position.set(6, 20, 32);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI * 0.495; // don't go below the ground
controls.minDistance = 2;
controls.maxDistance = 300;
controls.target.set(0, 0, 0);

/* -------------------------------------------------------------------------- */
/*  Image-based lighting (soft, neutral reflections)                          */
/* -------------------------------------------------------------------------- */
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.4;

/* -------------------------------------------------------------------------- */
/*  Cinematic lighting rig (warm key, cool fill, separating rim)               */
/* -------------------------------------------------------------------------- */
// Key light — warm, hard, casts the shadows.
const keyLight = new THREE.DirectionalLight(0xfff1dd, 3.0);
keyLight.position.set(8, 12, 6);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.near = 1;
keyLight.shadow.camera.far = 60;
keyLight.shadow.camera.left = -15;
keyLight.shadow.camera.right = 15;
keyLight.shadow.camera.top = 15;
keyLight.shadow.camera.bottom = -15;
keyLight.shadow.bias = -0.0002;
keyLight.shadow.normalBias = 0.02;
scene.add(keyLight);

// Fill light — cool, soft, lifts the shadows from the opposite side.
const fillLight = new THREE.DirectionalLight(0x6c8cff, 0.5);
fillLight.position.set(-9, 5, -4);
scene.add(fillLight);

// Rim / back light — separates the surface from the background.
const rimLight = new THREE.SpotLight(0xffd9a0, 110, 50, Math.PI * 0.25, 0.4, 1.2);
rimLight.position.set(-6, 8, -10);
rimLight.target.position.set(0, 0, 0);
scene.add(rimLight);
scene.add(rimLight.target);

// Gentle ambient so nothing reads as pure black.
const ambient = new THREE.AmbientLight(0x3a2f24, 0.4);
scene.add(ambient);

/* -------------------------------------------------------------------------- */
/*  Soil texture set (the PBR base the procedural shading sits on top of)      */
/* -------------------------------------------------------------------------- */
const SOIL_PREFIX = '/Ground103_1K-JPG_';
const loader = new THREE.TextureLoader();
const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

let allMaps = []; // rebuilt by loadTextures(); applyTextureScale() reads it by ref

const material = new THREE.MeshStandardMaterial({
  normalMapType: THREE.TangentSpaceNormalMap, // textures are OpenGL (GL) normals
  roughness: 1.0,
  metalness: 0.0,
  aoMapIntensity: 1.0,
  normalScale: new THREE.Vector2(1, 1),
  displacementScale: 0.0, // texture displacement — off by default, GUI turns it up
  displacementBias: 0.0,
  envMapIntensity: 1.0,
});

function loadTextures() {
  const make = (suffix, srgb = false) => {
    const tex = loader.load(SOIL_PREFIX + suffix + '.jpg');
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = maxAnisotropy;
    return tex;
  };

  for (const m of allMaps) m.dispose();

  material.map = make('Color', true); // sRGB; the rest are linear data maps
  material.aoMap = make('AmbientOcclusion');
  material.roughnessMap = make('Roughness');
  material.normalMap = make('NormalGL');
  material.displacementMap = make('Displacement');
  material.needsUpdate = true;

  allMaps = [
    material.map,
    material.aoMap,
    material.roughnessMap,
    material.normalMap,
    material.displacementMap,
  ];
  applyTextureScale(params.textureScale);
}

/* -------------------------------------------------------------------------- */
/*  Shared time uniform                                                        */
/* -------------------------------------------------------------------------- */
const shared = { uTime: { value: 0 } };

/* -------------------------------------------------------------------------- */
/*  Procedural soil shaping & shading uniforms                                 */
/* -------------------------------------------------------------------------- */
//  A world-space noise field reshapes and re-colours the bare ground: broad
//  mounds rise the geometry, large-scale tone variation breaks up the flat
//  albedo, optional moisture darkens & glosses damp patches, and dry cracks
//  cut dark fissures — all driven from the same texture set so the look stays
//  consistent across the ground plane AND the extruded mound.
const soilUniforms = {
  // --- Shape (vertex displacement) ----------------------------------------
  uMoundScale: { value: 0.12 }, // mound noise frequency (smaller = broader)
  uSeed: { value: new THREE.Vector2(8.3, 2.1) }, // pan the whole field
  uMoundDepth: { value: 0.55 }, // height of the mounds (world units)
  uBumpScale: { value: 0.7 }, // fine relief frequency
  uBumpStrength: { value: 0.6 }, // how lumpy the surface is
  // --- Albedo / shading ----------------------------------------------------
  uSoilColor: { value: new THREE.Color(0xffffff) }, // overall tint multiplier
  uVarScale: { value: 0.08 }, // tone-variation frequency
  uVarAmount: { value: 0.28 }, // dry/rich tone contrast
  uMoisture: { value: 0.0 }, // 0 = bone dry, 1 = soaked (fully covered)
  uMoistScale: { value: 0.18 }, // damp-patch frequency
  uMoistEdge: { value: 0.12 }, // damp-patch edge softness
  uMoistSeed: { value: new THREE.Vector2(5.0, 5.0) }, // pan the damp field
  uWetDarken: { value: 0.5 }, // how much wet soil darkens
  uWetRoughness: { value: 0.35 }, // wet soil is glossier
  uCrackAmount: { value: 0.0 }, // dry-earth fissures
  uCrackScale: { value: 0.5 }, // crack frequency
  uReliefShading: { value: 0.7 }, // strength of the mound shading normals
  uTime: shared.uTime,
};

// Pure noise helpers (no uniforms).
const NOISE_FUNCTIONS = /* glsl */ `
// --- Ashima 2D simplex noise -------------------------------------------------
vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v -   i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// Fractal Brownian motion for organic, blotchy shapes.
float fbm(vec2 p) {
  float value = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    value += amp * snoise(p);
    p *= 2.0;
    amp *= 0.5;
  }
  return value;
}
`;

// Terrain height field — SHARED by the soil material AND the grass (so blades
// sit exactly on the displaced ground, live, as the mound sliders move). Only
// the shaping uniforms it needs are declared here.
const HEIGHT_FUNCTIONS = /* glsl */ `
uniform float uMoundScale;
uniform vec2  uSeed;
uniform float uMoundDepth;
uniform float uBumpScale;
uniform float uBumpStrength;

// Height of the soil surface above the flat plane, in world units. Broad mounds
// modulated by finer lumps. Tapered to zero near the plane rim (half-extent 10)
// so the raised layer never leaves a floating cliff at the border.
float groundHeightAt(vec2 worldXZ) {
  vec2 p = worldXZ * uMoundScale + uSeed;
  float base  = fbm(p) * 0.5 + 0.5;                       // 0..1 broad mounds
  float drift = fbm(worldXZ * uBumpScale + uSeed * 0.5) * 0.5 + 0.5;
  float h = base * (1.0 - 0.4 * uBumpStrength + 0.4 * uBumpStrength * drift);
  vec2 edge = smoothstep(10.0, 8.0, abs(worldXZ));
  return uMoundDepth * h * edge.x * edge.y;
}
`;

// Soil-only shading uniforms + the normal-shading helper (fragment stage).
const SOIL_SHADE_FUNCTIONS = /* glsl */ `
uniform vec3  uSoilColor;
uniform float uVarScale;
uniform float uVarAmount;
uniform float uMoisture;
uniform float uMoistScale;
uniform float uMoistEdge;
uniform vec2  uMoistSeed;
uniform float uWetDarken;
uniform float uWetRoughness;
uniform float uCrackAmount;
uniform float uCrackScale;
uniform float uReliefShading;
uniform float uTime;

// Analytic surface normal of the displaced ground (for shading the slopes).
vec3 groundSurfaceNormal(vec2 worldXZ) {
  float e = 0.08;
  float h0 = groundHeightAt(worldXZ);
  float hx = groundHeightAt(worldXZ + vec2(e, 0.0));
  float hz = groundHeightAt(worldXZ + vec2(0.0, e));
  vec2 grad = vec2(hx - h0, hz - h0) / e;
  return normalize(vec3(-grad.x, 1.0, -grad.y));
}
`;

const SOIL_INJECT = NOISE_FUNCTIONS + HEIGHT_FUNCTIONS + SOIL_SHADE_FUNCTIONS;

material.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, soilUniforms);

  // Vertex: inject the field, then raise the ground geometry by it.
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nvarying vec3 vWorldPosition;\n' + SOIL_INJECT
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vec2 groundXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
      transformed += normalize(objectNormal) * groundHeightAt(groundXZ);
      vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      '#include <common>\nvarying vec3 vWorldPosition;\n' + SOIL_INJECT
    )
    // Albedo: large-scale tone variation, overall tint, wet patches and cracks.
    .replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      vec2 sXZ = vWorldPosition.xz;

      // Broad dry/rich tone variation so the ground isn't a flat fill.
      float tone = fbm(sXZ * uVarScale + uSeed * 0.3) * 0.5 + 0.5;
      diffuseColor.rgb *= mix(1.0 - uVarAmount, 1.0 + uVarAmount, tone);
      diffuseColor.rgb *= uSoilColor;

      // Moisture: damp patches darken the soil (used again in the rough stage).
      // Coverage maps 0 -> dry everywhere, 1 -> damp everywhere (full coverage).
      float wn  = fbm(sXZ * uMoistScale + uMoistSeed) * 0.5 + 0.5;
      float wThresh = mix(1.0 + uMoistEdge, -uMoistEdge, uMoisture);
      float wet = smoothstep(wThresh - uMoistEdge, wThresh + uMoistEdge, wn);
      diffuseColor.rgb *= mix(1.0, uWetDarken, wet);

      // Dry cracks: dark fissures where the noise crosses zero.
      float cr = abs(fbm(sXZ * uCrackScale + 11.0));
      float cracks = (1.0 - smoothstep(0.0, 0.04, cr)) * uCrackAmount;
      diffuseColor.rgb *= (1.0 - 0.55 * cracks);`
    )
    // Wet soil is glossier; cracks read dull and matte.
    .replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
      roughnessFactor = mix(roughnessFactor, uWetRoughness, wet);
      roughnessFactor = mix(roughnessFactor, 1.0, cracks);`
    )
    // Shade with the normal of the displaced mounds where the ground rises.
    .replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
      vec3 gN = groundSurfaceNormal(vWorldPosition.xz);
      vec3 gView = normalize((viewMatrix * vec4(gN, 0.0)).xyz);
      normal = normalize(mix(normal, gView, uReliefShading));`
    );
};
// Distinct cache key so this program isn't shared with a plain StandardMaterial.
material.customProgramCacheKey = () => 'soil-v1';

/* -------------------------------------------------------------------------- */
/*  Ground plane                                                               */
/* -------------------------------------------------------------------------- */
// Segments give the displacement field something to push around.
const geometry = new THREE.PlaneGeometry(20, 20, 256, 256);
geometry.setAttribute('uv1', geometry.attributes.uv); // aoMap reads UV set 2

const plane = new THREE.Mesh(geometry, material);
plane.rotation.x = -Math.PI / 2;
plane.receiveShadow = true;
plane.castShadow = true;
scene.add(plane);

/* -------------------------------------------------------------------------- */
/*  Wind field (shared by the grass; world-space gust direction & speed)       */
/* -------------------------------------------------------------------------- */
const windUniforms = {
  uWindDir: { value: new THREE.Vector2(1, 0.35).normalize() },
  uWindStrength: { value: 0.5 }, // how far the gust leans the blades
  uWindSpeed: { value: 1.8 }, // travel speed of the gust front
  uWindScale: { value: 0.35 }, // spatial frequency of the gust field
  uGust: { value: 0.6 }, // fine per-blade flutter amount
};
const windState = { strength: 0.5, speed: 1.8, scale: 0.35, gust: 0.6, direction: 20 };
function applyWind() {
  const a = THREE.MathUtils.degToRad(windState.direction);
  windUniforms.uWindDir.value.set(Math.cos(a), Math.sin(a)); // already unit-length
  windUniforms.uWindStrength.value = windState.strength;
  windUniforms.uWindSpeed.value = windState.speed;
  windUniforms.uWindScale.value = windState.scale;
  windUniforms.uGust.value = windState.gust;
}
applyWind();

/* -------------------------------------------------------------------------- */
/*  Grass — GPU-instanced, wind-reactive, curlable, glued to the terrain       */
/* -------------------------------------------------------------------------- */
const grass = createGrass({
  sharedUniforms: shared,
  soilUniforms, // shares the terrain height field (blades follow the mounds)
  windUniforms,
  noiseGLSL: NOISE_FUNCTIONS,
  heightGLSL: HEIGHT_FUNCTIONS,
  sunLight: keyLight,
  area: 19,
});
scene.add(grass.mesh);

/* -------------------------------------------------------------------------- */
/*  Cinematic post-processing & camera                                         */
/* -------------------------------------------------------------------------- */
const fx = createPostFX({ renderer, scene, camera });

const cine = {
  autoOrbit: true,
  orbitSpeed: 1.0,
  fov: 24,
  letterbox: true,
};
controls.autoRotate = cine.autoOrbit;
controls.autoRotateSpeed = cine.orbitSpeed;
camera.fov = cine.fov;
camera.updateProjectionMatrix();

// Letterbox bars (CSS overlay).
const barTop = document.getElementById('bar-top');
const barBottom = document.getElementById('bar-bottom');
function applyLetterbox() {
  const h = cine.letterbox ? '8vh' : '0';
  barTop.style.height = h;
  barBottom.style.height = h;
}
applyLetterbox();

// --- Focus-plane visualizer (Unreal-style) ---------------------------------
// A translucent grid plane shown at the DoF focus distance while the user drags
// the Focus Distance slider, then it fades out on its own.
const focusPlaneMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  uniforms: {
    uOpacity: { value: 0 },
    uColor: { value: new THREE.Color(0xffc98f) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uOpacity;
    uniform vec3  uColor;
    varying vec2  vUv;
    void main() {
      vec2 grid = abs(fract(vUv * 12.0) - 0.5);
      vec2 d = grid / fwidth(vUv * 12.0);
      float line = 1.0 - clamp(min(d.x, d.y), 0.0, 1.0);
      vec2 c = abs(vUv - 0.5);
      float cross = step(c.x, 0.0015) + step(c.y, 0.0015); // center crosshair
      float a = (line * 0.55 + 0.05 + cross * 0.9) * uOpacity;
      if (a <= 0.001) discard;
      gl_FragColor = vec4(uColor, a);
    }
  `,
});
const focusPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), focusPlaneMat);
focusPlane.frustumCulled = false;
focusPlane.visible = false;
scene.add(focusPlane);

let focusTimer = 0;
const _focusDir = new THREE.Vector3();
function showFocusPlane() {
  focusTimer = 1.2; // seconds visible after the last change
  focusPlane.visible = true;
}
function updateFocusPlane(dt) {
  if (focusTimer <= 0) {
    if (focusPlane.visible) focusPlane.visible = false;
    return;
  }
  focusTimer -= dt;
  const dist = fx.bokeh.uniforms.focus.value;
  camera.getWorldDirection(_focusDir);
  focusPlane.position.copy(camera.position).addScaledVector(_focusDir, dist);
  focusPlane.quaternion.copy(camera.quaternion); // face the camera
  const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dist;
  const halfW = halfH * camera.aspect;
  focusPlane.scale.set(halfW * 2 * 0.92, halfH * 2 * 0.92, 1);
  focusPlaneMat.uniforms.uOpacity.value = 0.9 * Math.min(1, focusTimer / 0.4);
}

/* -------------------------------------------------------------------------- */
/*  GUI controls                                                               */
/* -------------------------------------------------------------------------- */
const params = {
  textureScale: 4, // tiles across the plane
  normalIntensity: 1.0,
  aoIntensity: 1.0,
  roughnessIntensity: 1.0,
  displacementScale: 0.0,
};

function applyTextureScale(scale) {
  for (const map of allMaps) {
    map.repeat.set(scale, scale);
  }
}

// Initial build — textures and tiling.
loadTextures();

const gui = new GUI({ title: '🪨 Soil Studio' });

/* --- Material -------------------------------------------------------------- */
const fMat = gui.addFolder('Material');
fMat
  .add(params, 'textureScale', 0.5, 20, 0.1)
  .name('Texture Scale')
  .onChange(applyTextureScale);
fMat
  .add(params, 'normalIntensity', 0, 3, 0.01)
  .name('Normal Intensity')
  .onChange((v) => material.normalScale.set(v, v));
fMat
  .add(params, 'aoIntensity', 0, 3, 0.01)
  .name('AO Intensity')
  .onChange((v) => (material.aoMapIntensity = v));
fMat
  .add(params, 'roughnessIntensity', 0, 2, 0.01)
  .name('Roughness Intensity')
  .onChange((v) => (material.roughness = v));
fMat
  .add(params, 'displacementScale', 0, 1, 0.001)
  .name('Texture Displacement')
  .onChange((v) => (material.displacementScale = v));
fMat.close();

/* --- Soil shaping & shading ------------------------------------------------ */
const fSoil = gui.addFolder('Soil Surface');

const fShape = fSoil.addFolder('Mounds & Relief');
fShape.add(soilUniforms.uMoundScale, 'value', 0.02, 0.8, 0.001).name('Mound Scale');
fShape.add(soilUniforms.uSeed.value, 'x', -50, 50, 0.1).name('Seed X').listen();
fShape.add(soilUniforms.uSeed.value, 'y', -50, 50, 0.1).name('Seed Y').listen();
fShape
  .add(
    {
      randomize: () =>
        soilUniforms.uSeed.value.set(
          (Math.random() - 0.5) * 100,
          (Math.random() - 0.5) * 100
        ),
    },
    'randomize'
  )
  .name('🎲 Randomize Seed');
fShape.add(soilUniforms.uMoundDepth, 'value', 0, 3, 0.01).name('Mound Height');
fShape.add(soilUniforms.uBumpScale, 'value', 0.1, 3, 0.01).name('Relief Scale');
fShape.add(soilUniforms.uBumpStrength, 'value', 0, 2, 0.01).name('Relief Strength');
fShape.add(soilUniforms.uReliefShading, 'value', 0, 1, 0.01).name('Relief Shading');

const fLook = fSoil.addFolder('Tone & Color');
fLook
  .addColor({ c: '#ffffff' }, 'c')
  .name('Soil Tint')
  .onChange((v) => soilUniforms.uSoilColor.value.set(v));
fLook.add(soilUniforms.uVarAmount, 'value', 0, 1, 0.01).name('Tone Variation');
fLook.add(soilUniforms.uVarScale, 'value', 0.01, 0.5, 0.001).name('Variation Scale');

const fWet = fSoil.addFolder('Moisture');
fWet.add(soilUniforms.uMoisture, 'value', 0, 1, 0.01).name('Coverage');
fWet.add(soilUniforms.uMoistEdge, 'value', 0.001, 0.4, 0.001).name('Patch Softness');
fWet.add(soilUniforms.uMoistScale, 'value', 0.02, 0.8, 0.001).name('Patch Scale');
fWet.add(soilUniforms.uMoistSeed.value, 'x', -50, 50, 0.1).name('Seed X').listen();
fWet.add(soilUniforms.uMoistSeed.value, 'y', -50, 50, 0.1).name('Seed Y').listen();
fWet
  .add(
    {
      randomize: () =>
        soilUniforms.uMoistSeed.value.set(
          (Math.random() - 0.5) * 100,
          (Math.random() - 0.5) * 100
        ),
    },
    'randomize'
  )
  .name('🎲 Randomize Seed');
fWet.add(soilUniforms.uWetDarken, 'value', 0.2, 1, 0.01).name('Wet Darkening');
fWet.add(soilUniforms.uWetRoughness, 'value', 0.05, 1, 0.01).name('Wet Gloss');

const fCrack = fSoil.addFolder('Dry Cracks');
fCrack.add(soilUniforms.uCrackAmount, 'value', 0, 1, 0.01).name('Crack Amount');
fCrack.add(soilUniforms.uCrackScale, 'value', 0.1, 3, 0.01).name('Crack Scale');

fShape.close();
fLook.close();
fWet.close();
fCrack.close();
fSoil.close();

/* --- Grass ----------------------------------------------------------------- */
const grassParams = { enabled: true, density: 0.3 };
const fGrass = gui.addFolder('🌱 Grass');
fGrass
  .add(grassParams, 'enabled')
  .name('Enabled')
  .onChange((v) => (grass.mesh.visible = v));
fGrass
  .add(grassParams, 'density', 0, 1, 0.01)
  .name('Density')
  .onChange((v) => grass.setDensity(v));

const fGrassMask = fGrass.addFolder('Coverage Mask');
fGrassMask.add(grass.uniforms.uCoverage, 'value', 0, 1, 0.01).name('Coverage');
fGrassMask.add(grass.uniforms.uMaskScale, 'value', 0.02, 0.8, 0.001).name('Patch Scale');
fGrassMask.add(grass.uniforms.uMaskEdge, 'value', 0.001, 0.4, 0.001).name('Patch Softness');
fGrassMask.add(grass.uniforms.uMaskSeed.value, 'x', -50, 50, 0.1).name('Seed X').listen();
fGrassMask.add(grass.uniforms.uMaskSeed.value, 'y', -50, 50, 0.1).name('Seed Y').listen();
fGrassMask
  .add(
    {
      randomize: () =>
        grass.uniforms.uMaskSeed.value.set(
          (Math.random() - 0.5) * 100,
          (Math.random() - 0.5) * 100
        ),
    },
    'randomize'
  )
  .name('🎲 Randomize Seed');
fGrassMask.close();

fGrass.add(grass.uniforms.uHeight, 'value', 0.2, 2.5, 0.01).name('Blade Height');
fGrass.add(grass.uniforms.uWidth, 'value', 0.02, 0.25, 0.001).name('Blade Width');
fGrass.add(grass.uniforms.uCurl, 'value', 0, 2.2, 0.01).name('Curl');
fGrass
  .addColor({ c: '#33421b' }, 'c')
  .name('Base Color')
  .onChange((v) => grass.uniforms.uColorBase.value.set(v));
fGrass
  .addColor({ c: '#9bc24a' }, 'c')
  .name('Tip Color')
  .onChange((v) => grass.uniforms.uColorTip.value.set(v));
fGrass.add(grass.uniforms.uColorVarAmt, 'value', 0, 0.6, 0.01).name('Color Variation');
fGrass.add(grass.uniforms.uTranslucency, 'value', 0, 2, 0.01).name('Translucency');
fGrass.add(grass.material, 'roughness', 0, 1, 0.01).name('Roughness');
fGrass.close();

/* --- Wind ------------------------------------------------------------------ */
const fWind = gui.addFolder('🍃 Wind');
fWind.add(windState, 'strength', 0, 2, 0.01).name('Strength').onChange(applyWind);
fWind.add(windState, 'speed', 0, 6, 0.01).name('Speed').onChange(applyWind);
fWind.add(windState, 'direction', 0, 360, 1).name('Direction °').onChange(applyWind);
fWind.add(windState, 'scale', 0.05, 1.5, 0.01).name('Gust Size').onChange(applyWind);
fWind.add(windState, 'gust', 0, 1.5, 0.01).name('Flutter').onChange(applyWind);
fWind.close();

/* --- Lighting -------------------------------------------------------------- */
const fLight = gui.addFolder('Lighting');
fLight.add(renderer, 'toneMappingExposure', 0, 3, 0.01).name('Exposure');
fLight.add(keyLight, 'intensity', 0, 8, 0.01).name('Key');
fLight.add(fillLight, 'intensity', 0, 4, 0.01).name('Fill');
fLight.add(rimLight, 'intensity', 0, 400, 1).name('Rim');
fLight.add(scene, 'environmentIntensity', 0, 2, 0.01).name('Env / IBL');

const fogState = { enabled: true, density: scene.fog.density };
function applyFog() {
  scene.fog.density = fogState.enabled ? fogState.density : 0;
}
fLight.add(fogState, 'enabled').name('Fog').onChange(applyFog);
fLight.add(fogState, 'density', 0, 0.03, 0.0005).name('Fog Density').onChange(applyFog);
fLight.close();

/* --- Cinematic ------------------------------------------------------------- */
const fCine = gui.addFolder('🎬 Cinematic');

// Anti-aliasing: MSAA happens inside the composer (the renderer's own AA is
// bypassed by post-processing). Higher = smoother thin grass, a bit more cost.
const aaParams = { msaa: Math.min(4, fx.maxSamples) };
const aaOptions = { Off: 0, '2×': 2, '4×': 4, '8×': 8 };
fCine
  .add(aaParams, 'msaa', aaOptions)
  .name('Anti-aliasing')
  .onChange((v) => fx.setSamples(Number(v)));

const fCam = fCine.addFolder('Camera');
fCam.add(cine, 'autoOrbit').name('Auto Orbit').onChange((v) => (controls.autoRotate = v));
fCam
  .add(cine, 'orbitSpeed', -3, 3, 0.05)
  .name('Orbit Speed')
  .onChange((v) => (controls.autoRotateSpeed = v));
fCam.add(cine, 'fov', 18, 80, 1).name('Focal / FOV').onChange((v) => {
  camera.fov = v;
  camera.updateProjectionMatrix();
});
fCam.add(cine, 'letterbox').name('Letterbox').onChange(applyLetterbox);

const dofParams = { enabled: false };
fx.bokeh.enabled = dofParams.enabled; // off by default — opt in when framing
const fDof = fCine.addFolder('Depth of Field');
fDof.add(dofParams, 'enabled').name('Enable DoF').onChange((v) => (fx.bokeh.enabled = v));
fDof
  .add(fx.bokeh.uniforms.focus, 'value', 1, 40, 0.1)
  .name('Focus Distance')
  .onChange(showFocusPlane);
fDof.add(fx.bokeh.uniforms.aperture, 'value', 0, 0.004, 0.00005).name('Aperture');
fDof.add(fx.bokeh.uniforms.maxblur, 'value', 0, 0.02, 0.0005).name('Max Blur');

const fFx = fCine.addFolder('Effects');
fFx.add(fx.bloom, 'strength', 0, 2, 0.01).name('Bloom');
fFx.add(fx.bloom, 'radius', 0, 2, 0.01).name('Bloom Radius');
fFx.add(fx.bloom, 'threshold', 0, 1, 0.01).name('Bloom Threshold');
fFx.add(fx.grade.uniforms.uGrain, 'value', 0, 0.25, 0.005).name('Film Grain');
fFx.add(fx.grade.uniforms.uVignette, 'value', 0, 1.5, 0.01).name('Vignette');
fFx.add(fx.grade.uniforms.uChroma, 'value', 0, 0.01, 0.0001).name('Chromatic Aberration');
fFx.add(fx.grade.uniforms.uContrast, 'value', 0.7, 1.6, 0.01).name('Contrast');
fFx.add(fx.grade.uniforms.uSaturation, 'value', 0, 2, 0.01).name('Saturation');
fCine.close();

/* -------------------------------------------------------------------------- */
/*  Resize & render loop                                                       */
/* -------------------------------------------------------------------------- */
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  fx.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1); // clamp after tab-switches
  shared.uTime.value += dt;

  controls.update();
  grass.update(camera.position);
  updateFocusPlane(dt);

  fx.render(dt);
});
