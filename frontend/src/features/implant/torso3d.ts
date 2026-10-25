// The three.js half of Implant Preview's body model. Only ever loaded with import(), like model3d/viewer3d.
// A dress-form torso in centimetres, built from her measurements: no face, no arms, no photo of anyone.
import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export interface Breast {
  // base radius and forward projection, cm
  radius: number
  projection: number
  // a lift raises the breast on the chest
  lift?: number
}

export interface TorsoShape {
  chestWidth: number
  // sternal notch to nipple, cm
  snn: number
  left: Breast
  right: Breast
}

export interface TorsoState {
  before: TorsoShape
  after: TorsoShape | null
  mode: 'before' | 'after' | 'both'
  skin: string
  markers: boolean
}

export interface Torso {
  set: (s: TorsoState) => void
  rotate: (dx: number) => void
  reset: () => void
  dispose: () => void
}

const HEIGHT = 48
const NOTCH_Y = 44
const SEG_U = 180
const SEG_V = 140

// half-width / half-depth of the form at heights from the waist up, for a 32 cm chest
const PROFILE: [number, number, number][] = [
  [0, 13, 9],
  [12, 13.5, 9.4],
  [20, 14.6, 10],
  [28, 16, 10.4],
  [36, 17.5, 9.6],
  [40, 19.5, 8.6],
  [43, 15, 7.4],
  [45.5, 7, 6.2],
  [48, 6, 5.8],
]

function profileAt(y: number): [number, number] {
  for (let i = 1; i < PROFILE.length; i++) {
    const [y1, a1, b1] = PROFILE[i]
    const [y0, a0, b0] = PROFILE[i - 1]
    if (y <= y1) {
      const t = (y - y0) / (y1 - y0)
      const s = t * t * (3 - 2 * t)
      return [a0 + (a1 - a0) * s, b0 + (b1 - b0) * s]
    }
  }
  return [PROFILE[PROFILE.length - 1][1], PROFILE[PROFILE.length - 1][2]]
}

/** Where each nipple sits on the form: the patient's left is on the viewer's right (+x). */
export function apexes(shape: TorsoShape) {
  const k = shape.chestWidth / 32
  return (['left', 'right'] as const).map((side) => {
    const b = shape[side]
    const x = (side === 'left' ? 1 : -1) * 9.6 * k
    const y = NOTCH_Y - shape.snn * 0.92 + (b.lift ?? 0)
    return { side, x, y, b }
  })
}

function bump(x: number, y: number, cx: number, cy: number, b: Breast) {
  // blends into the chest over a little more than the base, so there's no step at the edge
  const r = b.radius * 1.3
  const nx = (x - cx) / r
  const up = y > cy
  // a long, gentle upper pole; a rounder lower pole that ends in the fold
  const ny = (y - cy) / r / (up ? 1.35 : 0.9)
  const d2 = nx * nx + ny * ny
  if (d2 >= 1) return 0
  // one exponent above and below: two different ones disagreed along the apex row and left a ledge there
  return b.projection * Math.pow(1 - d2, 1.6)
}

