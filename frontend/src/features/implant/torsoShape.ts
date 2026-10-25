import type { ImplantOption, Measurements, OptionCheck } from '@/lib/implant'
import type { TorsoShape } from './torso3d'

const CUPS = ['AA', 'A', 'B', 'C', 'D', 'DD', 'E', 'F', 'G']
// rough forward projection of a breast by cup, cm; the model only needs a believable start
const CUP_PROJECTION = [2.5, 3.5, 4.5, 5.5, 6.5, 7.3, 8, 8.7, 9.4]


/** The present form and, with a checked option, the form after: her measurements and the implant's size only. */
export function torsoShapes(m: Measurements, opt: ImplantOption | undefined, check: OptionCheck | undefined): { before: TorsoShape; after: TorsoShape | null } {
  const cup = CUPS.indexOf((m.bra_size ?? '').toUpperCase().replace(/[^A-Z]/g, ''))
  const projection = cup >= 0 ? CUP_PROJECTION[cup] : 4
  const side = (cm: number | null | undefined) => ({ radius: (cm ?? 12) / 2, projection })
  const before: TorsoShape = {
    chestWidth: m.chest_width_cm ?? 32,
    snn: (m.snn_left_cm ?? m.snn_right_cm) || 19,
    left: side(m.bw_left_cm),
    right: side(m.bw_right_cm),
  }
  if (!opt || !check) return { before, after: null }
  const lift = opt.procedure === 'augmentation_lift' ? 2 : 0
  // the implant fills under her own tissue, which takes up some of its projection
  const grow = (b: TorsoShape['left'], s: OptionCheck['sides']['left']) => ({
    radius: Math.max(b.radius, s.width_cm / 2),
    projection: b.projection + s.projection_cm * 0.8,
    lift,
  })
  return { before, after: { ...before, left: grow(before.left, check.sides.left), right: grow(before.right, check.sides.right) } }
}
