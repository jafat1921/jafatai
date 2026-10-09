import { geometryFor, type Geometry } from './geometry'
import { gradingActive, pointsFor, prepare, toneTexture } from './maths'
import type { DevelopParams } from './types'

// WebGL2 copy of maths.ts → developPixel (+ geometry and Gaussian light points). Spatial steps
// (clarity, sharpening, noise reduction) and the palette come from the server preview. Profiles and
// .cube looks are 3D textures, the same tables the server uses.

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform sampler2D uTone;
uniform sampler3D uProf;
uniform sampler3D uLook;
uniform float uProfAmt;
uniform float uProfN;
uniform float uLookAmt;
uniform float uLookN;
uniform mat3 uGeo;
uniform bool uBypass;
uniform bool uCalibOn;
uniform mat3 uCalib;
uniform vec3 uGains;
uniform bool uToneOn;
uniform float uRefine;
uniform vec3 uHsl[8];
uniform int uPcN;
uniform vec4 uPcA[8];
uniform vec4 uPcB[8];
uniform float uPcC[8];
uniform bool uBw;
uniform float uBwMix[8];
uniform float uVib;
uniform float uSat;
uniform bool uGradeOn;
uniform vec3 uGrade[4];
uniform vec2 uGradeBB;
uniform float uShTint;
uniform float uVig;
uniform vec4 uVigP;
uniform int uVigStyle;
uniform float uAspect;
uniform vec3 uGrain;
uniform float uFrameLong;
uniform vec2 uOut;
uniform vec4 uPts[16];
uniform int uPtCount;

const float HUES[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0, 360.0);

