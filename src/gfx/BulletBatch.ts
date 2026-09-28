// Instanced glowing billboards for bullets, rebuilt from CPU state each frame.
import * as THREE from 'three';

const VS = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aShape;   // dirX, dirY, width, length
attribute vec4 aColor;   // halo rgb (HDR), style
uniform float uTime;
varying vec2 vUv;
varying vec3 vColor;
varying float vStyle;
varying float vPulse;
void main() {
  vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
  vec4 mv2 = modelViewMatrix * vec4(aPos + vec3(aShape.xy, 0.0), 1.0);
  vec2 d = mv2.xy - mv.xy;
  float l = length(d);
  vec2 dir = l > 1e-5 ? d / l : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  mv.xy += dir * position.x * aShape.w + nrm * position.y * aShape.z;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy * 2.0;
  vColor = aColor.rgb;
  vStyle = aColor.w;
  vPulse = 0.85 + 0.15 * sin(uTime * 18.0 + aPos.x * 3.0 + aPos.y * 5.0);
}`;

const FS = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
varying float vStyle;
varying float vPulse;
void main() {
  float d = length(vUv);
  if (d > 1.0) discard;
  vec3 c;
  if (vStyle < 0.5) {
    // player bolt: tinted hot core along the axis, soft colored sheath
    float across = max(0.0, 1.0 - abs(vUv.y));
    float along = max(0.0, 1.0 - abs(vUv.x));
    float head = smoothstep(-1.0, 0.6, vUv.x);   // brighter toward the front
    float core = pow(across, 10.0) * smoothstep(0.0, 0.45, along) * head;
    float halo = pow(across, 2.2) * pow(along, 0.9);
    c = (vColor * 0.45 + vec3(0.55)) * core * 1.8 + vColor * halo * 0.55;
  } else {
    // enemy orb: white core, colored rim ring and halo
    float core = smoothstep(0.42, 0.18, d);
    float ring = smoothstep(0.2, 0.0, abs(d - 0.5)) * 0.9;
    float halo = pow(max(0.0, 1.0 - d), 2.0);
    c = vec3(1.0, 0.95, 0.95) * core * 2.4 + vColor * (ring + halo * 0.8) * vPulse;
  }
  gl_FragColor = vec4(c, 0.0);
}`;

export class BulletBatch {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private aPos: THREE.InstancedBufferAttribute;
  private aShape: THREE.InstancedBufferAttribute;
  private aColor: THREE.InstancedBufferAttribute;
  private mat: THREE.ShaderMaterial;
  private n = 0;
  private cap: number;

  constructor(capacity: number) {
    this.cap = capacity;
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    const mk = (k: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * k), k);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = mk(3);
    this.aShape = mk(4);
    this.aColor = mk(4);
    this.geo.setAttribute('aPos', this.aPos);
    this.geo.setAttribute('aShape', this.aShape);
    this.geo.setAttribute('aColor', this.aColor);
    this.geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
  }

  begin(time: number) {
    this.n = 0;
    this.mat.uniforms.uTime.value = time;
  }

  push(x: number, y: number, z: number, dx: number, dy: number, width: number, length: number, color: THREE.Color, style: number) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.aPos.setXYZ(i, x, y, z);
    this.aShape.setXYZW(i, dx, dy, width, length);
    this.aColor.setXYZW(i, color.r, color.g, color.b, style);
  }

  end() {
    this.geo.instanceCount = this.n;
    for (const a of [this.aPos, this.aShape, this.aColor]) {
      a.clearUpdateRanges();
      if (this.n > 0) a.addUpdateRange(0, this.n * a.itemSize);
      a.needsUpdate = true;
    }
  }
}
