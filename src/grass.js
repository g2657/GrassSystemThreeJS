import * as THREE from 'three';

/**
 * High-quality, high-performance instanced grass.
 *
 * One InstancedBufferGeometry → ONE draw call for the whole field. Every blade
 * is animated entirely on the GPU in the vertex shader:
 *   • placement, yaw, height/width and phase come from per-instance attributes
 *   • the base of each blade is glued to the terrain via the SAME height field
 *     the soil uses (passed in as `heightGLSL`), so grass follows the mounds live
 *   • a resting CURL arcs each blade over (circular-arc model, exact normals)
 *   • WIND adds a coherent world-space gust (shared flow field) plus a fine
 *     per-blade flutter, leaning the blades along the wind direction
 *
 * Lighting/shadows/fog come from MeshStandardMaterial (patched via
 * onBeforeCompile), so the grass matches the rest of the scene. Quality is
 * scaled purely by `instanceCount` — drop the density slider for more FPS.
 *
 * @param {object} o
 * @param {object} o.sharedUniforms  { uTime }
 * @param {object} o.soilUniforms    soil shaping uniforms (by reference)
 * @param {object} o.mossUniforms    moss uniforms (by reference; height folds into groundHeightAt)
 * @param {object} o.windUniforms    wind uniforms (by reference)
 * @param {string} o.noiseGLSL       NOISE_FUNCTIONS chunk (snoise + fbm)
 * @param {string} o.heightGLSL      HEIGHT_FUNCTIONS chunk (groundHeightAt)
 * @param {THREE.Light} o.sunLight   key light (for blade translucency)
 * @param {number} [o.maxCount]      blades generated (density caps the live count)
 * @param {number} [o.area]          square side the field is scattered over
 * @param {number} [o.segments]      blade subdivisions (smoothness of the curl)
 */
