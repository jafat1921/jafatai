import { geometryFor, type Geometry } from './geometry'
import { pointsFor, prepare, sampleCurve } from './maths'
import type { DevelopParams } from './types'

// WebGL2 copy of maths.ts → developPixel (+ geometry and Gaussian light points). Spatial steps
// (clarity, sharpening, noise reduction), the palette and .cube looks come from the server preview.

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform sampler2D uTone;
uniform mat3 uGeo;
uniform bool uBypass;
uniform vec3 uGains;
uniform vec3 uHsl[8];
uniform float uVib;
uniform float uSat;
uniform float uVig;
uniform vec2 uOut;
uniform vec4 uPts[16];
uniform int uPtCount;

const float HUES[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0, 360.0);

float dec(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
float enc(float l) { return l <= 0.0031308 ? 12.92 * l : 1.055 * pow(l, 1.0 / 2.4) - 0.055; }
vec3 dec3(vec3 c) { return vec3(dec(c.r), dec(c.g), dec(c.b)); }
vec3 enc3(vec3 c) { return vec3(enc(c.r), enc(c.g), enc(c.b)); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float tone(float x) {
  float f = clamp(x, 0.0, 1.0) * 255.0;
  int i = int(floor(f));
  int j = min(255, i + 1);
  float a = texelFetch(uTone, ivec2(i, 0), 0).r;
  float b = texelFetch(uTone, ivec2(j, 0), 0).r;
  return mix(a, b, f - float(i));
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

  vec3 lin = clamp(dec3(p) * uGains * exp2(stops), 0.0, 1.0);
  p = enc3(lin);
  p = vec3(tone(p.r), tone(p.g), tone(p.b));

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

  lin = dec3(p);
  float f = (1.0 + 0.6 * uVib * (1.0 - s)) * (1.0 + uSat);
  if (f != 1.0) {
    float y = luma(lin);
    lin = clamp(y + (lin - y) * f, 0.0, 1.0);
  }

  if (uVig != 0.0) {
    float d = length(vUv - 0.5) / 0.75;
    float a = 0.8 * abs(uVig / 100.0) * smoothstep(0.5, 1.0, d);
    lin = uVig < 0.0 ? lin * (1.0 - a) : lin + (1.0 - lin) * a;
  }
  outColor = vec4(enc3(clamp(lin, 0.0, 1.0)), 1.0);
}`

export interface DevelopRenderer {
  canvas: HTMLCanvasElement
  /** `width`×`height` is the full-resolution source the params' crop and points refer to. */
  setSource: (img: TexImageSource, width: number, height: number) => void
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
  const u = (n: string) => g.getUniformLocation(prog, n)
  let size = { w: 0, h: 0, texW: 0 }

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
      const lut = new Float32Array(256)
      for (let i = 0; i < 256; i++) lut[i] = sampleCurve(pp.tone, i / 255)
      g.texImage2D(g.TEXTURE_2D, 0, g.R32F, 256, 1, 0, g.RED, g.FLOAT, lut)
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST)
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST)
      g.uniform1i(u('uSrc'), 0)
      g.uniform1i(u('uTone'), 1)
      g.uniformMatrix3fv(u('uGeo'), false, geo.matrix)
      g.uniform1i(u('uBypass'), opts.before ? 1 : 0)
      g.uniform3fv(u('uGains'), pp.gains)
      g.uniform3fv(u('uHsl'), new Float32Array(pp.table.flat()))
      g.uniform1f(u('uVib'), pp.vib)
      g.uniform1f(u('uSat'), pp.sat)
      g.uniform1f(u('uVig'), pp.vignette)
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
      g.deleteBuffer(buf)
      g.deleteProgram(prog)
    },
  }
}
