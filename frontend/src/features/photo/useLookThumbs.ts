import { useEffect, useState } from 'react'
import { mergeParams, paramsKey } from '@/lib/photo/params'
import { createRenderer } from '@/lib/photo/shader'
import type { DevelopParams, Look } from '@/lib/photo/types'

const SIDE = 192

/**
 * Live tile previews: each look put over the current params, drawn on a small copy of the photo by
 * WebGL. Looks with a .cube (and every look without WebGL2) fall back to the server's thumb route.
 */
export function useLookThumbs(looks: Look[] | undefined, sourceUrl: string | null, params: DevelopParams) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const key = paramsKey(params)
  const list = (looks ?? []).filter((l) => !l.has_cube)
  const ids = list.map((l) => `${l.id}:${l.updated_at ?? ''}`).join(',')

  useEffect(() => {
    if (!sourceUrl || !list.length) return
    let gone = false
    // wait for the sliders to settle; tiles don't need to follow every frame
    const timer = setTimeout(async () => {
      const canvas = document.createElement('canvas')
      const r = createRenderer(canvas)
      if (!r) return
      try {
        const img = new Image()
        img.src = sourceUrl
        await img.decode()
        const k = Math.min(1, (SIDE * 2) / Math.max(img.naturalWidth, img.naturalHeight))
        const small = document.createElement('canvas')
        small.width = Math.max(1, Math.round(img.naturalWidth * k))
        small.height = Math.max(1, Math.round(img.naturalHeight * k))
        small.getContext('2d')?.drawImage(img, 0, 0, small.width, small.height)
        r.setSource(small, img.naturalWidth, img.naturalHeight)
        const out: Record<string, string> = {}
        for (const look of list) {
          r.render(mergeParams(params, look.params), { maxSide: SIDE })
          out[look.id] = canvas.toDataURL('image/jpeg', 0.8)
        }
        if (!gone) setThumbs(out)
      } catch {
        /* server thumbs it is */
      } finally {
        r.dispose()
      }
    }, 400)
    return () => {
      gone = true
      clearTimeout(timer)
    }
    // `list` and `params` are covered by ids and key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, key, sourceUrl])

  return thumbs
}
