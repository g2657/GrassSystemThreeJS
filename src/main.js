import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import GUI from 'lil-gui';
import { createPostFX } from './postfx.js';
import { createGrass } from './grass.js';
import { createModelSystem } from './model.js';

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
let SOIL_PREFIX = '/Ground103_1K-JPG_'; // swappable in the GUI (Ground072 ↔ Ground103)
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
  uMoundCoverage: { value: 1.0 }, // how much of the surface is raised
  uMoundEdge: { value: 0.15 }, // mound coverage edge softness
  uBumpScale: { value: 0.7 }, // fine relief frequency
  uBumpStrength: { value: 0.6 }, // how lumpy the surface is
  // --- Albedo / shading ----------------------------------------------------
  uSoilColor: { value: new THREE.Color(0xffffff) }, // overall tint multiplier
  uVarScale: { value: 0.08 }, // tone-variation frequency
  uVarAmount: { value: 0.28 }, // dry/rich tone contrast
  uVarCoverage: { value: 1.0 }, // how much of the ground the variation covers
  uVarEdge: { value: 0.15 }, // variation patch edge softness
  uVarSeed: { value: new THREE.Vector2(2.0, 7.0) }, // pan the tone field
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

/* -------------------------------------------------------------------------- */
/*  Moss cover (same principle as the SnowSystem accumulation)                 */
/* -------------------------------------------------------------------------- */
//  A world-space FBM mask decides where moss has grown over the soil — exactly
//  like the snow "settled" mask, but instead of a flat white blanket it lays a
//  real MOSS TEXTURE (colour, roughness, normal & AO) over the ground and gives
//  it HEIGHT VOLUME: the moss layer is folded into the shared terrain height
//  field, so it lifts the geometry (and the grass that sits on it) into a soft,
//  raised living carpet rather than a painted-on decal.
//
//  The height/relief uniforms below are read by the shared `groundHeightAt`
//  (so the grass follows the moss too); the texture/tint uniforms are read only
//  by the soil fragment shader.
const mossUniforms = {
  // --- Coverage & height volume (folded into groundHeightAt) ---------------
  uMossEnabled: { value: 0.0 }, // master on/off (0 = no moss anywhere); off by default
  uMossScale: { value: 0.14 }, // patch noise frequency (smaller = bigger patches)
  uMossSeed: { value: new THREE.Vector2(4.2, 6.6) }, // pan the moss field
  uMossCoverage: { value: 0.55 }, // 0 = bare soil, 1 = fully mossed
  uMossEdge: { value: 0.14 }, // patch edge softness
  uMossDepth: { value: 0.14 }, // thickness of the moss layer (world units)
  uMossBumpScale: { value: 0.9 }, // moss surface relief frequency
  uMossBumpStrength: { value: 0.7 }, // how lumpy the moss carpet is
  // --- Texture & shading (soil fragment only) ------------------------------
  uMossMap: { value: null },
  uMossRoughnessMap: { value: null },
  uMossNormalMap: { value: null },
  uMossAoMap: { value: null },
  uMossColor: { value: new THREE.Color(0xffffff) }, // tint multiplier
  uMossRoughness: { value: 1.0 }, // scales the sampled moss roughness
  uMossTextureScale: { value: 0.35 }, // moss tiles per world unit
  uMossNormalScale: { value: 1.0 }, // moss normal-map strength
  uMossAoStrength: { value: 1.0 }, // moss ambient-occlusion strength
};

let mossMaps = []; // rebuilt by loadMossTextures()
function loadMossTextures() {
  const make = (suffix) => {
    const tex = loader.load('/Moss002_1K-JPG_' + suffix + '.jpg');
    // Sampled through custom uniforms, so tiling is driven by uMossTextureScale
    // (world-space UVs) rather than the texture's own repeat.
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = maxAnisotropy;
    return tex;
  };
  for (const m of mossMaps) m.dispose();
  mossUniforms.uMossMap.value = make('Color'); // decoded to linear in-shader
  mossUniforms.uMossRoughnessMap.value = make('Roughness');
  mossUniforms.uMossNormalMap.value = make('NormalGL');
  mossUniforms.uMossAoMap.value = make('AmbientOcclusion');
  mossMaps = [
    mossUniforms.uMossMap.value,
    mossUniforms.uMossRoughnessMap.value,
    mossUniforms.uMossNormalMap.value,
    mossUniforms.uMossAoMap.value,
  ];
}

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
uniform float uMoundCoverage;
uniform float uMoundEdge;
uniform float uBumpScale;
uniform float uBumpStrength;

