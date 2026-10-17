// The three.js half of the 3D viewer. Only ever loaded with import(), so the main bundle stays three-free.
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  Sphere,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { fitDistance, SHOT_FILL, SHOT_SIZE, shotPosition, type Shot, type ShotOpts, type ShotSpec } from './shots'
import { paintBackdrop, recordCanvas, TURNTABLE, type RecordOpts } from './turntable'

export type Lighting = 'studio' | 'soft' | 'sunset'
export type Backdrop = 'plain' | 'checker'
export type Facing = 'front' | 'back'

export interface Viewer {
  load: (url: string) => Promise<void>
  setLighting: (l: Lighting) => void
  setWireframe: (on: boolean) => void
  wireframe: () => boolean
  // a model made facing the other way is turned round once, here, and exported as it is seen
  setFacing: (f: Facing) => void
  // radians; arrow keys turn the model by a fixed step
  rotate: (dx: number, dy: number) => void
  zoom: (factor: number) => void
  reset: () => void
  model: () => Object3D | null
  // one full turn from the front, square, on the chosen backdrop; the current camera and lighting
  turntable: (backdrop: Backdrop, opts?: RecordOpts) => Promise<Blob>
  // the current view, square and see-through, for the Library thumbnail
  snapshot: (size?: number) => Promise<Blob>
  // product shots for Ad Studio: each angle framed alike, under a soft rig of its own, at 2048 square
  shots: (angles: ShotSpec[], opts: ShotOpts) => Promise<Shot[]>
  dispose: () => void
}

interface Rig {
  key: [number, number, number]
  keyColour: number
  keyStrength: number
  sky: number
  ground: number
  fill: number
  env: number
}

// warm on purpose: the studio's paper and brass, not a cold grey lab. Positions are from the viewer's side
const RIGS: Record<Lighting, Rig> = {
  studio: { key: [3, 4, 5], keyColour: 0xfff4e2, keyStrength: 1.6, sky: 0xffffff, ground: 0x6b5a44, fill: 0.15, env: 0.5 },
  soft: { key: [0, 6, 2], keyColour: 0xffffff, keyStrength: 0.7, sky: 0xf6efe2, ground: 0xb9a888, fill: 0.45, env: 0.8 },
  sunset: { key: [-5, 1.2, 3], keyColour: 0xffa45c, keyStrength: 2.2, sky: 0xffc89a, ground: 0x3c2a1c, fill: 0.1, env: 0.25 },
}
// neutral, so the product keeps its own colours; the key follows the camera round (see shots)
const PRODUCT: Rig = { key: [0, 0, 0], keyColour: 0xffffff, keyStrength: 1.1, sky: 0xffffff, ground: 0xd9d3c7, fill: 0.35, env: 0.9 }

// Pixal3D and TRELLIS.2 put the picture's front on -Z, so the camera (and the lights) sit on that side
export const FRONT_Z = -1

/** Where the camera starts for a model this far away: a little above and to one side of its front. */
export function homePosition(dist: number): [number, number, number] {
  return [FRONT_Z * dist * 0.35, dist * 0.25, FRONT_Z * dist]
}

export function lightPosition([x, y, z]: [number, number, number]): [number, number, number] {
  // the rigs were drawn with the viewer on +Z; turn them round with the camera
  return FRONT_Z < 0 ? [-x, y, -z] : [x, y, z]
}

// one flat ink colour: the textures drawn along 700k edges look just like the textured model
const WIRE = new MeshBasicMaterial({ color: 0x3b2f22, wireframe: true, transparent: true, opacity: 0.55 })

