import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { geometryFor } from '@/lib/photo/geometry'
import { histogramOf } from '@/lib/photo/histogram'
import { compact, needsServer, paramsKey } from '@/lib/photo/params'
import { createRenderer, type DevelopRenderer, type LutTable } from '@/lib/photo/shader'
import type { DevelopParams, Histogram } from '@/lib/photo/types'

const TEXTURE_MAX = 4096
const DEBOUNCE_MS = 250
const PREVIEW_SIDE = 1280

export type PreviewMode = 'init' | 'webgl' | 'server'

// tables are small (33³) and never change for an id: one fetch per session
const lutCache = new Map<string, Promise<LutTable>>()
function lutFor(kind: 'profile' | 'look', id: string) {
  const k = `${kind}:${id}`
  let p = lutCache.get(k)
  if (!p) {
    p = api.photo.lut(kind, id)
    p.catch(() => lutCache.delete(k))
    lutCache.set(k, p)
  }
  return p
}

interface ServerPreview {
  key: string
  url: string
  ms: number | null
}

async function loadSource(url: string, max: number): Promise<{ bitmap: TexImageSource & { width: number }; w: number; h: number }> {
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  await img.decode()
  const w = img.naturalWidth
  const h = img.naturalHeight
  if (!w || !h) throw new Error('empty image')
  const k = Math.min(1, max / Math.max(w, h))
  if (k === 1) return { bitmap: img, w, h }
  const c = document.createElement('canvas')
  c.width = Math.round(w * k)
  c.height = Math.round(h * k)
  c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height)
  return { bitmap: c, w, h }
}

/**
 * Instant WebGL develop of a downscaled source, plus a debounced, abortable server render at 1280 px
 * that replaces it once it matches the current params ("exact preview"). Without WebGL2 the server
 * render is all there is.
 */
/** Highlight (red) and shadow (blue) clipping as a transparent PNG over the frame, like Lightroom's J. */
function clipImage(px: Uint8Array, w: number, h: number): string | null {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) return null
  const img = ctx.createImageData(w, h)
  for (let y = 0; y < h; y++) {
    // readPixels is bottom-up
    const src = (h - 1 - y) * w * 4
    const dst = y * w * 4
    for (let x = 0; x < w * 4; x += 4) {
      const r = px[src + x], g = px[src + x + 1], b = px[src + x + 2]
      if (r >= 254 || g >= 254 || b >= 254) img.data.set([255, 40, 40, 255], dst + x)
      else if (r <= 1 && g <= 1 && b <= 1) img.data.set([40, 110, 255, 255], dst + x)
    }
  }
  ctx.putImageData(img, 0, 0)
  return c.toDataURL('image/png')
}

