import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createClouds } from './clouds.js';

/**
 * Cinematic post-processing stack:
 *   Render -> Depth of Field -> Bloom -> tone map / sRGB -> Film grade
 *
 * The grade pass runs last (display space) and adds the "shot on film" feel:
 * radial chromatic aberration, contrast/saturation grading, vignette and grain.
 */
const FilmGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.15 },
    uVignetteSize: { value: 0.4 },
    uGrain: { value: 0.0 },
    uChroma: { value: 0.0 },
    uContrast: { value: 1.0 },
    uSaturation: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uVignetteSize, uGrain, uChroma, uContrast, uSaturation;
    varying vec2 vUv;

    float rand(vec2 co) {
      return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 dir = vUv - 0.5;

      // Radial chromatic aberration — stronger toward the frame edges.
      float ca = uChroma * dot(dir, dir) * 4.0;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv - dir * ca).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv + dir * ca).b;

      // Contrast + saturation grade.
      col = (col - 0.5) * uContrast + 0.5;
      float luma = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(luma), col, uSaturation);

      // Vignette.
      float vig = smoothstep(0.85, uVignetteSize, length(dir));
      col *= 1.0 - vig * uVignette;

      // Animated film grain.
      float g = rand(vUv + fract(uTime)) - 0.5;
      col += g * uGrain;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export function createPostFX({ renderer, scene, camera, samples = 4 }) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const maxSamples = renderer.capabilities.maxSamples; // WebGL2 hardware cap

  // MSAA can only happen INSIDE the composer — the renderer's own `antialias`
  // flag is ignored once we render through render targets. So we give the
  // composer a multisampled float target; `setSamples` rebuilds it on demand.
  function makeRenderTarget(n) {
    const dpr = renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(
      Math.floor(window.innerWidth * dpr),
      Math.floor(window.innerHeight * dpr),
      { type: THREE.HalfFloatType }
    );
    rt.samples = Math.min(n, maxSamples);
    return rt;
  }

  const composer = new EffectComposer(renderer, makeRenderTarget(samples));
  composer.addPass(new RenderPass(scene, camera));

  // Clouds (see clouds.js): a low-res volumetric raymarch composited at full
  // res, right after Render so DoF/bloom/grade all affect it.
  const fog = createClouds({ renderer, scene, camera });
  composer.addPass(fog.compositePass);

  const bokeh = new BokehPass(scene, camera, {
    focus: 9.7,
    aperture: 0.0012,
    maxblur: 0.005,
  });
  composer.addPass(bokeh);

  const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.04, 0.7, 0.62);
  composer.addPass(bloom);

  composer.addPass(new OutputPass()); // tone mapping + sRGB

  const grade = new ShaderPass(FilmGradeShader);
  composer.addPass(grade); // last -> renders to screen, in display space

  function setSize(width, height) {
    composer.setSize(width, height);
    bloom.setSize(width, height);
    fog.setSize();
  }
  setSize(w, h);

  // Swap the composer's ping-pong buffers for ones with a new sample count.
  function setSamples(n) {
    composer.reset(makeRenderTarget(n)); // disposes the old targets for us
    setSize(window.innerWidth, window.innerHeight); // re-sync pass sizes
  }

  return {
    composer,
    bokeh,
    bloom,
    grade,
    fog,
    maxSamples,
    setSize,
    setSamples,
    render(dt) {
      grade.uniforms.uTime.value += dt;
      if (fog.enabled) fog.renderVolume(dt); // low-res raymarch before compositing
      composer.render();
    },
  };
}
