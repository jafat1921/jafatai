// Product shots for Ad Studio (contract v40 §9): the angles and framing, kept free of three.js so they can be
// tested and imported by the page without the viewer.
import { PAPER } from './turntable'

export type ShotAngle = 'front' | 'left' | 'right' | 'side' | 'top' | 'back'
export type ShotBackground = 'white' | 'paper' | 'transparent'

export interface ShotSpec {
  id: ShotAngle
  label: string
  // degrees: turn round the model from its front (positive is the viewer's left), and height above it
  azimuth: number
  elevation: number
  // ticked in the strip once rendered; the back is rarely what an advert wants
  keep: boolean
}

export const SHOT_ANGLES: ShotSpec[] = [
  { id: 'front', label: 'Front', azimuth: 0, elevation: 8, keep: true },
  { id: 'left', label: 'Three-quarter left', azimuth: 40, elevation: 12, keep: true },
  { id: 'right', label: 'Three-quarter right', azimuth: -40, elevation: 12, keep: true },
  { id: 'side', label: 'Side', azimuth: 90, elevation: 6, keep: true },
  { id: 'top', label: 'From above', azimuth: 25, elevation: 50, keep: true },
  { id: 'back', label: 'Back', azimuth: 180, elevation: 8, keep: false },
]

export const SHOT_SIZE = 2048
export const MAX_SHOTS = 6

export const SHOT_FILL: Record<Exclude<ShotBackground, 'transparent'>, string> = {
  white: '#ffffff',
  paper: PAPER,
}

/** How far back the camera sits so a sphere of `radius` fills the frame with a small margin, every angle alike. */
export function fitDistance(radius: number, fovDeg: number, margin = 1.18): number {
  return (Math.max(radius, 1e-3) / Math.sin((fovDeg * Math.PI) / 360)) * margin
}

/** The camera position for an angle at `dist`, around the origin; `frontZ` is the side the model faces. */
export function shotPosition(spec: Pick<ShotSpec, 'azimuth' | 'elevation'>, dist: number, frontZ: number): [number, number, number] {
  const az = (spec.azimuth * Math.PI) / 180
  const el = (spec.elevation * Math.PI) / 180
  const flat = dist * Math.cos(el)
  // seen from -Z, the viewer's left is +X
  return [-frontZ * flat * Math.sin(az), dist * Math.sin(el), frontZ * flat * Math.cos(az)]
}

export interface Shot {
  angle: ShotAngle
  blob: Blob
}

export interface ShotOpts {
  background: ShotBackground
  // a soft contact shadow under the model; never on a see-through render
  shadow?: boolean
  size?: number
}

/** "<angle>.png": the shots route reads the angle from the file name. */
export const shotFile = (angle: ShotAngle) => `${angle}.png`