float dec(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
float enc(float l) { return l <= 0.0031308 ? 12.92 * l : 1.055 * pow(l, 1.0 / 2.4) - 0.055; }
vec3 dec3(vec3 c) { return vec3(dec(c.r), dec(c.g), dec(c.b)); }
vec3 enc3(vec3 c) { return vec3(enc(c.r), enc(c.g), enc(c.b)); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float tone(float x, int c) {
  float f = clamp(x, 0.0, 1.0) * 255.0;
  int i = int(floor(f));
  int j = min(255, i + 1);
  float a = texelFetch(uTone, ivec2(i, 0), 0)[c];
  float b = texelFetch(uTone, ivec2(j, 0), 0)[c];
  return mix(a, b, f - float(i));
}

vec3 lut(sampler3D t, float n, vec3 p) {
  return texture(t, (clamp(p, 0.0, 1.0) * (n - 1.0) + 0.5) / n).rgb;
}

vec3 rgb2hsv(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float d = mx - mn;
  float h = 0.0;
  if (d > 1e-9) {
    if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h *= 60.0;
    if (h < 0.0) h += 360.0;
  }
  return vec3(h, mx == 0.0 ? 0.0 : d / mx, mx);
}

vec3 hsv2rgb(vec3 c) {
  float hh = mod(mod(c.x, 360.0) + 360.0, 360.0) / 60.0;
  float ch = c.z * c.y;
  float x = ch * (1.0 - abs(mod(hh, 2.0) - 1.0));
  vec3 r;
  if (hh < 1.0) r = vec3(ch, x, 0.0);
  else if (hh < 2.0) r = vec3(x, ch, 0.0);
  else if (hh < 3.0) r = vec3(0.0, ch, x);
  else if (hh < 4.0) r = vec3(0.0, x, ch);
  else if (hh < 5.0) r = vec3(x, 0.0, ch);
  else r = vec3(ch, 0.0, x);
  return r + (c.z - ch);
}

float hueDist(float h, float c) { float d = mod(abs(h - c), 360.0); return min(d, 360.0 - d); }

float bandValue(float h, float mixv[8]) {
  float x = mod(mod(h, 360.0) + 360.0, 360.0);
  for (int i = 0; i < 8; i++) {
    float lo = HUES[i];
    float hi = HUES[i + 1];
    if (x <= hi) {
      float a = mixv[i];
      float b = mixv[(i + 1) % 8];
      return a + (b - a) * (x - lo) / (hi - lo);
    }
  }
  return mixv[0];
}

vec3 hueRgbLinear(float hue) {
  float h6 = mod(mod(hue, 360.0) + 360.0, 360.0) / 60.0;
  vec3 s = clamp(vec3(abs(h6 - 3.0) - 1.0, 2.0 - abs(h6 - 2.0), 2.0 - abs(h6 - 4.0)), 0.0, 1.0);
  vec3 l = dec3(s);
  return l / luma(l);
}

float hash2(uint x, uint y) {
  uint h = x * 374761393u + y * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return float(h & 0xffffffu) / 16777215.0 * 2.0 - 1.0;
}

float valueNoise(vec2 f) {
  vec2 f0 = floor(f);
  vec2 t = f - f0;
  t = t * t * (3.0 - 2.0 * t);
  uint xi = uint(int(f0.x) & 0xffff);
  uint yi = uint(int(f0.y) & 0xffff);
  float a = hash2(xi, yi);
  float b = hash2(xi + 1u, yi);
  float c = hash2(xi, yi + 1u);
  float d = hash2(xi + 1u, yi + 1u);
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

void main() {
  vec2 st = (uGeo * vec3(vUv, 1.0)).xy;
  if (st.x < 0.0 || st.y < 0.0 || st.x > 1.0 || st.y > 1.0) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 p = texture(uSrc, st).rgb;
  if (uBypass) { outColor = vec4(p, 1.0); return; }

  float stops = 0.0;
  vec2 px = vUv * uOut;
  for (int k = 0; k < 16; k++) {
    if (k >= uPtCount) break;
    vec4 q = uPts[k];
    vec2 d = px - q.xy;
    stops += 1.5 * q.w / 100.0 * exp(-dot(d, d) / (2.0 * q.z * q.z));
  }

  vec3 lin = dec3(p);
  if (uCalibOn) lin = max(uCalib * lin, 0.0);
  lin = clamp(lin * uGains * exp2(stops), 0.0, 1.0);
  p = enc3(lin);
  if (uProfAmt > 0.0) {
    vec3 q = lut(uProf, uProfN, p);
    p = clamp(p + (q - p) * uProfAmt, 0.0, 1.0);
  }
  if (uToneOn) {
    vec3 pre = p;
    p = vec3(tone(p.r, 0), tone(p.g, 1), tone(p.b, 2));
    if (uRefine < 0.999) {
      float ca = max(p.r, max(p.g, p.b)) - min(p.r, min(p.g, p.b));
      float cb = max(pre.r, max(pre.g, pre.b)) - min(pre.r, min(pre.g, pre.b));
      float y = luma(p);
      float k = ca > 1e-5 ? cb / max(ca, 1e-5) : 1.0;
      k = 1.0 + (1.0 - uRefine) * (min(k, 4.0) - 1.0);
      p = clamp(y + (p - y) * k, 0.0, 1.0);
    }
  }

  vec3 hsv = rgb2hsv(p);
  float w = smoothstep(0.02, 0.10, hsv.y);
  float s = hsv.y;
  if (w > 0.0) {
    int i = 0;
    for (int k = 0; k < 8; k++) { if (hsv.x >= HUES[k]) i = k; }
    float t = (hsv.x - HUES[i]) / (HUES[i + 1] - HUES[i]);
    vec3 adj = mix(uHsl[i], uHsl[(i + 1) % 8], t);
    if (adj != vec3(0.0)) {
      hsv.x += w * 30.0 * adj.x;
      hsv.y = clamp(hsv.y * (1.0 + w * adj.y), 0.0, 1.0);
      hsv.z = clamp(hsv.z * (1.0 + 0.5 * w * adj.z), 0.0, 1.0);
      p = hsv2rgb(hsv);
      s = hsv.y;
    }
  }

  bool bwDone = false;
  if (uPcN > 0 || uBw) {
    vec3 c = rgb2hsv(p);
    if (uPcN > 0) {
      for (int k = 0; k < 8; k++) {
        if (k >= uPcN) break;
        vec4 a = uPcA[k];
        vec4 b = uPcB[k];
        float whW = 6.0 + 84.0 * b.z / 100.0;
        float wsW = 0.05 + 0.95 * b.w / 100.0;
        float wvW = 0.05 + 0.95 * uPcC[k] / 100.0;
        float ww = 1.0 - smoothstep(0.5 * whW, whW, hueDist(c.x, a.x));
        ww *= 1.0 - smoothstep(0.5 * wsW, wsW, abs(c.y - a.y));
        ww *= 1.0 - smoothstep(0.5 * wvW, wvW, abs(c.z - a.z));
        ww *= smoothstep(0.02, 0.10, c.y);
        c.x = c.x + ww * 30.0 * a.w / 100.0;
        c.y = clamp(c.y * (1.0 + ww * b.x / 100.0), 0.0, 1.0);
        c.z = clamp(c.z * (1.0 + 0.5 * ww * b.y / 100.0), 0.0, 1.0);
      }
      p = hsv2rgb(c);
      s = c.y;
    }
    if (uBw) {
      vec3 l = dec3(p);
      float g = enc(clamp(luma(l) * (1.0 + c.y * bandValue(c.x, uBwMix) / 100.0 * 0.6), 0.0, 1.0));
      p = vec3(g);
      bwDone = true;
    }
  }

  lin = dec3(p);
  if (!bwDone) {
    float f = (1.0 + 0.6 * uVib * (1.0 - s)) * (1.0 + uSat);
    if (f != 1.0) {
      float y = luma(lin);
      lin = clamp(y + (lin - y) * f, 0.0, 1.0);
    }
  }
  if (uLookAmt > 0.0) {
    vec3 pb = enc3(lin);
    vec3 q = lut(uLook, uLookN, pb);
    lin = dec3(pb + (q - pb) * uLookAmt);
  }
  if (uGradeOn || abs(uShTint) > 0.01) {
    float yp = enc(clamp(luma(lin), 0.0, 1.0));
    if (uGradeOn) {
      float m = 0.5 - 0.25 * uGradeBB.y / 100.0;
      float kk = 1.0 / (0.5 + uGradeBB.x / 100.0);
      float ws = pow(clamp(1.0 - yp / m, 0.0, 1.0), kk);
      float wh = pow(clamp((yp - m) / (1.0 - m), 0.0, 1.0), kk);
      float wm = clamp(1.0 - ws - wh, 0.0, 1.0);
      float zw[4] = float[4](1.0, ws, wm, wh);
      for (int z = 0; z < 4; z++) {
        vec3 g = uGrade[z];
        if (abs(g.y) < 0.01 && abs(g.z) < 0.01) continue;
        if (abs(g.y) > 0.01) lin = lin * (1.0 + (hueRgbLinear(g.x) - 1.0) * (0.6 * g.y / 100.0) * zw[z]);
        if (abs(g.z) > 0.01) lin = lin * exp2(0.5 * g.z / 100.0 * zw[z]);
      }
      lin = clamp(lin, 0.0, 1.0);
    }
    if (abs(uShTint) > 0.01) {
      float k = 0.15 * uShTint / 100.0 * (1.0 - yp) * (1.0 - yp);
      lin = clamp(lin * vec3(1.0 + k, 1.0 - k, 1.0 + k), 0.0, 1.0);
    }
  }
  if (abs(uVig) > 0.005) {
    float yp = enc(clamp(luma(lin), 0.0, 1.0));
    vec2 dd = vUv - 0.5;
    float r = uVigP.y / 100.0;
    if (r > 0.0) {
      vec2 sc = uAspect >= 1.0 ? vec2(1.0 + r * (uAspect - 1.0), 1.0) : vec2(1.0, 1.0 + r * (1.0 / uAspect - 1.0));
      dd = dd * sc / max(sc.x, sc.y);
    }
    float pw = 2.0 + 6.0 * max(0.0, -r);
    float d = pow(pow(abs(dd.x), pw) + pow(abs(dd.y), pw), 1.0 / pw) / 0.75;
    float e0 = 0.1 + 0.8 * uVigP.x / 100.0;
    float e1 = e0 + 0.05 + 0.9 * uVigP.z / 100.0;
    float a = 0.8 * abs(uVig) / 100.0 * smoothstep(e0, e1, d);
    if (uVig >= 0.0) lin = lin + (1.0 - lin) * a;
    else if (uVigStyle == 2) lin = lin * (1.0 - a);
    else {
      if (uVigP.w > 0.0) a *= 1.0 - uVigP.w / 100.0 * smoothstep(0.6, 1.0, yp);
      lin = lin * (1.0 - a);
    }
  }
  vec3 o = enc3(clamp(lin, 0.0, 1.0));
  if (uGrain.x > 0.5) {
    float cell = 1.0 + 3.0 * uGrain.y / 100.0;
    vec2 f = vUv * uFrameLong / cell;
    float n = valueNoise(f);
    float rough = uGrain.z / 100.0;
    if (rough > 0.01) n = n * (1.0 - 0.5 * rough) + 0.5 * rough * valueNoise(f * 2.3 + vec2(17.0, 31.0));
    o = clamp(o + 0.12 * uGrain.x / 100.0 * n, 0.0, 1.0);
  }
  outColor = vec4(o, 1.0);
}`

export interface LutTable {
  size: number
  data: Uint8Array
}

export interface DevelopRenderer {
  canvas: HTMLCanvasElement
  /** `width`×`height` is the full-resolution source the params' crop and points refer to. */
  setSource: (img: TexImageSource, width: number, height: number) => void
  /** Profile / look table for the 3D-texture steps, under the id the params name it by. */
  setLut: (kind: 'profile' | 'look', id: string | null, table: LutTable | null) => void
  /** Which profile / look the renderer holds a table for. */
  lutId: (kind: 'profile' | 'look') => string | null
  /** Draws into the canvas; `before` shows the unedited frame (geometry still applied). */
  render: (params: DevelopParams, opts?: { before?: boolean; maxSide?: number }) => Geometry | null
  readPixels: () => Uint8Array
  dispose: () => void
}

export function hasWebGL2(make: () => HTMLCanvasElement = () => document.createElement('canvas')): boolean {
  try {
    return !!make().getContext('webgl2')
  } catch {
    return false
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader failed')
  return s
}

const BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const
const ZONES = ['global', 'shadows', 'midtones', 'highlights'] as const

/** null when WebGL2 isn't there (or the shader won't build): the page then runs server-only. */
export function createRenderer(canvas: HTMLCanvasElement): DevelopRenderer | null {
  let gl: WebGL2RenderingContext | null
  try {
    gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: false })
  } catch {
    gl = null
  }
  if (!gl) return null
  let prog: WebGLProgram
  try {
    prog = gl.createProgram()!
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link failed')
  } catch (e) {
    console.warn('Photo Studio: WebGL preview unavailable, using the server preview', e)
    return null
  }
  const g = gl
  g.useProgram(prog)
  const buf = g.createBuffer()
  g.bindBuffer(g.ARRAY_BUFFER, buf)
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW)
  const loc = g.getAttribLocation(prog, 'aPos')
  g.enableVertexAttribArray(loc)
  g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0)

  const src = g.createTexture()
  const tone = g.createTexture()
  const luts = { profile: g.createTexture(), look: g.createTexture() }
  const lutSize = { profile: 0, look: 0 }
  const lutIds: Record<'profile' | 'look', string | null> = { profile: null, look: null }
  const u = (n: string) => g.getUniformLocation(prog, n)
  let size = { w: 0, h: 0, texW: 0 }

  // an empty 2×2×2 table keeps the sampler valid before a real one arrives
  const blank = new Uint8Array(8 * 4)
  const upload3d = (kind: 'profile' | 'look', unit: number, t: LutTable | null) => {
    g.activeTexture(unit)
    g.bindTexture(g.TEXTURE_3D, luts[kind])
    g.pixelStorei(g.UNPACK_ALIGNMENT, 1)
    if (t) g.texImage3D(g.TEXTURE_3D, 0, g.RGB8, t.size, t.size, t.size, 0, g.RGB, g.UNSIGNED_BYTE, t.data)
    else g.texImage3D(g.TEXTURE_3D, 0, g.RGBA8, 2, 2, 2, 0, g.RGBA, g.UNSIGNED_BYTE, blank)
    g.texParameteri(g.TEXTURE_3D, g.TEXTURE_MIN_FILTER, g.LINEAR)
    g.texParameteri(g.TEXTURE_3D, g.TEXTURE_MAG_FILTER, g.LINEAR)
    for (const w of [g.TEXTURE_WRAP_S, g.TEXTURE_WRAP_T, g.TEXTURE_WRAP_R]) g.texParameteri(g.TEXTURE_3D, w, g.CLAMP_TO_EDGE)
    lutSize[kind] = t ? t.size : 0
  }
  upload3d('profile', g.TEXTURE2, null)
  upload3d('look', g.TEXTURE3, null)

  return {
    canvas,
    setSource(img, width, height) {
      size = { w: width, h: height, texW: (img as { width: number }).width || width }
      g.activeTexture(g.TEXTURE0)
      g.bindTexture(g.TEXTURE_2D, src)
      g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false)
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, img)
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
    },
    setLut(kind, id, table) {
      upload3d(kind, kind === 'profile' ? g.TEXTURE2 : g.TEXTURE3, table)
      lutIds[kind] = table ? id : null
    },
    lutId: (kind) => lutIds[kind],
    render(params, opts = {}) {
      if (!size.w) return null
      const geo = geometryFor(size.w, size.h, params)
      // never draw bigger than the texture holds, nor than asked
      const k = Math.min(size.texW / size.w, (opts.maxSide ?? Infinity) / Math.max(geo.width, geo.height))
      const w = Math.max(1, Math.round(geo.width * k))
      const h = Math.max(1, Math.round(geo.height * k))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      g.viewport(0, 0, w, h)
      const pp = prepare(params)
      g.activeTexture(g.TEXTURE1)
      g.bindTexture(g.TEXTURE_2D, tone)
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA32F, 256, 1, 0, g.RGBA, g.FLOAT, toneTexture(pp.tables))
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST)
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST)
      g.uniform1i(u('uSrc'), 0)
      g.uniform1i(u('uTone'), 1)
      g.uniform1i(u('uProf'), 2)
      g.uniform1i(u('uLook'), 3)
      const prof = params.profile && params.profile.id === lutIds.profile ? (params.profile.amount ?? 100) / 100 : 0
      g.uniform1f(u('uProfAmt'), prof)
      g.uniform1f(u('uProfN'), lutSize.profile || 2)
      const look = params.lut && params.lut.look_id === lutIds.look ? Math.min(1, (params.lut.amount ?? 100) / 100) : 0
      g.uniform1f(u('uLookAmt'), look)
      g.uniform1f(u('uLookN'), lutSize.look || 2)
      g.uniformMatrix3fv(u('uGeo'), false, geo.matrix)
      g.uniform1i(u('uBypass'), opts.before ? 1 : 0)
      g.uniform1i(u('uCalibOn'), pp.calib ? 1 : 0)
      // row-major in maths.ts; the shader multiplies uCalib * lin
      g.uniformMatrix3fv(u('uCalib'), true, new Float32Array(pp.calib ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]))
      g.uniform3fv(u('uGains'), pp.gains)
      g.uniform1i(u('uToneOn'), pp.tables.master || pp.tables.chans ? 1 : 0)
      g.uniform1f(u('uRefine'), pp.refine)
      g.uniform3fv(u('uHsl'), new Float32Array(pp.table.flat()))
      const pcA = new Float32Array(32)
      const pcB = new Float32Array(32)
      const pcC = new Float32Array(8)
      pp.pointColor.slice(0, 8).forEach((e, i) => {
        pcA.set([e.hue, e.sat, e.val, e.dh ?? 0], i * 4)
        pcB.set([e.ds ?? 0, e.dl ?? 0, e.hueRange ?? 50, e.satRange ?? 50], i * 4)
        pcC[i] = e.lumRange ?? 50
      })
      g.uniform1i(u('uPcN'), Math.min(8, pp.pointColor.length))
      g.uniform4fv(u('uPcA'), pcA)
      g.uniform4fv(u('uPcB'), pcB)
      g.uniform1fv(u('uPcC'), pcC)
      g.uniform1i(u('uBw'), pp.bw ? 1 : 0)
      g.uniform1fv(u('uBwMix'), new Float32Array(BANDS.map((b) => pp.bw?.[b] ?? 0)))
      g.uniform1f(u('uVib'), pp.vib)
      g.uniform1f(u('uSat'), pp.sat)
      g.uniform1i(u('uGradeOn'), pp.grading && gradingActive(pp.grading) ? 1 : 0)
      g.uniform3fv(u('uGrade'), new Float32Array(ZONES.flatMap((z) => [pp.grading?.[z]?.h ?? 0, pp.grading?.[z]?.s ?? 0, pp.grading?.[z]?.l ?? 0])))
      g.uniform2f(u('uGradeBB'), pp.grading?.blending ?? 50, pp.grading?.balance ?? 0)
      g.uniform1f(u('uShTint'), pp.shadowTint)
      g.uniform1f(u('uVig'), pp.vignette)
      g.uniform4f(u('uVigP'), pp.vig.midpoint, pp.vig.roundness, pp.vig.feather, pp.vig.highlights)
      g.uniform1i(u('uVigStyle'), pp.vig.style === 'paint' ? 2 : pp.vig.style === 'color' ? 1 : 0)
      g.uniform1f(u('uAspect'), geo.width / geo.height)
      g.uniform3f(u('uGrain'), pp.grain.amount, pp.grain.size, pp.grain.roughness)
      g.uniform1f(u('uFrameLong'), Math.max(geo.width, geo.height))
      g.uniform2f(u('uOut'), w, h)
      const pts = pointsFor(params.lightPoints, w, h, geo.width, geo.height)
      const flat = new Float32Array(64)
      pts.forEach((p, i) => flat.set([p.x, p.y, Math.max(1, p.f), p.e], i * 4))
      g.uniform4fv(u('uPts'), flat)
      g.uniform1i(u('uPtCount'), pts.length)
      g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
      return geo
    },
    readPixels() {
      const out = new Uint8Array(canvas.width * canvas.height * 4)
      g.readPixels(0, 0, canvas.width, canvas.height, g.RGBA, g.UNSIGNED_BYTE, out)
      return out
    },
    dispose() {
      g.deleteTexture(src)
      g.deleteTexture(tone)
      g.deleteTexture(luts.profile)
      g.deleteTexture(luts.look)
      g.deleteBuffer(buf)
      g.deleteProgram(prog)
    },
  }
}