export function createGrass({
  sharedUniforms,
  soilUniforms,
  mossUniforms,
  windUniforms,
  noiseGLSL,
  heightGLSL,
  sunLight,
  maxCount = 200000,
  area = 19,
  segments = 5,
}) {
  /* -- Blade base geometry: a vertical strip, x∈[-0.5,0.5], y∈[0,1] ---------- */
  const positions = [];
  const normals = [];
  const indices = [];
  for (let j = 0; j <= segments; j++) {
    const t = j / segments;
    positions.push(-0.5, t, 0, 0.5, t, 0);
    normals.push(0, 0, 1, 0, 0, 1); // overwritten in the shader
    if (j < segments) {
      const a = j * 2;
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions, 3)
  );
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);

  /* -- Per-instance attributes ---------------------------------------------- */
  const iPos = new Float32Array(maxCount * 2);
  const iYaw = new Float32Array(maxCount);
  const iHeight = new Float32Array(maxCount);
  const iWidth = new Float32Array(maxCount);
  const iPhase = new Float32Array(maxCount);
  const iCurlVar = new Float32Array(maxCount);
  const iColorVar = new Float32Array(maxCount);

  const half = area * 0.5;
  for (let i = 0; i < maxCount; i++) {
    iPos[i * 2] = (Math.random() - 0.5) * area;
    iPos[i * 2 + 1] = (Math.random() - 0.5) * area;
    iYaw[i] = Math.random() * Math.PI * 2;
    iHeight[i] = 0.7 + Math.random() * 0.6;
    iWidth[i] = 0.8 + Math.random() * 0.5;
    iPhase[i] = Math.random() * Math.PI * 2;
    iCurlVar[i] = 0.6 + Math.random() * 0.8;
    iColorVar[i] = Math.random();
  }
  geometry.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 2));
  geometry.setAttribute('iYaw', new THREE.InstancedBufferAttribute(iYaw, 1));
  geometry.setAttribute('iHeight', new THREE.InstancedBufferAttribute(iHeight, 1));
  geometry.setAttribute('iWidth', new THREE.InstancedBufferAttribute(iWidth, 1));
  geometry.setAttribute('iPhase', new THREE.InstancedBufferAttribute(iPhase, 1));
  geometry.setAttribute('iCurlVar', new THREE.InstancedBufferAttribute(iCurlVar, 1));
  geometry.setAttribute('iColorVar', new THREE.InstancedBufferAttribute(iColorVar, 1));
  geometry.instanceCount = Math.floor(maxCount * 0.13);
  // The blades are placed in world space inside the shader; give a generous
  // bounding sphere so the field is never frustum-culled away.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), area);

  /* -- Look / animation uniforms -------------------------------------------- */
  const uniforms = {
    uTime: sharedUniforms.uTime,
    // --- Coverage mask (where grass grows) ----------------------------------
    uCoverage: { value: 0.62 }, // 0 = bare, 1 = fully grassed
    uMaskScale: { value: 0.15 }, // patch noise frequency (smaller = bigger patches)
    uMaskEdge: { value: 0.251 }, // patch edge softness
    uMaskSeed: { value: new THREE.Vector2(3.7, 9.1) }, // pan the patch field
    // --- Blade look ----------------------------------------------------------
    uCurl: { value: 1.14 }, // resting tip bend (radians)
    uHeight: { value: 1.5 }, // blade length (world units)
    uWidth: { value: 0.049 }, // blade width (world units)
    uColorBase: { value: new THREE.Color(0x33421b) }, // shaded base
    uColorTip: { value: new THREE.Color(0x9bc24a) }, // sunlit tip
    uColorVarAmt: { value: 0.47 }, // per-blade brightness scatter
    uTranslucency: { value: 0.61 }, // backlight glow through the blade
    uSunDir: { value: new THREE.Vector3(1, 1, 1).normalize() },
    uCameraPos: { value: new THREE.Vector3() },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.47,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });

  material.onBeforeCompile = (shader) => {
    // moss height uniforms are referenced by the shared groundHeightAt (via
    // heightGLSL), so bind them too or the blades won't follow the moss layer.
    Object.assign(shader.uniforms, uniforms, soilUniforms, mossUniforms, windUniforms);

    /* ---- Vertex: instancing + terrain snap + curl + wind ----------------- */
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        attribute vec2  iPos;
        attribute float iYaw;
        attribute float iHeight;
        attribute float iWidth;
        attribute float iPhase;
        attribute float iCurlVar;
        attribute float iColorVar;

        uniform float uCoverage;
        uniform float uMaskScale;
        uniform float uMaskEdge;
        uniform vec2  uMaskSeed;
        uniform float uCurl;
        uniform float uHeight;
        uniform float uWidth;
        uniform vec2  uWindDir;
        uniform float uWindStrength;
        uniform float uWindSpeed;
        uniform float uWindScale;
        uniform float uGust;
        uniform float uTime;

        varying float vT;
        varying float vColorVar;
        varying vec3  vGrassWorld;

        // filled by computeBlade(), reused by both the normal and position stages
        vec3 gPos;
        vec3 gNrm;

        ${noiseGLSL}
        ${heightGLSL}

        // Coverage mask: a world-space noise field decides where grass grows.
        // coverage 0 -> nothing, 1 -> everything (soft, randomizable patches).
        float grassMaskAt(vec2 worldXZ) {
          vec2 p = worldXZ * uMaskScale + uMaskSeed;
          float n = fbm(p) * 0.5 + 0.5;                 // -> 0..1
          float threshold = mix(1.0 + uMaskEdge, -uMaskEdge, uCoverage);
          return smoothstep(threshold - uMaskEdge, threshold + uMaskEdge, n);
        }

        void computeBlade() {
          float t    = position.y;                 // 0 (base) .. 1 (tip)
          float side = position.x;                 // -0.5 .. 0.5

          // Outside the mask the blade collapses (zero height & width -> no area).
          float mask = grassMaskAt(iPos);
          float h = uHeight * iHeight * mask;
          float w = uWidth * iWidth * (1.0 - t) * (0.7 + 0.3 * (1.0 - t)) * mask;

          // Resting curl as a circular arc of total angle A (exact, stable A→0).
          float A = uCurl * iCurlVar;
          float yA, zA, Tc, Ts;
          if (abs(A) > 0.001) {
            yA = h * sin(A * t) / A;
            zA = h * (1.0 - cos(A * t)) / A;
            Tc = cos(A * t); Ts = sin(A * t);
          } else {
            yA = h * t; zA = 0.0; Tc = 1.0; Ts = 0.0;
          }
          vec3 pLocal = vec3(side * w, yA, zA);
          vec3 nLocal = vec3(0.0, -Ts, Tc);        // blade-face normal along arc

          // Yaw the blade around Y by its per-instance heading.
          float cy = cos(iYaw), sy = sin(iYaw);
          vec3 pR = vec3(pLocal.x * cy + pLocal.z * sy, pLocal.y,
                        -pLocal.x * sy + pLocal.z * cy);
          vec3 nR = vec3(nLocal.x * cy + nLocal.z * sy, nLocal.y,
                        -nLocal.x * sy + nLocal.z * cy);

          // Coherent wind: a shared travelling gust + fine per-blade flutter,
          // pushing the blade along the wind direction, strongest at the tip.
          float gph = dot(iPos, uWindDir) * uWindScale + uTime * uWindSpeed + iPhase;
          float gust = sin(gph) * 0.6 + sin(gph * 0.5 + 1.7) * 0.4;
          float flutter = sin(uTime * 8.0 + iPhase * 3.0) * 0.15 * uGust;
          float sway = (gust + flutter) * uWindStrength;
          vec2 windOff = uWindDir * sway * (t * t);

          float gy = groundHeightAt(iPos);          // snap base to the terrain
          gPos = vec3(iPos.x + pR.x + windOff.x,
                      gy + pR.y,
                      iPos.y + pR.z + windOff.y);
          gNrm = normalize(nR);
          vT = t;
          vColorVar = iColorVar;
          vGrassWorld = gPos;
        }
        `
      )
      .replace(
        '#include <beginnormal_vertex>',
        `computeBlade();\n  vec3 objectNormal = gNrm;`
      )
      .replace('#include <begin_vertex>', `vec3 transformed = gPos;`);

    /* ---- Fragment: gradient blades + base AO + backlight translucency ----- */
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform vec3  uColorBase;
        uniform vec3  uColorTip;
        uniform float uColorVarAmt;
        uniform float uTranslucency;
        uniform vec3  uSunDir;
        uniform vec3  uCameraPos;
        varying float vT;
        varying float vColorVar;
        varying vec3  vGrassWorld;
        `
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        vec3 gcol = mix(uColorBase, uColorTip, vT);
        gcol *= mix(1.0 - uColorVarAmt, 1.0 + uColorVarAmt, vColorVar);
        gcol *= mix(0.5, 1.0, smoothstep(0.0, 0.35, vT)); // base occlusion
        diffuseColor.rgb = gcol;
        `
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        vec3 Vd = normalize(uCameraPos - vGrassWorld);
        float back = pow(clamp(dot(-Vd, normalize(uSunDir)), 0.0, 1.0), 2.0);
        totalEmissiveRadiance += uColorTip * back * uTranslucency * vT;
        `
      );
  };
  material.customProgramCacheKey = () => 'grass-v1';

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.castShadow = false; // thin blades: skip the shadow pass for performance
  mesh.receiveShadow = true;

  return {
    mesh,
    material,
    uniforms,
    maxCount,
    setDensity(d) {
      geometry.instanceCount = Math.floor(maxCount * THREE.MathUtils.clamp(d, 0, 1));
    },
    update(cameraPos) {
      uniforms.uCameraPos.value.copy(cameraPos);
      uniforms.uSunDir.value.copy(sunLight.position).normalize();
    },
  };
}
