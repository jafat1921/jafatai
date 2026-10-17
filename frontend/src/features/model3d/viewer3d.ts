// The three.js half of the 3D viewer. Only ever loaded with import(), so the main bundle stays three-free.
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  type Material,
  Mesh,
  type Object3D,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

export type Lighting = 'studio' | 'soft' | 'sunset'

export interface Viewer {
  load: (url: string) => Promise<void>
  setLighting: (l: Lighting) => void
  setWireframe: (on: boolean) => void
  // radians; arrow keys turn the model by a fixed step
  rotate: (dx: number, dy: number) => void
  zoom: (factor: number) => void
  reset: () => void
  model: () => Object3D | null
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

// warm on purpose: the studio's paper and brass, not a cold grey lab
const RIGS: Record<Lighting, Rig> = {
  studio: { key: [3, 4, 5], keyColour: 0xfff4e2, keyStrength: 1.6, sky: 0xffffff, ground: 0x6b5a44, fill: 0.15, env: 0.5 },
  soft: { key: [0, 6, 2], keyColour: 0xffffff, keyStrength: 0.7, sky: 0xf6efe2, ground: 0xb9a888, fill: 0.45, env: 0.8 },
  sunset: { key: [-5, 1.2, 3], keyColour: 0xffa45c, keyStrength: 2.2, sky: 0xffc89a, ground: 0x3c2a1c, fill: 0.1, env: 0.25 },
}

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
  camera.position.set(0, 0.4, 3)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = !opts.reducedMotion
  controls.dampingFactor = 0.08
  // the wrapper takes the keys (arrow keys turn the model); OrbitControls' own pan keys would fight it
  controls.keys = { LEFT: '', UP: '', RIGHT: '', BOTTOM: '' }

  const hemi = new HemisphereLight()
  const key = new DirectionalLight()
  const fill = new AmbientLight()
  scene.add(hemi, key, fill)

  let root: Object3D | null = null
  let wire = false
  let home = { pos: camera.position.clone(), target: new Vector3() }

  const lighting = (l: Lighting) => {
    const r = RIGS[l]
    key.position.set(...r.key)
    key.color.setHex(r.keyColour)
    key.intensity = r.keyStrength
    hemi.color.setHex(r.sky)
    hemi.groundColor.setHex(r.ground)
    hemi.intensity = 0.5
    fill.intensity = r.fill
    scene.environmentIntensity = r.env
  }
  lighting('studio')

  const eachMaterial = (fn: (m: Material & { wireframe?: boolean }) => void) =>
    root?.traverse((o) => {
      const mesh = o as Mesh
      if (!mesh.isMesh) return
      ;(Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((m) => fn(m as Material & { wireframe?: boolean }))
    })

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
    camera.position.set(dist * 0.35, dist * 0.25, dist)
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
      if (root) scene.remove(root)
      root = gltf.scene
      scene.add(root)
      frameModel(root)
      if (wire) eachMaterial((m) => (m.wireframe = true))
    },
    setLighting: lighting,
    setWireframe(on) {
      wire = on
      eachMaterial((m) => {
        m.wireframe = on
        m.needsUpdate = true
      })
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
    model: () => root,
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
        ;(Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((m) => m.dispose())
      })
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