// --- Moss height field (same "settled" principle as the snow accumulation) ---
uniform float uMossEnabled;
uniform float uMossScale;
uniform vec2  uMossSeed;
uniform float uMossCoverage;
uniform float uMossEdge;
uniform float uMossDepth;
uniform float uMossBumpScale;
uniform float uMossBumpStrength;

// Where moss has grown: a world-space FBM mask, 0 (bare soil) .. 1 (deep moss).
// coverage 0 -> nothing, 1 -> everywhere (soft, randomizable patches).
float mossMaskAt(vec2 worldXZ) {
  if (uMossEnabled < 0.5) return 0.0;                       // master switch (off)
  vec2 p = worldXZ * uMossScale + uMossSeed;
  float n = fbm(p) * 0.5 + 0.5;                            // 0..1
  float threshold = mix(1.0 + uMossEdge, -uMossEdge, uMossCoverage);
  return smoothstep(threshold - uMossEdge, threshold + uMossEdge, n);
}

// Thickness of the moss carpet above the soil, in world units. A base layer
// scaled by the coverage mask plus lumpy drift detail — the same single source
// of truth the snow used: the vertex stage lifts the geometry by it and the
// fragment stage differentiates it for shading, so silhouette and lighting agree.
float mossHeightAt(vec2 worldXZ) {
  float mask = mossMaskAt(worldXZ);
  float drift = fbm(worldXZ * uMossBumpScale + 31.7) * 0.5 + 0.5; // 0..1 lumps
  float h = mask * (1.0 - 0.4 * uMossBumpStrength + 0.4 * uMossBumpStrength * drift);
  vec2 edge = smoothstep(10.0, 8.0, abs(worldXZ));          // taper at the rim
  return uMossDepth * h * edge.x * edge.y;
}

// Height of the soil surface above the flat plane, in world units. Broad mounds
// modulated by finer lumps. A coverage mask (driven by the same noise) flattens
// the low ground first, so lowering coverage leaves only the tallest peaks.
// Tapered to zero near the plane rim (half-extent 10) so the raised layer never
// leaves a floating cliff at the border. The moss carpet is laid on top so the
// ground (and any grass snapped to it) rises through the moss.
float groundHeightAt(vec2 worldXZ) {
  vec2 p = worldXZ * uMoundScale + uSeed;
  float base  = fbm(p) * 0.5 + 0.5;                       // 0..1 broad mounds
  float drift = fbm(worldXZ * uBumpScale + uSeed * 0.5) * 0.5 + 0.5;
  float h = base * (1.0 - 0.4 * uBumpStrength + 0.4 * uBumpStrength * drift);
  float mThresh = mix(1.0 + uMoundEdge, -uMoundEdge, uMoundCoverage);
  h *= smoothstep(mThresh - uMoundEdge, mThresh + uMoundEdge, base);
  vec2 edge = smoothstep(10.0, 8.0, abs(worldXZ));
  return uMoundDepth * h * edge.x * edge.y + mossHeightAt(worldXZ);
}
`;

// Soil-only shading uniforms + the normal-shading helper (fragment stage).
const SOIL_SHADE_FUNCTIONS = /* glsl */ `
uniform vec3  uSoilColor;
uniform float uVarScale;
uniform float uVarAmount;
uniform float uVarCoverage;
uniform float uVarEdge;
uniform vec2  uVarSeed;
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

