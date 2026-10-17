import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Download, Flag, Pause, Play, Redo2, Repeat, Save, Undo2, ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useAudioAnalysis, usePeaks } from '@/hooks/useAudioEdit'
import { upsertJob } from '@/hooks/useJobs'
import { upsertMedia, useMediaItem } from '@/hooks/useMedia'
import { qk } from '@/hooks/keys'
import { api } from '@/lib/api'
import {
  addCut,
  changesSound,
  clamp,
  clampView,
  compact,
  describe,
  levelMatch,
  MARKERS_MAX,
  MIN_REGION_S,
  outputToSource,
  sourceToOutput,
  stamp,
  zoomView,
  type View,
} from '@/lib/audio-edit'
import { isTypingTarget } from '@/lib/keyboard'
import { mediaAlt } from '@/lib/media'
import { initUndo, push, redo, undo, type UndoState } from '@/lib/photo/undo'
import type { AudioEdit, AudioPreview, MediaDetail, TimeRegion } from '@/lib/types'
import { cn } from '@/lib/utils'
import { trackJobs } from '@/stores/toasts'
import { announce } from '@/stores/ui'
import { cueAudio, pauseAudio, seekAudio, setGain, setLoop, setLoopRegion, togglePlay, usePlayer, type TrackMeta } from '../sharedAudio'
import { ExportDrawer } from './ExportDrawer'
import { Inspector } from './Inspector'
import { Meters } from './Meters'
import { WaveformView } from './WaveformView'

const PREVIEW_DEBOUNCE_MS = 400
const NUDGE_S = 0.1

type Preview = AudioPreview & { edit: AudioEdit; key: string }

export function EditorPage() {
  const { id } = useParams()
  const item = useMediaItem(id)
  const [params] = useSearchParams()
  const version = params.get('version')

  if (item.isPending) {
    return (
      <div className="flex flex-col gap-3 p-6" role="status" aria-label="Loading the editor">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-56" />
      </div>
    )
  }
  if (item.isError) return <ErrorState error={item.error} onRetry={() => item.refetch()} className="m-6" />
  if (item.data.kind !== 'audio') {
    return (
      <EmptyState title="That isn't an audio item" className="m-6">
        The editor opens songs, cues and effects. <Link to="/audio/edit" className="underline">Pick one</Link>.
      </EmptyState>
    )
  }
  // a fresh stack for every item and version
  return <Editor key={`${item.data.id}:${version ?? ''}`} item={item.data} version={version} />
}

