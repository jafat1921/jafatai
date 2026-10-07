// Camera rack vocabulary (contract v8 P2). Ids match backend app/camera.py; the server owns the prompt wording,
// this side only needs labels, chip text and the one-line descriptions. GET /api/camera/presets has the same list.

export type ShotSize = 'ecu' | 'cu' | 'mcu' | 'ms' | 'mls' | 'ls' | 'ews'
export type CameraAngle = 'eye' | 'low' | 'high' | 'overhead' | 'dutch' | 'pov' | 'ots'
export type CameraMotion =
  | 'static'
  | 'push_in'
  | 'pull_out'
  | 'pan_left'
  | 'pan_right'
  | 'tilt_up'
  | 'tilt_down'
  | 'orbit_left'
  | 'orbit_right'
  | 'handheld'
  | 'crane_up'
  | 'crane_down'
  | 'dolly_left'
  | 'dolly_right'
  | 'zoom_in'
  | 'zoom_out'
export type CameraSpeed = 'slow' | 'medium' | 'fast'

export interface CameraSetting {
  size?: ShotSize
  angle?: CameraAngle
  motion?: CameraMotion
  speed?: CameraSpeed
}

export interface CameraPreset<T extends string> {
  id: T
  label: string
  short: string
  description: string
}

const row = <T extends string>(id: T, label: string, short: string, description: string): CameraPreset<T> => ({ id, label, short, description })

export const SHOT_SIZES: CameraPreset<ShotSize>[] = [
  row('ecu', 'Extreme close-up', 'ECU', 'Eyes, lips or a detail fill the frame.'),
  row('cu', 'Close-up', 'CU', 'The face fills the frame.'),
  row('mcu', 'Medium close-up', 'MCU', 'Head and shoulders.'),
  row('ms', 'Medium shot', 'MS', 'From the waist up.'),
  row('mls', 'Medium long shot', 'MLS', 'From the knees up.'),
  row('ls', 'Wide', 'Wide', 'The whole body with room around it.'),
  row('ews', 'Extreme wide', 'EWS', 'A tiny figure in a big landscape.'),
]

export const ANGLES: CameraPreset<CameraAngle>[] = [
  row('eye', 'Eye level', 'Eye', "Level with the subject's eyes; neutral."),
  row('low', 'Low angle', 'Low', 'Looking up; the subject feels powerful.'),
  row('high', 'High angle', 'High', 'Looking down; the subject feels small.'),
  row('overhead', 'Overhead', 'Overhead', "Straight down from above, bird's-eye view."),
  row('dutch', 'Dutch', 'Dutch', 'A tilted horizon; unease.'),
  row('pov', 'Point of view', 'POV', "Through the character's eyes."),
  row('ots', 'Over the shoulder', 'OTS', "Past one person's shoulder at another."),
]

export const MOTIONS: CameraPreset<CameraMotion>[] = [
  row('static', 'Static', 'Static', "The camera doesn't move."),
  row('push_in', 'Push in', 'Push-in', 'Moves closer to the subject.'),
  row('pull_out', 'Pull out', 'Pull-out', 'Moves away and reveals more.'),
  row('pan_left', 'Pan left', 'Pan L', 'Turns to the left on the spot.'),
  row('pan_right', 'Pan right', 'Pan R', 'Turns to the right on the spot.'),
  row('tilt_up', 'Tilt up', 'Tilt up', 'Tips upward on the spot.'),
  row('tilt_down', 'Tilt down', 'Tilt down', 'Tips downward on the spot.'),
  row('orbit_left', 'Orbit left', 'Orbit L', 'Circles the subject to the left.'),
  row('orbit_right', 'Orbit right', 'Orbit R', 'Circles the subject to the right.'),
  row('handheld', 'Handheld', 'Handheld', 'Follows by hand with a little shake.'),
  row('crane_up', 'Crane up', 'Crane up', 'Rises up and over the scene.'),
  row('crane_down', 'Crane down', 'Crane down', 'Descends into the scene.'),
  row('dolly_left', 'Track left', 'Track L', 'Slides sideways to the left.'),
  row('dolly_right', 'Track right', 'Track R', 'Slides sideways to the right.'),
  row('zoom_in', 'Zoom in', 'Zoom in', 'The lens zooms; the camera stays put.'),
  row('zoom_out', 'Zoom out', 'Zoom out', 'The lens zooms out; the camera stays put.'),
]

export const SPEEDS: CameraPreset<CameraSpeed>[] = [
  row('slow', 'Slow', 'slow', 'Calm, barely noticeable.'),
  row('medium', 'Medium', 'medium', 'A steady, natural pace.'),
  row('fast', 'Fast', 'fast', 'Energetic and quick.'),
]

// the server reads "no speed" as slow too
export const DEFAULT_SPEED: CameraSpeed = 'slow'

export const isEmptyCamera = (c: CameraSetting | undefined) => !c || !(c.size || c.angle || c.motion)

/** Static has no speed; neither does an empty motion. */
export const motionTakesSpeed = (m: CameraMotion | undefined) => !!m && m !== 'static'

/** "MS · Low · Push-in slow", the chip text; '' when nothing is set. */
export function cameraSummary(c: CameraSetting | undefined): string {
  if (!c) return ''
  const bits: string[] = []
  const size = SHOT_SIZES.find((s) => s.id === c.size)
  const angle = ANGLES.find((a) => a.id === c.angle)
  const motion = MOTIONS.find((m) => m.id === c.motion)
  if (size) bits.push(size.short)
  if (angle) bits.push(angle.short)
  if (motion) bits.push(motionTakesSpeed(motion.id) ? `${motion.short} ${c.speed ?? DEFAULT_SPEED}` : motion.short)
  return bits.join(' · ')
}

/** What goes in the request: nothing when the rack is empty, no speed without a move. */
export function cameraPayload(c: CameraSetting | undefined): CameraSetting | undefined {
  if (!c || isEmptyCamera(c)) return undefined
  const out: CameraSetting = {}
  if (c.size) out.size = c.size
  if (c.angle) out.angle = c.angle
  if (c.motion) {
    out.motion = c.motion
    if (motionTakesSpeed(c.motion)) out.speed = c.speed ?? DEFAULT_SPEED
  }
  return out
}
