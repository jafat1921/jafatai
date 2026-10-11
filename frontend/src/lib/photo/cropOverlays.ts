// Crop tool overlays (Lightroom's O / Shift+O), as lines in 0..1 of the crop box.

// Lightroom's crop overlays, in the order O cycles through them
export const CROP_OVERLAYS = [
  { id: 'thirds', label: 'Thirds' },
  { id: 'grid', label: 'Grid' },
  { id: 'diagonal', label: 'Diagonal' },
  { id: 'triangle', label: 'Triangle' },
  { id: 'golden', label: 'Golden ratio' },
  { id: 'spiral', label: 'Golden spiral' },
  { id: 'none', label: 'None' },
] as const
export type CropOverlayKind = (typeof CROP_OVERLAYS)[number]['id']

export const nextOverlay = (k: CropOverlayKind): CropOverlayKind => CROP_OVERLAYS[(CROP_OVERLAYS.findIndex((o) => o.id === k) + 1) % CROP_OVERLAYS.length].id

const PHI = (1 + Math.sqrt(5)) / 2

/** A golden spiral as quarter arcs through shrinking golden rectangles, in a PHI × 1 box. */
export function spiralPoints(turns = 10, steps = 12): [number, number][] {
  let x = 0
  let y = 0
  let w = PHI
  let h = 1
  const pts: [number, number][] = []
  for (let i = 0; i < turns; i++) {
    const side = i % 4
    const s = side % 2 === 0 ? h : w
    const [cx, cy, a0] = side === 0 ? [x + s, y + s, Math.PI] : side === 1 ? [x, y + s, 1.5 * Math.PI] : side === 2 ? [x + w - s, y, 0] : [x + s, y + h - s, 0.5 * Math.PI]
    for (let k = 0; k <= steps; k++) {
      const a = a0 + (k / steps) * (Math.PI / 2)
      pts.push([cx + s * Math.cos(a), cy + s * Math.sin(a)])
    }
    if (side === 0) {
      x += s
      w -= s
    } else if (side === 1) {
      y += s
      h -= s
    } else if (side === 2) w -= s
    else h -= s
  }
  return pts.map(([px, py]) => [px / PHI, py])
}

/** Overlay lines in 0..1 of the crop box. `aspect` (w/h) keeps the triangle's right angles right. */
export function overlayLines(kind: CropOverlayKind, aspect: number): { lines: [number, number, number, number][]; path?: string } {
  const lines: [number, number, number, number][] = []
  if (kind === 'thirds' || kind === 'golden') {
    const a = kind === 'thirds' ? 1 / 3 : 1 / PHI ** 2
    for (const t of [a, 1 - a]) lines.push([t, 0, t, 1], [0, t, 1, t])
  } else if (kind === 'grid') {
    for (let i = 1; i < 8; i++) lines.push([i / 8, 0, i / 8, 1], [0, i / 8, 1, i / 8])
  } else if (kind === 'diagonal') {
    // 45° in pixels from every corner
    const d = Math.min(1, 1 / aspect)
    const e = Math.min(1, aspect)
    lines.push([0, 0, d, e], [1, 0, 1 - d, e], [0, 1, d, 1 - e], [1, 1, 1 - d, 1 - e])
  } else if (kind === 'triangle') {
    // the diagonal, and the perpendiculars from the other two corners onto it (worked out in pixels)
    lines.push([0, 0, 1, 1])
    const w = aspect
    const t = (w * w) / (w * w + 1)
    lines.push([1, 0, t, t], [0, 1, 1 - t, 1 - t])
  } else if (kind === 'spiral') {
    const pts = spiralPoints()
    return { lines: [], path: 'M' + pts.map(([x, y]) => `${x.toFixed(4)} ${y.toFixed(4)}`).join(' L') }
  }
  return { lines }
}
