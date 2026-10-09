import { dec, wbGains } from './maths'

const clamp = (v: number) => Math.max(-100, Math.min(100, Math.round(v)))

/**
 * Temperature and tint that make a picked pixel neutral grey, like Lightroom's White Balance
 * Selector. `rgb` is what the preview shows (0..255) under the current temp / tint; the tone
 * steps after white balance treat the three channels alike, so a neutral stays neutral through them.
 */
export function neutralWb(rgb: [number, number, number], temperature = 0, tint = 0): { temperature: number; tint: number } | null {
  const g = wbGains(temperature, tint)
  const b = rgb.map((v, i) => dec(v / 255) / g[i])
  // a clipped or black pixel says nothing about the light
  if (b.some((v) => v < 1e-4) || rgb.some((v) => v >= 254)) return null
  // gains: R ∝ ((1+.3t)(1+.15m))^2.2, G ∝ (1−.15m)^2.2, B ∝ ((1−.3t)(1+.15m))^2.2
  const q = Math.pow(b[2] / b[0], 1 / 2.2)
  const t = (q - 1) / (0.3 * (1 + q))
  const w = Math.pow(b[1] / b[0], 1 / 2.2)
  const z = w / (1 + 0.3 * t)
  const m = (z - 1) / (0.15 * (1 + z))
  return { temperature: clamp(t * 100), tint: clamp(m * 100) }
}
