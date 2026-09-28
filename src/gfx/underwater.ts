// Shared "underwater" shader patch for built-in three.js materials.
//
// Adds, via onBeforeCompile:
//  - animated caustic light on up-facing surfaces (world-space, scrolls with the level)
//  - height-tinted exponential fog (brighter toward the surface, darker in the deep)
// All patched materials share one uniforms object, so zone changes update everything.
import * as THREE from 'three';

export const WATER = {
  uFogColor: { value: new THREE.Color(0x1b5a74) },
  uFogDensity: { value: 0.012 },
  uTime: { value: 0 },
  uScroll: { value: 0 },
  uCaustic: { value: 1.0 },
  uCausticColor: { value: new THREE.Color(0.55, 0.9, 1.0) },
};

const COMMON_FRAG = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uTime;
uniform float uScroll;
uniform float uCaustic;
uniform vec3 uCausticColor;
varying vec3 vWPos;

// Tileable water caustic (after "Tileable Water Caustic" by Dave_Hoskins / joltz0r).
float uwCaustic(vec2 p, float t) {
  vec2 q = mod(p * 6.28318, 6.28318) - 250.0;
  vec2 i = q;
  float c = 1.0;
  const float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = q + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(q.x / (sin(i.x + tt) / inten), q.y / (cos(i.y + tt) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  float v = pow(abs(c), 8.0);
  // Clamp: the raw pattern spikes past half-float range and would poison bloom.
  return (isnan(v) || isinf(v)) ? 0.0 : clamp(v, 0.0, 1.0);
}

vec3 uwFog(vec3 col) {
  float fd = length(vWPos - cameraPosition);
  float ff = 1.0 - exp(-uFogDensity * uFogDensity * fd * fd);
  float h = clamp((vWPos.y + 26.0) / 60.0, 0.0, 1.0);
  vec3 fc = uFogColor * mix(0.3, 1.3, h);
  return mix(col, fc, ff);
}
`;

const CAUSTIC_INJECT = /* glsl */ `
#include <lights_fragment_end>
{
  vec3 wN = normalize(inverseTransformDirection(normal, viewMatrix));
  float up = clamp(wN.y * 0.75 + 0.3, 0.0, 1.0);
  vec2 cp = vec2(vWPos.x + uScroll, vWPos.z) * 0.085 + vec2(vWPos.y * 0.02);
  float c = uwCaustic(cp, uTime * 0.45 + 23.0);
  float c2 = uwCaustic(cp * 1.7 + 0.31, uTime * 0.6 + 7.0);
  float depthK = clamp((vWPos.y + 30.0) / 30.0, 0.15, 1.2);
  reflectedLight.directDiffuse += uCausticColor * (c * 0.8 + c2 * 0.45) * up * uCaustic * depthK * diffuseColor.rgb * 1.6;
}
`;

export interface UWOpts {
  caustics?: boolean;
  fog?: boolean;
  /** Extra shader edits applied before the underwater patch (terrain, kelp sway…). */
  extra?: (shader: THREE.WebGLProgramParametersWithUniforms) => void;
  /** Distinguishes programs when `extra` changes the shader. */
  key?: string;
}

export function underwater<T extends THREE.Material>(mat: T, opts: UWOpts = {}): T {
  const caustics = opts.caustics ?? true;
  const fog = opts.fog ?? true;
  mat.userData.uw = opts;
  mat.onBeforeCompile = (shader) => {
    opts.extra?.(shader);
    Object.assign(shader.uniforms, WATER);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform float uTime;\nuniform float uScroll;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvWPos = (mvPosition.xyz - viewMatrix[3].xyz) * mat3(viewMatrix);',
      );
    let fs = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + COMMON_FRAG);
    if (caustics && fs.includes('#include <lights_fragment_end>')) {
      fs = fs.replace('#include <lights_fragment_end>', CAUSTIC_INJECT);
    }
    if (fog) {
      fs = fs.replace('#include <fog_fragment>', 'gl_FragColor.rgb = uwFog(gl_FragColor.rgb);');
    }
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => `uw:${caustics ? 1 : 0}${fog ? 1 : 0}:${opts.key ?? ''}`;
  return mat;
}

/** Clone a material and re-apply its underwater patch (clone() drops onBeforeCompile). */
export function cloneUW<T extends THREE.Material>(mat: T): T {
  const c = mat.clone() as T;
  const opts = mat.userData.uw as UWOpts | undefined;
  if (opts) underwater(c, opts);
  return c;
}

/** GLSL for the height fog, for custom ShaderMaterials that want to match. */
export const FOG_GLSL = COMMON_FRAG;
