import type { PhotoAnalysis } from './types'

/** The one-line analysis summary under Smart Restore (the NoorViz "Analysis:" line). */
export function analysisLine(a: PhotoAnalysis): string {
  const bits = [`${a.megapixels} MP`, a.is_grayscale ? 'black & white' : a.is_monotone ? 'sepia / tinted' : 'colour']
  if (a.color_cast) bits.push(`${a.color_cast} cast ${Math.round(a.cast_strength * 100)}%`)
  bits.push(`sharpness ${a.sharpness}`)
  if (a.noise != null) bits.push(`noise ${a.noise}`)
  if (a.is_likely_damaged) bits.push('likely damaged')
  if (a.is_likely_blurry) bits.push('likely blurry')
  return bits.join(' · ')
}