function Editor({ item, version }: { item: MediaDetail; version: string | null }) {
  const qc = useQueryClient()
  // pinned at open: once a save lands, "current" moves on, and the stack must keep applying to this one
  const [opened] = useState(() => version ?? item.generation_id)
  const [compareId, setCompareId] = useState<string | null>(null)
  const aVersion = compareId ?? opened
  const peaksQ = usePeaks(item.id, opened)
  const analysisQ = useAudioAnalysis(item.id, aVersion)
  const peaks = peaksQ.data
  const duration = peaks?.duration_s || item.duration_s || 0
  const title = mediaAlt(item)

  const [hist, setHist] = useState<UndoState<AudioEdit>>(() => initUndo<AudioEdit>({}))
  const edit = hist.present
  const sent = compact(edit, duration)
  const sendKey = JSON.stringify(sent)
  const audible = changesSound(sent)
  const set = (fn: (e: AudioEdit) => AudioEdit, group: string | null = null) => setHist((h) => push(h, fn(h.present), group))

  const [selection, setSelection] = useState<TimeRegion | null>(null)
  const [cursor, setCursor] = useState(0)
  const [viewState, setView] = useState<View | null>(null)
  const view = clampView(viewState ?? { start: 0, span: duration || 1 }, duration)
  const [listen, setListen] = useState<'A' | 'B'>('A')
  const [matched, setMatched] = useState(true)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [rendering, setRendering] = useState(false)
  const [previewError, setPreviewError] = useState<Error | null>(null)
  const [exporting, setExporting] = useState(false)
  const [savedKey, setSavedKey] = useState('{}')

  const aId = `editA:${item.id}`
  const bId = `editB:${item.id}`
  const aSrc = item.versions?.find((g) => g.id === aVersion)?.media_url ?? item.media_url ?? ''
  const metaA: TrackMeta = { title: `${title} · A`, mediaId: item.id }
  const metaB: TrackMeta = { title: `${title} · Edited`, mediaId: item.id, peaks: false }

  const pid = usePlayer((s) => s.id)
  const ptime = usePlayer((s) => s.time)
  const playing = usePlayer((s) => s.playing && (s.id === aId || s.id === bId))
  const loop = usePlayer((s) => s.loop)
  const onA = pid === aId
  const onB = pid === bId && !!preview
  const playhead = onA ? ptime : onB ? outputToSource(ptime, preview!.edit, duration) : cursor

  // ---------------------------------------------------------------- preview (debounced, cancellable)
  const lastUrl = useRef<string | null>(null)
  const previewRef = useRef<Preview | null>(null)
  useEffect(() => {
    previewRef.current = preview
  })
  useEffect(() => {
    const body = JSON.parse(sendKey) as AudioEdit
    if (!changesSound(body)) return
    const ctl = new AbortController()
    const timer = setTimeout(() => {
      setRendering(true)
      api.audio
        .preview(item.id, { edit: body, version: opened }, ctl.signal)
        .then((p) => {
          const old = previewRef.current
          const next: Preview = { ...p, edit: body, key: sendKey }
          // someone listening to B keeps listening, at the same moment of the source
          const s = usePlayer.getState()
          if (s.id === bId && old) {
            const src = outputToSource(s.time, old.edit, duration)
            cueAudio(bId, p.url, { title: `${title} · Edited`, mediaId: item.id, peaks: false }, sourceToOutput(src, body, duration), s.playing)
          }
          if (lastUrl.current) URL.revokeObjectURL(lastUrl.current)
          lastUrl.current = p.url
          setPreview(next)
          setPreviewError(null)
        })
        .catch((e: Error) => {
          if (e.name !== 'AbortError') setPreviewError(e)
        })
        .finally(() => {
          if (!ctl.signal.aborted) setRendering(false)
        })
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      ctl.abort()
    }
  }, [sendKey, item.id, opened, bId, duration, title])

  useEffect(
    () => () => {
      const s = usePlayer.getState()
      if (s.id === aId || s.id === bId) pauseAudio()
      setGain(1)
      setLoopRegion(null)
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current)
    },
    [aId, bId],
  )

  // level-matched A/B: the louder side plays quieter, so "better" isn't just "louder"
  const match = levelMatch(analysisQ.data?.lufs_i, preview?.lufsI)
  useEffect(() => {
    if (!onA && !onB) return
    setGain(matched ? (onA ? match.a : match.b) : 1)
  }, [onA, onB, matched, match.a, match.b])

  // loop the region while there is one; in B's own time when B plays
  useEffect(() => {
    if (!selection || (!onA && !onB)) return setLoopRegion(null)
    if (onB && preview) setLoopRegion({ start: sourceToOutput(selection.start, preview.edit, duration), end: sourceToOutput(selection.end, preview.edit, duration) })
    else setLoopRegion(selection)
  }, [selection, onA, onB, preview, duration])

  // playhead follow: scroll a page once it runs off the edge
  useEffect(
    () =>
      usePlayer.subscribe((s) => {
        if (!s.playing || (s.id !== aId && s.id !== bId)) return
        const p = previewRef.current
        const t = s.id === bId && p ? outputToSource(s.time, p.edit, duration) : s.time
        setView((v) => {
          const cur = clampView(v ?? { start: 0, span: duration || 1 }, duration)
          return t < cur.start || t > cur.start + cur.span ? clampView({ ...cur, start: t - cur.span * 0.1 }, duration) : v
        })
      }),
    [aId, bId, duration],
  )

  // ---------------------------------------------------------------- transport
  const seek = (t: number) => {
    const next = clamp(t, 0, duration)
    setCursor(next)
    if (onA) seekAudio(aId, aSrc, next)
    else if (onB && preview) seekAudio(bId, preview.url, sourceToOutput(next, preview.edit, duration))
  }
  const play = () => {
    if (listen === 'B' && preview) {
      if (onB) togglePlay(bId, preview.url)
      else cueAudio(bId, preview.url, metaB, sourceToOutput(playhead, preview.edit, duration), true)
    } else if (aSrc) {
      if (onA) togglePlay(aId, aSrc)
      else cueAudio(aId, aSrc, metaA, playhead, true)
    }
  }
  const switchTo = (side: 'A' | 'B') => {
    if (side === listen) return
    setListen(side)
    announce(side === 'A' ? 'Listening to A, the original.' : 'Listening to B, the edit.')
    if (!onA && !onB) return
    const t = playhead
    if (side === 'B' && preview) cueAudio(bId, preview.url, metaB, sourceToOutput(t, preview.edit, duration), playing)
    else if (side === 'A' && aSrc) cueAudio(aId, aSrc, metaA, t, playing)
  }

  // ---------------------------------------------------------------- editing
  const doUndo = () => {
    if (!hist.past.length) return
    setHist(undo)
    announce('Undone.')
  }
  const doRedo = () => {
    if (!hist.future.length) return
    setHist(redo)
    announce('Redone.')
  }
  const markIn = () => {
    const end = selection && playhead < selection.end ? selection.end : duration
    setSelection(end - playhead >= MIN_REGION_S ? { start: playhead, end } : null)
    announce(`Region starts at ${stamp(playhead)}.`)
  }
  const markOut = () => {
    const start = selection && playhead > selection.start ? selection.start : 0
    setSelection(playhead - start >= MIN_REGION_S ? { start, end: playhead } : null)
    announce(`Region ends at ${stamp(playhead)}.`)
  }
  const cut = () => {
    if (!selection) return announce('Mark a region first: drag across the waveform, or press I and O.')
    set((e) => addCut(e, selection, duration))
    announce(`Cut ${stamp(selection.start)} to ${stamp(selection.end)}. Ctrl+Z brings it back.`)
    setSelection(null)
  }
  const addMarker = () => {
    const n = edit.markers?.length ?? 0
    if (n >= MARKERS_MAX) return announce(`That's the most markers (${MARKERS_MAX}).`)
    const t = Math.round(playhead * 1000) / 1000
    set((e) => ({ ...e, markers: [...(e.markers ?? []), { t, label: `Marker ${n + 1}` }].sort((a, b) => a.t - b.t) }))
    announce(`Marker ${n + 1} at ${stamp(t)}.`)
  }
  const zoom = (factor: number) => setView(zoomView(view, factor, playhead >= view.start && playhead <= view.start + view.span ? playhead : view.start + view.span / 2, duration))

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement
    if (isTypingTarget(target)) return
    const control = !!target.closest('button, a, select, input, [role="slider"], [role="radio"]')
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    if (mod && key === 'z') {
      if (e.shiftKey) doRedo()
      else doUndo()
    } else if (mod && key === 'y') doRedo()
    else if (mod || e.altKey) return
    else if (key === ' ' && !control) play()
    else if (key === 'i') markIn()
    else if (key === 'o') markOut()
    else if (key === 'm') addMarker()
    else if (key === 'l') setLoop(!loop)
    else if (key === 'Delete' || key === 'Backspace') cut()
    else if (key === 'Home' && !control) seek(0)
    else if (key === 'End' && !control) seek(duration)
    else if ((key === 'ArrowLeft' || key === 'ArrowRight') && !control) seek(playhead + (key === 'ArrowLeft' ? -1 : 1) * NUDGE_S * (e.shiftKey ? 10 : 1))
    else if (key === '+' || key === '=') zoom(1.5)
    else if (key === '-' || key === '_') zoom(1 / 1.5)
    else return
    e.preventDefault()
  }

  const save = useMutation({
    mutationFn: () => api.audio.render(item.id, { edit: sent, version: opened, note: describe(sent) }),
    onSuccess: (res) => {
      upsertJob(qc, res.job)
      if (res.item) upsertMedia(qc, res.item)
      trackJobs([res.job], `Edited · ${title}`, `/audio/edit/${item.id}`)
      qc.invalidateQueries({ queryKey: qk.mediaItem(item.id) })
      setSavedKey(sendKey)
      announce('Saving as a new version. It appears under Versions when it’s ready.')
    },
  })

  const summary = [
    `${title}, ${stamp(duration)} long.`,
    `Showing ${stamp(view.start)} to ${stamp(view.start + view.span)}.`,
    `Playhead at ${stamp(playhead)}.`,
    selection ? `Region ${stamp(selection.start)} to ${stamp(selection.end)}.` : 'No region.',
    sent.cuts?.length ? `${sent.cuts.length} cut${sent.cuts.length === 1 ? '' : 's'}.` : '',
    sent.markers?.length ? `${sent.markers.length} marker${sent.markers.length === 1 ? '' : 's'}.` : '',
    'Space plays, I and O mark a region, Delete cuts it, M adds a marker, arrows move the playhead.',
  ]
    .filter(Boolean)
    .join(' ')

  const dirty = sendKey !== '{}' && sendKey !== savedKey
  const fresh = preview?.key === sendKey

  return (
    <main
      data-f6-region
      tabIndex={-1}
      aria-label={`Audio editor: ${title}`}
      onKeyDown={onKeyDown}
      className="relative h-full overflow-y-auto focus-visible:outline-none lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:overflow-hidden"
    >
      <div className="flex min-w-0 flex-col gap-3 p-3 md:p-4 lg:overflow-y-auto">
        <header className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-title font-semibold">{title}</h1>
            <p className="truncate text-small text-studio-faint" aria-live="polite">
              {describe(sent)}
            </p>
          </div>
          <Button size="icon-sm" variant="ghost" onClick={doUndo} disabled={!hist.past.length} aria-label="Undo" title="Undo (Ctrl+Z)">
            <Undo2 aria-hidden />
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={doRedo} disabled={!hist.future.length} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
            <Redo2 aria-hidden />
          </Button>
          <Button size="sm" onClick={() => setExporting(true)}>
            <Download aria-hidden />
            Export
          </Button>
          <Button size="sm" variant="primary" disabled={sendKey === '{}' || !dirty} loading={save.isPending} onClick={() => save.mutate()}>
            <Save aria-hidden />
            Save as version
          </Button>
        </header>
        {save.isError && <ErrorState compact title="Couldn't save" error={save.error} />}

        <div className="flex flex-wrap items-center gap-2 text-small">
          <button
            type="button"
            onClick={play}
            disabled={listen === 'B' ? !preview : !aSrc}
            aria-label={playing ? 'Pause' : `Play ${listen}`}
            aria-keyshortcuts="Space"
            className="flex size-9 items-center justify-center rounded-full bg-studio-accent text-studio-accent-fg shadow-card hover:bg-studio-accent-hover disabled:opacity-40"
          >
            {playing ? <Pause aria-hidden className="size-4" /> : <Play aria-hidden className="size-4 translate-x-px" />}
          </button>
          <span className="font-mono tabular-nums" data-testid="editor-time">
            {stamp(playhead)} <span className="text-studio-faint">/ {stamp(duration)}</span>
          </span>
          <div role="radiogroup" aria-label="Compare" className="ml-2 flex overflow-hidden rounded-[4px] border border-studio-border-strong">
            {(['A', 'B'] as const).map((side) => (
              <button
                key={side}
                type="button"
                role="radio"
                aria-checked={listen === side}
                disabled={side === 'B' && (!audible || !preview)}
                onClick={() => switchTo(side)}
                className={cn('h-7 px-2.5 font-medium disabled:opacity-40', listen === side ? 'bg-studio-accent text-studio-accent-fg' : 'hover:bg-studio-panel-hover')}
              >
                {side === 'A' ? 'A · Original' : 'B · Edited'}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1 text-studio-muted" title="Plays both sides at the same loudness">
            <input type="checkbox" checked={matched} onChange={(e) => setMatched(e.target.checked)} />
            Level-matched
          </label>
          <span className="text-[11px] text-studio-faint" role="status">
            {!audible ? '' : rendering ? 'Rendering preview…' : previewError ? '' : fresh ? `Preview ready${preview?.renderMs ? ` · ${(preview.renderMs / 1000).toFixed(1)} s` : ''}` : 'Preview pending…'}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Button size="icon-sm" variant="ghost" aria-pressed={loop} onClick={() => setLoop(!loop)} aria-label={selection ? 'Loop the region' : 'Loop'} title="Loop (L)" className={cn(loop && 'bg-studio-accent-soft text-studio-text')}>
              <Repeat aria-hidden />
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={addMarker} aria-label="Add a marker at the playhead" title="Marker (M)">
              <Flag aria-hidden />
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={() => zoom(1 / 1.5)} disabled={view.span >= duration} aria-label="Zoom out" title="Zoom out (−)">
              <ZoomOut aria-hidden />
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={() => zoom(1.5)} aria-label="Zoom in" title="Zoom in (+)">
              <ZoomIn aria-hidden />
            </Button>
          </span>
        </div>
        {previewError && <ErrorState compact title="The preview didn't render" error={previewError} />}

        <div className="overflow-hidden rounded-[6px] border border-studio-border-strong">
          {peaksQ.isError ? (
            <ErrorState compact title="The waveform couldn't load" error={peaksQ.error} onRetry={() => peaksQ.refetch()} className="m-3" />
          ) : (
            <WaveformView
              peaks={peaks?.peaks ?? null}
              duration={duration}
              view={view}
              onView={setView}
              playhead={playhead}
              onSeek={seek}
              selection={selection}
              onSelect={setSelection}
              trim={sent.trim}
              cuts={sent.cuts ?? []}
              markers={sent.markers ?? []}
              summary={summary}
            />
          )}
        </div>

        <Meters analysis={analysisQ.data} preview={preview} pendingA={analysisQ.isPending} pendingB={rendering} listen={listen} hasEdit={audible} />
      </div>

      <aside aria-label="Edit settings" className="min-h-0 border-t border-studio-border bg-studio-panel lg:overflow-y-auto lg:border-l lg:border-t-0">
        <Inspector
          item={item}
          edit={edit}
          set={set}
          duration={duration}
          selection={selection}
          onSelection={setSelection}
          onSeek={seek}
          openedId={opened}
          compareId={compareId}
          onCompare={(gid) => {
            setCompareId(gid === opened ? null : gid)
            setListen('A')
          }}
        />
      </aside>
      <ExportDrawer open={exporting} onOpenChange={setExporting} itemId={item.id} version={opened} title={title} dirty={dirty} />
    </main>
  )
}