export function createViewer(host: HTMLElement, opts: { reducedMotion: boolean }): Viewer {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.setClearColor(new Color(0x000000), 0) // the page draws the backdrop
  host.appendChild(renderer.domElement)
  renderer.domElement.setAttribute('aria-hidden', 'true')

  const scene = new Scene()
  const pmrem = new PMREMGenerator(renderer)
  const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environment = envMap

  const camera = new PerspectiveCamera(35, 1, 0.01, 100)
  camera.position.set(...homePosition(3))
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = !opts.reducedMotion
  controls.dampingFactor = 0.08
  // the wrapper takes the keys (arrow keys turn the model); OrbitControls' own pan keys would fight it
  controls.keys = { LEFT: '', UP: '', RIGHT: '', BOTTOM: '' }

  const hemi = new HemisphereLight()
  const key = new DirectionalLight()
  const fill = new AmbientLight()
  scene.add(hemi, key, fill)

  // turned 180° for "Back"; the model inside keeps the arrow keys' turns, so Reset keeps the facing
  const holder = new Group()
  scene.add(holder)
  let root: Object3D | null = null
  let home = { pos: camera.position.clone(), target: new Vector3() }

  let lit: Lighting = 'studio'
  const rig = (r: Rig) => {
    key.position.set(...lightPosition(r.key))
    key.color.setHex(r.keyColour)
    key.intensity = r.keyStrength
    hemi.color.setHex(r.sky)
    hemi.groundColor.setHex(r.ground)
    hemi.intensity = 0.5
    fill.intensity = r.fill
    scene.environmentIntensity = r.env
  }
  const lighting = (l: Lighting) => {
    lit = l
    rig(RIGS[l])
  }
  lighting('studio')

  const resize = () => {
    const w = host.clientWidth || 1
    const h = host.clientHeight || 1
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
  const tick = () => {
    frame = requestAnimationFrame(tick)
    controls.update()
    renderer.render(scene, camera)
  }
  tick()

  // the page's view pauses while the canvas is drawn square at a fixed size, then comes back as it was
  const square = async <T>(size: number, fn: () => Promise<T>): Promise<T> => {
    cancelAnimationFrame(frame)
    const ratio = renderer.getPixelRatio()
    renderer.setPixelRatio(1)
    renderer.setSize(size, size, false)
    camera.aspect = 1
    camera.updateProjectionMatrix()
    try {
      return await fn()
    } finally {
      renderer.setPixelRatio(ratio)
      resize()
      tick()
    }
  }

  const frameModel = (obj: Object3D) => {
    // centre it on the origin and back the camera off far enough to see all of it
    const box = new Box3().setFromObject(obj)
    const size = box.getSize(new Vector3())
    const centre = box.getCenter(new Vector3())
    obj.position.sub(centre)
    const radius = Math.max(size.x, size.y, size.z) / 2 || 0.5
    const dist = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.9
    camera.near = dist / 100
    camera.far = dist * 100
    camera.position.set(...homePosition(dist))
    camera.updateProjectionMatrix()
    controls.target.set(0, 0, 0)
    controls.minDistance = radius * 0.6
    controls.maxDistance = dist * 6
    controls.update()
    home = { pos: camera.position.clone(), target: controls.target.clone() }
  }

  return {
    async load(url) {
      const gltf = await new GLTFLoader().loadAsync(url)
      if (root) holder.remove(root)
      root = gltf.scene
      // framed before it goes in the turned holder, so the centring is the model's own
      frameModel(root)
      holder.add(root)
    },
    setLighting: lighting,
    setWireframe(on) {
      // an override, not an edit of the model's materials: the downloads keep their textures
      scene.overrideMaterial = on ? WIRE : null
    },
    wireframe: () => scene.overrideMaterial === WIRE,
    setFacing(f) {
      holder.rotation.y = f === 'back' ? Math.PI : 0
    },
    rotate(dx, dy) {
      if (!root) return
      root.rotation.y += dx
      root.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, root.rotation.x + dy))
    },
    zoom(factor) {
      const offset = camera.position.clone().sub(controls.target).multiplyScalar(factor)
      const len = Math.min(controls.maxDistance, Math.max(controls.minDistance, offset.length()))
      camera.position.copy(controls.target).add(offset.setLength(len))
      controls.update()
    },
    reset() {
      camera.position.copy(home.pos)
      controls.target.copy(home.target)
      if (root) root.rotation.set(0, 0, 0)
      controls.update()
    },
    // the exporters bake world matrices, so a "Back" turn goes into the file and a "Front" one adds nothing
    model: () => root,
    turntable(backdrop, opts) {
      const obj = root
      if (!obj) return Promise.reject(new Error('No model to record'))
      const size = TURNTABLE.size
      const out = document.createElement('canvas')
      out.width = out.height = size
      const ctx = out.getContext('2d')
      if (!ctx) return Promise.reject(new Error('No 2D canvas'))
      const was = obj.rotation.y
      return square(size, () =>
        recordCanvas(
          out,
          (share) => {
            // from the front whatever the arrow keys did; the facing and any tilt stay
            obj.rotation.y = share * Math.PI * 2
            renderer.render(scene, camera)
            // read the WebGL canvas straight after drawing it, before the buffer is cleared
            paintBackdrop(ctx, size, backdrop)
            ctx.drawImage(renderer.domElement, 0, 0, size, size)
          },
          opts,
        ).finally(() => {
          obj.rotation.y = was
        }),
      )
    },
    snapshot(size = 1024) {
      return square(
        size,
        () =>
          new Promise<Blob>((resolve, reject) => {
            renderer.render(scene, camera)
            renderer.domElement.toBlob((b) => (b ? resolve(b) : reject(new Error('No snapshot'))), 'image/png')
          }),
      )
    },
    shots(angles, { background, shadow = true, size = SHOT_SIZE }) {
      const obj = root
      if (!obj) return Promise.reject(new Error('No model to photograph'))
      const out = document.createElement('canvas')
      out.width = out.height = size
      const ctx = out.getContext('2d')
      if (!ctx) return Promise.reject(new Error('No 2D canvas'))
      const was = { pos: camera.position.clone(), target: controls.target.clone(), rot: obj.rotation.clone(), near: camera.near, far: camera.far, wire: scene.overrideMaterial }
      return square(size, async () => {
        // the arrow keys' turns and the wireframe are the viewer's, not the product's; the facing stays
        obj.rotation.set(0, 0, 0)
        scene.overrideMaterial = null
        rig(PRODUCT)
        holder.updateMatrixWorld(true)
        const box = new Box3().setFromObject(holder)
        const ball = box.getBoundingSphere(new Sphere())
        // one distance for every angle, so the shots sit together in an ad set
        const dist = fitDistance(ball.radius, camera.fov)
        camera.near = dist / 100
        camera.far = dist * 10
        const floor = shadow && background !== 'transparent' ? contactShadow(box) : null
        if (floor) scene.add(floor)
        try {
          const shots: Shot[] = []
          for (const a of angles) {
            camera.position.set(...shotPosition(a, dist, FRONT_Z)).add(ball.center)
            camera.lookAt(ball.center)
            camera.updateProjectionMatrix()
            key.position.copy(camera.position).add(new Vector3(0, dist * 0.6, 0))
            renderer.render(scene, camera)
            ctx.clearRect(0, 0, size, size)
            if (background !== 'transparent') {
              ctx.fillStyle = SHOT_FILL[background]
              ctx.fillRect(0, 0, size, size)
            }
            ctx.drawImage(renderer.domElement, 0, 0, size, size)
            shots.push({ angle: a.id, blob: await pngOf(out) })
          }
          return shots
        } finally {
          if (floor) {
            scene.remove(floor)
            floor.geometry.dispose()
            floor.material.map?.dispose()
            floor.material.dispose()
          }
          obj.rotation.copy(was.rot)
          scene.overrideMaterial = was.wire
          camera.position.copy(was.pos)
          controls.target.copy(was.target)
          camera.near = was.near
          camera.far = was.far
          lighting(lit)
        }
      })
    },
    dispose() {
      cancelAnimationFrame(frame)
      ro.disconnect()
      controls.dispose()
      envMap.dispose()
      pmrem.dispose()
      root?.traverse((o) => {
        const mesh = o as Mesh
        if (!mesh.isMesh) return
        mesh.geometry?.dispose()
        ;(Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((m: Material) => m.dispose())
      })
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}

const pngOf = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No picture'))), 'image/png'))

/** A soft dark ellipse just under the model: cheaper than shadow maps and kinder on a plain backdrop. */
function contactShadow(box: Box3): Mesh<PlaneGeometry, MeshBasicMaterial> {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  if (g) {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
    grad.addColorStop(0, 'rgba(40, 30, 20, 0.42)')
    grad.addColorStop(0.55, 'rgba(40, 30, 20, 0.16)')
    grad.addColorStop(1, 'rgba(40, 30, 20, 0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 128, 128)
  }
  const size = box.getSize(new Vector3())
  const map = new CanvasTexture(c)
  map.colorSpace = SRGBColorSpace
  const plane = new Mesh(new PlaneGeometry(size.x * 1.5 || 1, size.z * 1.5 || 1), new MeshBasicMaterial({ map, transparent: true, depthWrite: false, toneMapped: false }))
  plane.rotation.x = -Math.PI / 2
  // a hair below the base, so it never flickers through the model's underside
  plane.position.set((box.min.x + box.max.x) / 2, box.min.y - Math.max(size.y, 1e-3) * 0.004, (box.min.z + box.max.z) / 2)
  return plane
}
