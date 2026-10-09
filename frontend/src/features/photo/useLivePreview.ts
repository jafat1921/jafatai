import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { geometryFor } from '@/lib/photo/geometry'
import { histogramOf } from '@/lib/photo/histogram'
import { compact, needsServer, paramsKey } from '@/lib/photo/params'
import { createRenderer, type DevelopRenderer } from '@/lib/photo/shader'
import type { DevelopParams, Histogram } from '@/lib/photo/types'

const TEXTURE_MAX = 4096
const DEBOUNCE_MS = 250
const PREVIEW_SIDE = 1280

export type PreviewMode = 'init' | 'webgl' | 'server'

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
export function useLivePreview({ sourceUrl, previewId, params, before, maxSide }: {
  sourceUrl: string | null
  previewId: string
  params: DevelopParams
  before: boolean
  maxSide: number
}) {
  const renderer = useRef<DevelopRenderer | null>(null)
  const [mode, setMode] = useState<PreviewMode>('init')
  const [src, setSrc] = useState<{ w: number; h: number; url: string } | null>(null)
  const [srcError, setSrcError] = useState<string | null>(null)
  const [server, setServer] = useState<ServerPreview | null>(null)
  const [serverError, setServerError] = useState<unknown>(null)
  const [histogram, setHistogram] = useState<Histogram | null>(null)
  const urls = useRef<string[]>([])
  const key = paramsKey(params)

  const attachCanvas = useCallback((el: HTMLCanvasElement | null) => {
    if (!el) {
      renderer.current?.dispose()
      renderer.current = null
      return
    }
    renderer.current = createRenderer(el)
    setMode(renderer.current ? 'webgl' : 'server')
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

  // instant draw on every change
  useEffect(() => {
    if (mode !== 'webgl' || !ready) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const frame = requestAnimationFrame(() => {
      const r = renderer.current
      if (!r) return
      r.render(params, { before, maxSide })
      // the read-back is the slow part; one every 150 ms is plenty for a histogram
      timer = setTimeout(() => {
        const px = r.readPixels()
        setHistogram(histogramOf(px, Math.max(1, Math.floor(px.length / 4 / 250_000))))
      }, 150)
    })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [mode, ready, params, before, maxSide])

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
    // WebGL can't show spatial edits, the palette or a .cube: say so until the server catches up
    approximate: mode === 'webgl' && !exact && needsServer(params),
    histogram,
    snapshot,
  }
}

export type LivePreview = ReturnType<typeof useLivePreview>