// Moss shading (albedo/roughness/normal/AO textures + look controls).
uniform sampler2D uMossMap;
uniform sampler2D uMossRoughnessMap;
uniform sampler2D uMossNormalMap;
uniform sampler2D uMossAoMap;
uniform vec3  uMossColor;
uniform float uMossRoughness;
uniform float uMossTextureScale;
uniform float uMossNormalScale;
uniform float uMossAoStrength;

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
  Object.assign(shader.uniforms, soilUniforms, mossUniforms);

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

      // Broad dry/rich tone variation, confined to a randomizable coverage mask
      // (coverage 0 -> flat base, 1 -> variation everywhere).
      float tone = fbm(sXZ * uVarScale + uVarSeed) * 0.5 + 0.5;
      float tMaskN = fbm(sXZ * uVarScale * 0.7 + uVarSeed + 17.0) * 0.5 + 0.5;
      float tThresh = mix(1.0 + uVarEdge, -uVarEdge, uVarCoverage);
      float tMask = smoothstep(tThresh - uVarEdge, tThresh + uVarEdge, tMaskN);
      diffuseColor.rgb *= mix(1.0, mix(1.0 - uVarAmount, 1.0 + uVarAmount, tone), tMask);
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
      diffuseColor.rgb *= (1.0 - 0.55 * cracks);

      // Moss cover: lay the moss albedo (own tiling, tint & AO) over the soil
      // wherever the mask says it has grown. The moss's HEIGHT is added in the
      // vertex stage (groundHeightAt), so this only handles the surface look.
      float mossMask = mossMaskAt(sXZ);
      vec2  mossUv   = sXZ * uMossTextureScale;
      vec3  mossAlb  = pow(texture2D(uMossMap, mossUv).rgb, vec3(2.2)) * uMossColor;
      float mossAo   = mix(1.0, texture2D(uMossAoMap, mossUv).r, uMossAoStrength);
      mossAlb *= mossAo;
      diffuseColor.rgb = mix(diffuseColor.rgb, mossAlb, mossMask);`
    )
    // Wet soil is glossier; cracks read dull and matte; moss carries its own map.
    .replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
      roughnessFactor = mix(roughnessFactor, uWetRoughness, wet);
      roughnessFactor = mix(roughnessFactor, 1.0, cracks);
      float mossRough = texture2D(uMossRoughnessMap, sXZ * uMossTextureScale).g * uMossRoughness;
      roughnessFactor = mix(roughnessFactor, clamp(mossRough, 0.04, 1.0), mossMask);`
    )
    // Moss normal-map detail, then the displaced-mound relief normal on top.
    .replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
      vec3 mossN = texture2D(uMossNormalMap, sXZ * uMossTextureScale).xyz * 2.0 - 1.0;
      mossN.xy *= uMossNormalScale;
      vec3 mossViewN = normalize(tbn * mossN);
      normal = normalize(mix(normal, mossViewN, mossMask));
      vec3 gN = groundSurfaceNormal(vWorldPosition.xz);
      vec3 gView = normalize((viewMatrix * vec4(gN, 0.0)).xyz);
      normal = normalize(mix(normal, gView, uReliefShading));`
    );
};
// Distinct cache key so this program isn't shared with a plain StandardMaterial.
material.customProgramCacheKey = () => 'soil-moss-v1';

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
const GROUND_SIZE = 20; // the 20×20 ground plane; grass + fog box share this
const grass = createGrass({
  sharedUniforms: shared,
  soilUniforms, // shares the terrain height field (blades follow the mounds)
  mossUniforms, // moss height is folded into groundHeightAt (blades ride the moss)
  windUniforms,
  noiseGLSL: NOISE_FUNCTIONS,
  heightGLSL: HEIGHT_FUNCTIONS,
  sunLight: keyLight,
  area: GROUND_SIZE, // match the ground plane so grass reaches the edges
});
grass.mesh.visible = false; // disabled by default (toggle in the Grass folder)
scene.add(grass.mesh);

/* -------------------------------------------------------------------------- */
/*  Model (default GLB + user import) — moss accumulates on its upward faces    */
/* -------------------------------------------------------------------------- */
const MODELS = {
  'Rusty Car': '/old_rusty_car_2.glb',
  'Porsche 911': '/porsche_911.glb',
};
const model = createModelSystem({
  scene,
  sharedUniforms: shared,
  mossUniforms, // shares the moss maps, tint & master enable (mosses when moss is on)
  defaultUrl: MODELS['Rusty Car'],
});

/* -------------------------------------------------------------------------- */
/*  Cinematic post-processing & camera                                         */
/* -------------------------------------------------------------------------- */
const fx = createPostFX({ renderer, scene, camera });
// Point the clouds' in-scattering at the key light.
fx.fog.uniforms.uSunDir.value.copy(keyLight.position).normalize();
fx.fog.uniforms.uSunColor.value.copy(keyLight.color);
// Match the cloud box footprint to the grass/ground (no inset offset).
fx.fog.uniforms.uHalfXZ.value = GROUND_SIZE / 2;

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
  textureScale: 2, // tiles across the plane
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
loadMossTextures();

const gui = new GUI({ title: '🪨 Soil Studio' });

/* --- Material -------------------------------------------------------------- */
const fMat = gui.addFolder('Material');
const groundParams = { material: 'Ground103' };
fMat
  .add(groundParams, 'material', ['Ground072', 'Ground103'])
  .name('Ground Texture')
  .onChange((v) => {
    SOIL_PREFIX = `/${v}_1K-JPG_`;
    loadTextures(); // rebuilds allMaps and re-applies the current texture scale
  });
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
fShape.add(soilUniforms.uMoundCoverage, 'value', 0, 1, 0.01).name('Coverage');
fShape.add(soilUniforms.uMoundEdge, 'value', 0.001, 0.4, 0.001).name('Coverage Softness');
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
fLook.add(soilUniforms.uVarCoverage, 'value', 0, 1, 0.01).name('Coverage');
fLook.add(soilUniforms.uVarEdge, 'value', 0.001, 0.4, 0.001).name('Patch Softness');
fLook.add(soilUniforms.uVarSeed.value, 'x', -50, 50, 0.1).name('Seed X').listen();
fLook.add(soilUniforms.uVarSeed.value, 'y', -50, 50, 0.1).name('Seed Y').listen();
fLook
  .add(
    {
      randomize: () =>
        soilUniforms.uVarSeed.value.set(
          (Math.random() - 0.5) * 100,
          (Math.random() - 0.5) * 100
        ),
    },
    'randomize'
  )
  .name('🎲 Randomize Seed');

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

/* --- Moss cover ------------------------------------------------------------ */
const fMoss = gui.addFolder('🌿 Moss Cover');
const mossParams = { enabled: false }; // disabled by default
fMoss
  .add(mossParams, 'enabled')
  .name('Enabled')
  .onChange((v) => (mossUniforms.uMossEnabled.value = v ? 1.0 : 0.0));

const fMossMask = fMoss.addFolder('Coverage Mask');
fMossMask.add(mossUniforms.uMossCoverage, 'value', 0, 1, 0.01).name('Coverage');
fMossMask.add(mossUniforms.uMossScale, 'value', 0.02, 0.8, 0.001).name('Patch Scale');
fMossMask.add(mossUniforms.uMossEdge, 'value', 0.001, 0.4, 0.001).name('Patch Softness');
fMossMask.add(mossUniforms.uMossSeed.value, 'x', -50, 50, 0.1).name('Seed X').listen();
fMossMask.add(mossUniforms.uMossSeed.value, 'y', -50, 50, 0.1).name('Seed Y').listen();
fMossMask
  .add(
    {
      randomize: () =>
        mossUniforms.uMossSeed.value.set(
          (Math.random() - 0.5) * 100,
          (Math.random() - 0.5) * 100
        ),
    },
    'randomize'
  )
  .name('🎲 Randomize Seed');
fMossMask.close();

const fMossVol = fMoss.addFolder('Height Volume');
fMossVol.add(mossUniforms.uMossDepth, 'value', 0, 1, 0.005).name('Thickness');
fMossVol.add(mossUniforms.uMossBumpScale, 'value', 0.1, 3, 0.01).name('Relief Scale');
fMossVol.add(mossUniforms.uMossBumpStrength, 'value', 0, 2, 0.01).name('Relief Strength');
fMossVol.close();

const fMossLook = fMoss.addFolder('Texture & Shading');
fMossLook.add(mossUniforms.uMossTextureScale, 'value', 0.05, 2, 0.005).name('Texture Scale');
fMossLook
  .addColor({ c: '#ffffff' }, 'c')
  .name('Moss Tint')
  .onChange((v) => mossUniforms.uMossColor.value.set(v));
fMossLook.add(mossUniforms.uMossRoughness, 'value', 0, 2, 0.01).name('Roughness');
fMossLook.add(mossUniforms.uMossNormalScale, 'value', 0, 3, 0.01).name('Normal Intensity');
fMossLook.add(mossUniforms.uMossAoStrength, 'value', 0, 2, 0.01).name('AO Intensity');
fMossLook.close();

fMoss.close();

/* --- Model + moss accumulation --------------------------------------------- */
const fModel = gui.addFolder('🚗 Model');
const modelState = { showModel: false };
fModel
  .add(modelState, 'showModel')
  .name('Load Model')
  .onChange((v) => model.setVisible(v));

const modelSelect = { active: 'Rusty Car' };
fModel
  .add(modelSelect, 'active', Object.keys(MODELS))
  .name('Model')
  .onChange((k) => model.loadModel(MODELS[k]));

const fileInput = document.getElementById('glb-input');
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) model.importFile(file);
  fileInput.value = ''; // allow re-importing the same file
});
fModel.add({ import: () => fileInput.click() }, 'import').name('📂 Import GLB…');

// Transform — every change re-syncs the world->model matrix so the moss stays put.
const modelTransform = { scale: 1, posX: 0, posY: 0, posZ: 0, rotY: 0 };
function applyModelTransform() {
  model.group.scale.setScalar(modelTransform.scale);
  model.group.position.set(modelTransform.posX, modelTransform.posY, modelTransform.posZ);
  model.group.rotation.y = THREE.MathUtils.degToRad(modelTransform.rotY);
  model.refreshMatrix();
}
fModel.add(modelTransform, 'scale', 0.05, 10, 0.01).name('Scale').onChange(applyModelTransform);
fModel.add(modelTransform, 'posX', -10, 10, 0.01).name('Position X').onChange(applyModelTransform);
fModel.add(modelTransform, 'posY', -5, 10, 0.01).name('Position Y').onChange(applyModelTransform);
fModel.add(modelTransform, 'posZ', -10, 10, 0.01).name('Position Z').onChange(applyModelTransform);
fModel.add(modelTransform, 'rotY', 0, 360, 1).name('Rotation Y°').onChange(applyModelTransform);

const fAccum = fModel.addFolder('Moss Accumulation');
// The master on/off lives in the Moss Cover folder (uMossEnabled, shared) — the
// model mosses over exactly when the ground moss is enabled.
fAccum.add(model.moss.uMossCoverage, 'value', 0, 1, 0.01).name('Coverage');
fAccum.add(model.moss.uMossThickness, 'value', 0, 0.3, 0.001).name('Thickness');
fAccum.add(model.moss.uMossScale, 'value', 0.1, 4, 0.01).name('Patch Scale');
fAccum.add(model.moss.uMossEdge, 'value', 0.01, 0.4, 0.005).name('Patch Softness');
fAccum.add(model.moss.uMossSeed.value, 'x', -50, 50, 0.1).name('Seed X').listen();
fAccum.add(model.moss.uMossSeed.value, 'y', -50, 50, 0.1).name('Seed Y').listen();
fAccum
  .add(
    {
      randomize: () =>
        model.moss.uMossSeed.value.set(
          (Math.random() - 0.5) * 100,
          (Math.random() - 0.5) * 100
        ),
    },
    'randomize'
  )
  .name('🎲 Randomize Seed');
fAccum.add(model.moss.uMossFlatThreshold, 'value', 0, 1, 0.01).name('Flatness Cutoff');
fAccum.add(model.moss.uMossTexScale, 'value', 0.2, 8, 0.05).name('Texture Scale');
fAccum.add(model.moss.uMossRoughness, 'value', 0, 2, 0.01).name('Roughness');
fAccum.add(model.moss.uMossAoStrength, 'value', 0, 2, 0.01).name('AO Intensity');
fAccum.add(model.moss.uMossBump, 'value', 0, 1.5, 0.01).name('Relief Strength');
fAccum.add(model.moss.uMossBumpScale, 'value', 0.5, 8, 0.05).name('Relief Scale');
fAccum.close();
fModel.close();

/* --- Grass ----------------------------------------------------------------- */
const grassParams = { enabled: false, density: 0.13 };
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
fLight.add(fogState, 'enabled').name('Atmos Fog').onChange(applyFog);
fLight.add(fogState, 'density', 0, 0.03, 0.0005).name('Atmos Density').onChange(applyFog);
fLight.close();

/* --- Clouds (volumetric) --------------------------------------------------- */
const cloudsParams = { enabled: false, driftDir: 17 };
const fGFog = gui.addFolder('☁️ Clouds');
fGFog.add(cloudsParams, 'enabled').name('Enabled').onChange((v) => fx.fog.setEnabled(v));

const fGShape = fGFog.addFolder('Shape');
fGShape.add(fx.fog.uniforms.uBase, 'value', -3, 20, 0.05).name('Layer Height');
fGShape.add(fx.fog.uniforms.uHeight, 'value', 0.2, 12, 0.1).name('Thickness');
fGShape.add(fx.fog.uniforms.uHeightFalloff, 'value', 0, 1, 0.01).name('Ground Hug');
fGShape.add(fx.fog.uniforms.uDensity, 'value', 0, 8, 0.02).name('Density');
fGShape.add(fx.fog.uniforms.uCoverage, 'value', 0, 1, 0.01).name('Coverage');
fGShape.add(fx.fog.uniforms.uCoverageEdge, 'value', 0.01, 0.5, 0.005).name('Billow Softness');
fGShape.add(fx.fog.uniforms.uNoiseScale, 'value', 0.02, 0.6, 0.005).name('Billow Scale');
fGShape.add(fx.fog.uniforms.uDetail, 'value', 0, 1, 0.01).name('Detail');
fGShape.add(fx.fog.uniforms.uDetailScale, 'value', 1, 12, 0.1).name('Detail Scale');
fGShape.add(fx.fog.uniforms.uEdgeFade, 'value', 0, 6, 0.1).name('Edge Fade');

const fGMove = fGFog.addFolder('Motion');
fGMove.add(fx.fog.uniforms.uWindSpeed, 'value', 0, 1, 0.005).name('Drift Speed');
fGMove
  .add(cloudsParams, 'driftDir', 0, 360, 1)
  .name('Drift Direction °')
  .onChange((v) => {
    const a = THREE.MathUtils.degToRad(v);
    fx.fog.uniforms.uWindDir.value.set(Math.cos(a), Math.sin(a));
  });

const fGLight = fGFog.addFolder('Lighting & Color');
fGLight.add(fx.fog.uniforms.uSunStrength, 'value', 0, 6, 0.02).name('Sun Scatter');
fGLight.add(fx.fog.uniforms.uAniso, 'value', 0, 0.95, 0.01).name('Backlight (HG)');
fGLight.add(fx.fog.uniforms.uAmbient, 'value', 0, 1, 0.01).name('Ambient Fill');
fGLight
  .addColor({ c: '#cdd6dd' }, 'c')
  .name('Body Color')
  .onChange((v) => fx.fog.uniforms.uFogColor.value.set(v));
fGLight
  .addColor({ c: '#ffe9c8' }, 'c')
  .name('Scatter Color')
  .onChange((v) => fx.fog.uniforms.uSunColor.value.set(v));

const fGPerf = fGFog.addFolder('Quality');
const fogRes = { scale: 0.5 };
fGPerf
  .add(fogRes, 'scale', { Full: 1, Half: 0.5, Quarter: 0.25 })
  .name('Resolution')
  .onChange((v) => fx.fog.setScale(Number(v)));
fGPerf.add(fx.fog.uniforms.uSteps, 'value', 8, 96, 1).name('Steps');
fGPerf.add(fx.fog.uniforms.uLightSteps, 'value', 0, 8, 1).name('Light Steps');
fGPerf.add(fx.fog.uniforms.uLightStepSize, 'value', 0.1, 2, 0.05).name('Light Step Size');

fGShape.close();
fGMove.close();
fGLight.close();
fGPerf.close();
fGFog.close();

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