export function buildGeometry(shape: TorsoShape) {
  const k = shape.chestWidth / 32
  const tips = apexes(shape)
  const pos = new Float32Array((SEG_U + 1) * (SEG_V + 1) * 3)
  let n = 0
  for (let j = 0; j <= SEG_V; j++) {
    const y = (j / SEG_V) * HEIGHT
    const [a, bDepth] = profileAt(y)
    for (let i = 0; i <= SEG_U; i++) {
      const u = (i / SEG_U) * Math.PI * 2
      let x = a * k * Math.cos(u)
      let z = bDepth * Math.sin(u)
      // the breasts grow out of the front, fading to nothing round the sides; a hard cut at the side left a lip
      const front = Math.min(1, Math.max(0, Math.sin(u) / 0.45))
      if (front > 0) {
        let out = 0
        for (const t of tips) out += bump(x, y, t.x, t.y, t.b)
        out *= front * front * (3 - 2 * front)
        const len = Math.hypot(x / (a * k), z / bDepth) || 1
        x += ((x / (a * k)) / len) * out * 0.25
        z += out
      }
      pos[n++] = x
      pos[n++] = y - HEIGHT / 2
      pos[n++] = z
    }
  }
  const index: number[] = []
  for (let j = 0; j < SEG_V; j++) {
    for (let i = 0; i < SEG_U; i++) {
      const a = j * (SEG_U + 1) + i
      const b = a + SEG_U + 1
      index.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setIndex(index)
  g.computeVertexNormals()
  return g
}

function form(shape: TorsoShape, skin: string, markers: boolean) {
  const group = new Group()
  const mat = new MeshStandardMaterial({ color: new Color(skin), roughness: 0.62, metalness: 0 })
  group.add(new Mesh(buildGeometry(shape), mat))
  // close the waist and the neck like a dress form
  const k = shape.chestWidth / 32
  for (const [y, a, b] of [PROFILE[0], PROFILE[PROFILE.length - 1]]) {
    const cap = new Mesh(new CircleGeometry(1, 48), mat)
    cap.scale.set(a * k, b, 1)
    cap.rotation.x = y === 0 ? Math.PI / 2 : -Math.PI / 2
    cap.position.y = y - HEIGHT / 2
    group.add(cap)
  }
  if (markers) {
    const ring = new MeshStandardMaterial({ color: new Color(skin).multiplyScalar(0.62), roughness: 0.7 })
    for (const t of apexes(shape)) {
      const [a, depth] = profileAt(t.y)
      const z = depth * Math.sqrt(Math.max(0, 1 - (t.x / (a * k)) ** 2)) + t.b.projection
      const m = new Mesh(new TorusGeometry(1.1, 0.16, 8, 32), ring)
      m.position.set(t.x, t.y - HEIGHT / 2, z + 0.05)
      group.add(m)
    }
  }
  return group
}

function free(g: Group) {
  g.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose()
      ;(o.material as MeshStandardMaterial).dispose()
    }
  })
}

export function createTorso(host: HTMLElement, opts: { reducedMotion: boolean }): Torso {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  host.appendChild(renderer.domElement)
  renderer.domElement.style.display = 'block'

  const scene = new Scene()
  scene.add(new HemisphereLight(0xfff6ea, 0x3b2a1d, 1.1))
  const key = new DirectionalLight(0xffffff, 1.6)
  key.position.set(40, 60, 90)
  scene.add(key)
  const rim = new DirectionalLight(0xffe2b8, 0.7)
  rim.position.set(-70, 30, -40)
  scene.add(rim)

  const camera = new PerspectiveCamera(32, 1, 1, 2000)
  const home = new Vector3(0, 6, 122)
  camera.position.copy(home)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enablePan = false
  controls.enableDamping = !opts.reducedMotion
  controls.minDistance = 70
  controls.maxDistance = 260
  controls.target.set(0, 2, 0)

  let shown: Group[] = []
  const resize = () => {
    const w = host.clientWidth || 480
    const h = host.clientHeight || 360
    renderer.setSize(w, h, false)
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  const ro = new ResizeObserver(resize)
  ro.observe(host)
  resize()

  let frame = 0
  const loop = () => {
    frame = requestAnimationFrame(loop)
    controls.update()
    renderer.render(scene, camera)
  }
  loop()

  return {
    set(s) {
      shown.forEach((g) => {
        scene.remove(g)
        free(g)
      })
      const pair = s.mode === 'both' && s.after
      const list = pair ? [s.before, s.after!] : [s.mode === 'after' && s.after ? s.after : s.before]
      shown = list.map((shape, i) => {
        const g = form(shape, s.skin, s.markers)
        if (pair) g.position.x = i === 0 ? -26 : 26
        scene.add(g)
        return g
      })
      // two forms side by side need the camera further back
      home.set(0, 6, pair ? 172 : 122)
      camera.position.copy(home)
      controls.update()
    },
    rotate(dx) {
      const off = camera.position.clone().sub(controls.target)
      off.applyAxisAngle(new Vector3(0, 1, 0), dx)
      camera.position.copy(controls.target).add(off)
      controls.update()
    },
    reset() {
      camera.position.copy(home)
      controls.target.set(0, 2, 0)
      controls.update()
    },
    dispose() {
      cancelAnimationFrame(frame)
      ro.disconnect()
      controls.dispose()
      shown.forEach(free)
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