export function useLivePreview({ sourceUrl, previewId, params, before, maxSide, clip = false, wantBefore = false }: {
  sourceUrl: string | null
  previewId: string
  params: DevelopParams
  before: boolean
  maxSide: number
  // J: show clipped pixels
  clip?: boolean
  // a split before/after view needs the unedited frame (crop and straighten applied) as an image
  wantBefore?: boolean
}) {
  const renderer = useRef<DevelopRenderer | null>(null)
  const [mode, setMode] = useState<PreviewMode>('init')
  const [src, setSrc] = useState<{ w: number; h: number; url: string } | null>(null)
  const [srcError, setSrcError] = useState<string | null>(null)
  const [server, setServer] = useState<ServerPreview | null>(null)
  const [serverError, setServerError] = useState<unknown>(null)
  const [histogram, setHistogram] = useState<Histogram | null>(null)
  const [clipUrl, setClipUrl] = useState<string | null>(null)
  const [beforeUrl, setBeforeUrl] = useState<string | null>(null)
  const pixels = useRef<{ data: Uint8Array; w: number; h: number } | null>(null)
  const urls = useRef<string[]>([])
  const key = paramsKey(params)
  const profileId = params.profile?.id && params.profile.id !== 'color' ? params.profile.id : null
  const lookId = params.lut?.look_id ?? null
  // tables the renderer holds; a change redraws with them
  const [luts, setLuts] = useState<{ profile: string | null; look: string | null }>({ profile: null, look: null })

  const attachCanvas = useCallback((el: HTMLCanvasElement | null) => {
    if (!el) {
      renderer.current?.dispose()
      renderer.current = null
      return
    }
    renderer.current = createRenderer(el)
    setMode(renderer.current ? 'webgl' : 'server')
    setLuts({ profile: null, look: null })
  }, [])

  // source: the texture in WebGL mode, and the true pixel size either way (crop and points use it)
  useEffect(() => {
    if (!sourceUrl || mode === 'init') return
    let gone = false
    loadSource(sourceUrl, mode === 'webgl' ? TEXTURE_MAX : 1)
      .then(({ bitmap, w, h }) => {
        if (gone) return
        renderer.current?.setSource(bitmap, w, h)
        setSrc({ w, h, url: sourceUrl })
      })
      .catch(() => !gone && setSrcError("This picture couldn't be loaded for the live preview."))
    return () => {
      gone = true
    }
  }, [sourceUrl, mode])

  const ready = !!src && src.url === sourceUrl

  useEffect(() => {
    if (mode !== 'webgl') return
    let gone = false
    const want = [['profile', profileId], ['look', lookId]] as const
    for (const [kind, id] of want) {
      if (!id || renderer.current?.lutId(kind) === id) continue
      lutFor(kind, id).then(
        (t) => {
          if (gone || !renderer.current) return
          renderer.current.setLut(kind, id, t)
          setLuts((l) => ({ ...l, [kind]: id }))
        },
        // no table: the server render still shows it, the preview just stays approximate
        () => {},
      )
    }
    return () => {
      gone = true
    }
  }, [mode, profileId, lookId])
  const lutsLoaded =
    mode !== 'webgl' ||
    ((!profileId || luts.profile === profileId) && (!lookId || luts.look === lookId))

  // instant draw on every change
  useEffect(() => {
    if (mode !== 'webgl' || !ready) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const frame = requestAnimationFrame(() => {
      const r = renderer.current
      if (!r) return
      if (wantBefore) {
        // draw the untouched frame once, keep it as a picture, then draw the edit over it
        r.render(params, { before: true, maxSide })
        setBeforeUrl(r.canvas.toDataURL('image/jpeg', 0.9))
      }
      r.render(params, { before, maxSide })
      // the read-back is the slow part; one every 150 ms is plenty for a histogram
      timer = setTimeout(() => {
        const px = r.readPixels()
        pixels.current = { data: px, w: r.canvas.width, h: r.canvas.height }
        setHistogram(histogramOf(px, Math.max(1, Math.floor(px.length / 4 / 250_000))))
        setClipUrl(clip ? clipImage(px, r.canvas.width, r.canvas.height) : null)
      }, 150)
    })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [mode, ready, params, before, maxSide, clip, wantBefore, luts])

  // the server's exact render, once the sliders rest
  useEffect(() => {
    if (mode === 'init' || server?.key === key) return
    const ctl = new AbortController()
    const body = compact(params)
    const timer = setTimeout(() => {
      api.photo
        .preview(previewId, body, PREVIEW_SIDE, ctl.signal)
        .then((res) => {
          urls.current.push(res.url)
          // keep the one on screen and the new one; older blobs can go
          while (urls.current.length > 2) URL.revokeObjectURL(urls.current.shift()!)
          setServer({ key, url: res.url, ms: res.ms })
          setServerError(null)
        })
        .catch((e) => {
          if ((e as Error)?.name !== 'AbortError') setServerError(e)
        })
      if (mode === 'server') api.photo.histogram(previewId, body).then(setHistogram, () => {})
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      ctl.abort()
    }
    // params are covered by key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, previewId, mode])

  useEffect(
    () => () => {
      urls.current.forEach((u) => URL.revokeObjectURL(u))
      urls.current = []
    },
    [],
  )

  const serverUrl = server?.url ?? null
  // for the before/after split; called from a click, never while rendering
  const snapshot = useCallback(
    () => (renderer.current && mode === 'webgl' ? renderer.current.canvas.toDataURL('image/jpeg', 0.92) : serverUrl),
    [mode, serverUrl],
  )

  /** RGB 0..255 of the live preview at 0..1 of the frame (the histogram's readout). */
  const sample = useCallback((x: number, y: number): [number, number, number] | null => {
    const p = pixels.current
    if (!p) return null
    const ix = Math.min(p.w - 1, Math.max(0, Math.floor(x * p.w)))
    const iy = p.h - 1 - Math.min(p.h - 1, Math.max(0, Math.floor(y * p.h)))
    const i = (iy * p.w + ix) * 4
    return [p.data[i], p.data[i + 1], p.data[i + 2]]
  }, [])

  const exact = server?.key === key
  const geo = src ? geometryFor(src.w, src.h, params) : null

  return {
    attachCanvas,
    mode,
    ready,
    source: src,
    sourceError: srcError,
    frame: geo ? { width: geo.width, height: geo.height } : null,
    server,
    serverError,
    exact,
    // WebGL can't show spatial edits or the palette (nor a look whose table is still loading): say so until the server catches up
    approximate: mode === 'webgl' && !exact && (needsServer(params) || !lutsLoaded),
    histogram,
    snapshot,
    sample,
    clipUrl: clip && mode === 'webgl' ? clipUrl : null,
    beforeUrl: mode === 'webgl' ? beforeUrl : sourceUrl,
  }
}

export type LivePreview = ReturnType<typeof useLivePreview>
