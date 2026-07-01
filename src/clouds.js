import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Clouds — a true volumetric raymarch confined to a box over the ground,
 * rendered at reduced resolution and upsampled for performance. Sit the layer
 * low for ground mist, or raise it for floating clouds.
 *
 * Pipeline (only runs while enabled):
 *   1. depth prepass (low-res) -> world position + terrain/grass occlusion
 *   2. raymarch the fog into a low-res HDR buffer (scatter.rgb, transmittance.a)
 *   3. a cheap full-res ShaderPass composites it over the scene
 *
 * Shape: the density is 3D fBm noise carved by a coverage threshold that FALLS
 * OFF WITH HEIGHT — so the noise itself sculpts an organic, rolling top surface
 * (denser near the ground, thinning upward) rather than a flat-capped slab. A
 * light-march gives self-shadowing, a Henyey–Greenstein phase drives the backlit
 * glow, and a detail-erosion octave frays the edges into wispy tendrils.
 */

const GroundFogShader = {
  uniforms: {
    tDepth: { value: null },
    uInvProj: { value: null }, // THREE.Matrix4
    uInvView: { value: null }, // THREE.Matrix4
    uCameraPos: { value: null }, // THREE.Vector3
    uTime: { value: 0 },
    uHalfXZ: { value: 10.0 }, // half-size of the ground plane (X and Z)
    uBase: { value: 10.0 }, // world Y of the box floor (layer height)
    uHeight: { value: 3.2 }, // vertical extent of the box
    uHeightFalloff: { value: 0.8 }, // 0 = fills box, 1 = hugs ground (organic top)
    uDensity: { value: 2.6 }, // optical thickness of the mist
    uCoverage: { value: 0.6 }, // 0 = sparse puffs, 1 = solid bank
    uCoverageEdge: { value: 0.18 }, // billow edge softness
    uNoiseScale: { value: 0.14 }, // billow size (smaller = bigger clouds)
    uDetail: { value: 0.6 }, // detail-erosion strength (wispy tendrils)
    uDetailScale: { value: 4.0 }, // detail noise frequency (higher = finer)
    uEdgeFade: { value: 2.0 }, // soft fade in from the box walls (world units)
    uWindDir: { value: null }, // THREE.Vector2
    uWindSpeed: { value: 0.15 },
    uSteps: { value: 40.0 }, // primary march quality / cost
    uLightSteps: { value: 5.0 }, // self-shadow march quality / cost
    uLightStepSize: { value: 0.5 },
    uAniso: { value: 0.6 }, // HG forward-scatter (backlit glow)
    uAmbient: { value: 0.3 }, // skylight fill inside the mist
    uSunStrength: { value: 2.6 }, // in-scatter brightness
    uFogColor: { value: null }, // THREE.Color (shadowed body)
    uSunColor: { value: null }, // THREE.Color (lit / scattered)
    uSunDir: { value: null }, // THREE.Vector3 (toward the sun)
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDepth;
    uniform mat4 uInvProj, uInvView;
    uniform vec3 uCameraPos, uFogColor, uSunColor, uSunDir;
    uniform vec2 uWindDir;
    uniform float uTime, uHalfXZ, uBase, uHeight, uHeightFalloff, uDensity,
                  uCoverage, uCoverageEdge, uNoiseScale, uDetail, uDetailScale,
                  uEdgeFade, uWindSpeed, uSteps, uLightSteps, uLightStepSize,
                  uAniso, uAmbient, uSunStrength;
    varying vec2 vUv;

    // --- Rotated 3D value-noise fBm (fewer axis-aligned artifacts) ------------
    float hash13(vec3 p) {
      p = fract(p * 0.3183099 + 0.1);
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float vnoise3(vec3 x) {
      vec3 i = floor(x), f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(mix(hash13(i + vec3(0,0,0)), hash13(i + vec3(1,0,0)), f.x),
            mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
        mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
            mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
    }
    float fbm3(vec3 p) {
      float v = 0.0, a = 0.5;
      mat3 m = mat3(0.0, 0.8, 0.6, -0.8, 0.36, -0.48, -0.6, -0.48, 0.64);
      for (int i = 0; i < 5; i++) { v += a * vnoise3(p); p = m * p * 2.02; a *= 0.5; }
      return v;
    }

    // Organic mist density: 3D noise whose coverage thins with height, so the
    // noise sculpts a rolling top surface (not a flat slab).
    float densityAt(vec3 p) {
      // Keep the mist inside the ground-plane box (soft XZ walls).
      vec2 e = min(p.xz + uHalfXZ, uHalfXZ - p.xz);
      float edge = smoothstep(0.0, uEdgeFade, min(e.x, e.y));
      if (edge <= 0.001) return 0.0;

      float yl = (p.y - uBase) / max(uHeight, 1e-3);   // 0 floor .. 1 top
      if (yl <= 0.0 || yl >= 1.0) return 0.0;
      float floorFade = smoothstep(0.0, 0.12, yl);      // soft contact w/ ground
      float ceilFade  = smoothstep(1.0, 0.85, yl);      // soft safety cap on top

      vec3 drift = vec3(uWindDir.x, 0.15, uWindDir.y) * (uTime * uWindSpeed);
      vec3 q = p * uNoiseScale + drift;
      float n = fbm3(q);

      // Coverage shrinks with height -> the 3D noise defines an ORGANIC rolling
      // top (denser near the ground, thinning upward) instead of a capped slab.
      float cov = uCoverage * (1.0 - uHeightFalloff * yl);
      float th = 1.0 - cov;
      float d = smoothstep(th - uCoverageEdge, th + uCoverageEdge, n);

      // Detail erosion: carve the low-density edges into wispy tendrils.
      if (d > 0.001 && uDetail > 0.0) {
        float hi = fbm3(q * uDetailScale + drift * 2.0 + 19.0);
        d = clamp(d - (1.0 - d) * hi * uDetail, 0.0, 1.0);
      }
      return d * edge * floorFade * ceilFade * uDensity;
    }

    float lightTransmit(vec3 p) {
      vec3 L = normalize(uSunDir);
      float dsum = 0.0;
      for (int j = 0; j < 8; j++) {
        if (float(j) >= uLightSteps) break;
        dsum += densityAt(p + L * (float(j) + 0.5) * uLightStepSize);
      }
      return exp(-dsum * uLightStepSize);
    }

    float hg(float cosT, float g) {
      float g2 = g * g;
      return (1.0 - g2) / (12.5663706 * pow(1.0 + g2 - 2.0 * g * cosT, 1.5));
    }

    // Slab ray-box intersection -> (tNear, tFar).
    vec2 intersectBox(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
      vec3 inv = 1.0 / rd;
      vec3 t0 = (bmin - ro) * inv;
      vec3 t1 = (bmax - ro) * inv;
      vec3 tmin = min(t0, t1), tmax = max(t0, t1);
      return vec2(max(max(tmin.x, tmin.y), tmin.z),
                  min(min(tmax.x, tmax.y), tmax.z));
    }

    vec3 worldFromDepth(vec2 uv, float d) {
      vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      vec4 view = uInvProj * clip; view /= view.w;
      return (uInvView * view).xyz;
    }

    void main() {
      float depth = texture2D(tDepth, vUv).x;
      vec3 worldPos = worldFromDepth(vUv, depth);

      vec3 ro = uCameraPos;
      vec3 diff = worldPos - ro;
      float sceneDist = length(diff);
      vec3 rd = diff / max(sceneDist, 1e-4);

      // Clip the ray to the ground-plane box; clamp the far end to the scene.
      vec3 bmin = vec3(-uHalfXZ, uBase, -uHalfXZ);
      vec3 bmax = vec3( uHalfXZ, uBase + uHeight, uHalfXZ);
      vec2 hit = intersectBox(ro, rd, bmin, bmax);
      float tN = max(hit.x, 0.0);
      float tF = min(hit.y, sceneDist);
      if (tF <= tN) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

      float span = tF - tN;
      float stepLen = span / uSteps;
      float cosT = dot(rd, normalize(uSunDir));
      float phase = mix(hg(cosT, uAniso), 0.25, 0.5); // blend toward isotropic

      float dither = hash13(vec3(vUv * 1000.0, fract(uTime)));
      float t = tN + stepLen * dither;
      float transmittance = 1.0;
      vec3 scatter = vec3(0.0);

      for (int i = 0; i < 96; i++) {
        if (float(i) >= uSteps || t > tF) break;
        vec3 p = ro + rd * t;
        float dens = densityAt(p);
        if (dens > 0.001) {
          float lt = lightTransmit(p);
          vec3 lum = uSunColor * (uSunStrength * phase * lt) + uFogColor * uAmbient;
          float st = dens * stepLen;
          float ai = 1.0 - exp(-st); // energy-conserving integration
          scatter += transmittance * ai * lum;
          transmittance *= (1.0 - ai);
          if (transmittance < 0.02) break;
        }
        t += stepLen;
      }

      // (scatter.rgb, transmittance) -> composited full-res elsewhere.
      gl_FragColor = vec4(scatter, transmittance);
    }
  `,
};

// Cheap full-res composite: scene * transmittance + scatter, upsampling the
// low-res fog buffer bilinearly.
const FogCompositeShader = {
  uniforms: { tDiffuse: { value: null }, tFog: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tFog;
    varying vec2 vUv;
    void main() {
      vec4 s = texture2D(tDiffuse, vUv);
      vec4 f = texture2D(tFog, vUv); // rgb = scatter, a = transmittance
      gl_FragColor = vec4(s.rgb * f.a + f.rgb, s.a);
    }
  `,
};

/**
 * @param {object} o
 * @param {THREE.WebGLRenderer} o.renderer
 * @param {THREE.Scene}  o.scene
 * @param {THREE.Camera} o.camera
 * @param {number} [o.scale] initial resolution scale (1 / 0.5 / 0.25)
 */
export function createClouds({ renderer, scene, camera, scale = 0.5 }) {
  let fogScale = scale;
  const fogW = () =>
    Math.max(1, Math.floor(window.innerWidth * renderer.getPixelRatio() * fogScale));
  const fogH = () =>
    Math.max(1, Math.floor(window.innerHeight * renderer.getPixelRatio() * fogScale));

  const depthTexture = new THREE.DepthTexture();
  depthTexture.type = THREE.UnsignedIntType;
  const depthRT = new THREE.WebGLRenderTarget(fogW(), fogH(), {
    depthTexture,
    depthBuffer: true,
  });
  const fogRT = new THREE.WebGLRenderTarget(fogW(), fogH(), {
    type: THREE.HalfFloatType, // scatter is HDR
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });

  const material = new THREE.ShaderMaterial({
    uniforms: GroundFogShader.uniforms,
    vertexShader: GroundFogShader.vertexShader,
    fragmentShader: GroundFogShader.fragmentShader,
  });
  material.uniforms.tDepth.value = depthRT.depthTexture;
  material.uniforms.uInvProj.value = new THREE.Matrix4();
  material.uniforms.uInvView.value = new THREE.Matrix4();
  material.uniforms.uCameraPos.value = new THREE.Vector3();
  material.uniforms.uWindDir.value = new THREE.Vector2(1, 0.3).normalize();
  material.uniforms.uFogColor.value = new THREE.Color(0xcdd6dd);
  material.uniforms.uSunColor.value = new THREE.Color(0xffe9c8);
  material.uniforms.uSunDir.value = new THREE.Vector3(1, 1, 1).normalize();
  const quad = new FullScreenQuad(material);

  const compositePass = new ShaderPass(FogCompositeShader);
  compositePass.enabled = false; // off by default — nothing renders
  compositePass.uniforms.tFog.value = fogRT.texture;

  function resize() {
    depthRT.setSize(fogW(), fogH());
    fogRT.setSize(fogW(), fogH());
  }

  return {
    compositePass,
    material,
    uniforms: material.uniforms,
    get enabled() {
      return compositePass.enabled;
    },
    setEnabled(v) {
      compositePass.enabled = v;
    },
    setScale(s) {
      fogScale = s;
      resize();
    },
    setSize() {
      resize();
    },
    // Depth prepass + low-res raymarch. Call before the composer renders.
    renderVolume(dt) {
      const prev = renderer.getRenderTarget();

      renderer.setRenderTarget(depthRT);
      renderer.render(scene, camera);

      material.uniforms.uTime.value += dt;
      material.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
      material.uniforms.uInvView.value.copy(camera.matrixWorld);
      material.uniforms.uCameraPos.value.copy(camera.position);

      renderer.setRenderTarget(fogRT);
      quad.render(renderer);

      renderer.setRenderTarget(prev);
    },
    dispose() {
      depthRT.dispose();
      fogRT.dispose();
      material.dispose();
      quad.dispose();
    },
  };
}
