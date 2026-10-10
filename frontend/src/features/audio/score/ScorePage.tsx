import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Clapperboard, Film, Headphones, Music, Music4, Pause, Play, Plus, Trash2, Volume2 } from 'lucide-react'
import { MediaPicker } from '@/components/media/MediaPicker'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { Button, buttonVariants } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { usePeaks } from '@/hooks/useAudioEdit'
import { upsertJob } from '@/hooks/useJobs'
import { useMediaItem } from '@/hooks/useMedia'
import { api } from '@/lib/api'
import { clamp, LOUDNESS, loudnessLabel, minus, stamp } from '@/lib/audio-edit'
import type { AudioPreview, LoudnessTarget, MediaItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { trackJobs } from '@/stores/toasts'
import { announce } from '@/stores/ui'
import { pauseAudio, seekAudio, togglePlay, usePlayer } from '../sharedAudio'
import { drawPeaks, prepare, token, useSize } from '../waveDraw'
import { addLanes, MAX_LANES, mixBody, patchLane, removeLane, setVideo, useScoreDraft, type Lane } from './draft'

const FIELD = 'h-7 rounded-[4px] border border-studio-border bg-studio-raised px-1.5 text-small focus-visible:border-studio-accent'
const LABEL_W = 'w-28 md:w-36'

function LaneWave({ mediaId }: { mediaId: string }) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const { width, height } = useSize(box)
  const peaks = usePeaks(mediaId, null, 400).data
  useEffect(() => {
    const c = canvas.current
    if (!c || !width || !height || !peaks) return
    const ctx = prepare(c, width, height)
    if (ctx) drawPeaks(ctx, peaks.peaks, peaks.duration_s, 0, peaks.duration_s, width, height, token('--color-studio-accent-fg', '#fff8ec'))
  }, [peaks, width, height])
  return (
    <div ref={box} aria-hidden className="pointer-events-none absolute inset-0 opacity-70">
      <canvas ref={canvas} className="size-full" />
    </div>
  )
}

/** One audio lane's block on the timeline: drag it, or use the arrows, to set where it starts. */
function LaneBlock({ lane, length, pps, onOffset }: { lane: Lane; length: number; pps: number; onOffset: (s: number) => void }) {
  const [drag, setDrag] = useState<{ x: number; at: number } | null>(null)
  const span = lane.loop ? Math.max(0, length - lane.offset_s) : lane.duration || Math.max(1, length - lane.offset_s)
  const nudge = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 1 : 0.1
    const by: Record<string, number> = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }
    if (e.key in by) onOffset(lane.offset_s + by[e.key])
    else if (e.key === 'Home') onOffset(0)
    else return
    e.preventDefault()
  }
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={`Start of ${lane.title}`}
      aria-valuemin={0}
      aria-valuemax={Math.round(length * 10) / 10}
      aria-valuenow={Math.round(lane.offset_s * 10) / 10}
      aria-valuetext={`Starts at ${stamp(lane.offset_s)}`}
      onKeyDown={nudge}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId)
        setDrag({ x: e.clientX, at: lane.offset_s })
      }}
      onPointerMove={(e) => drag && pps > 0 && onOffset(drag.at + (e.clientX - drag.x) / pps)}
      onPointerUp={() => setDrag(null)}
      className={cn(
        'absolute inset-y-1 min-w-3 cursor-grab touch-none overflow-hidden rounded-[4px] bg-studio-accent text-studio-accent-fg shadow-card focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-studio-accent-hover active:cursor-grabbing',
        (lane.mute || drag) && 'opacity-60',
      )}
      style={{ left: `${(lane.offset_s / (length || 1)) * 100}%`, width: `${(Math.min(span, Math.max(0, length - lane.offset_s)) / (length || 1)) * 100}%` }}
    >
      <LaneWave mediaId={lane.mediaId} />
      <span className="relative truncate px-1.5 text-[11px] font-medium leading-6">{lane.title}</span>
    </div>
  )
}

function Toggle({ on, onClick, label, children }: { on: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn('flex size-7 items-center justify-center rounded-[4px] border text-[11px] font-semibold', on ? 'border-studio-accent bg-studio-accent text-studio-accent-fg' : 'border-studio-border hover:bg-studio-panel-hover')}
    >
      {children}
    </button>
  )
}

function Num({ label, value, onChange, min, max, step, unit }: { label: string; value: number; onChange: (n: number) => void; min: number; max: number; step: number; unit: string }) {
  return (
    <label className="flex items-center gap-1 text-[11px] text-studio-muted">
      {label}
      <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(clamp(Number(e.target.value) || 0, min, max))} className={cn(FIELD, 'w-16 text-right font-mono')} />
      <span aria-hidden className="text-studio-faint">
        {unit}
      </span>
    </label>
  )
}

function LaneRow({ lane, length, pps }: { lane: Lane; length: number; pps: number }) {
  const set = (p: Partial<Lane>) => patchLane(lane.key, p)
  return (
    <li aria-label={lane.title} className="border-t border-studio-border py-1.5">
      <div className="flex items-stretch gap-2">
        <div className={cn('flex shrink-0 items-center gap-1', LABEL_W)}>
          <span className="min-w-0 flex-1 truncate text-small font-medium" title={lane.title}>
            {lane.title}
          </span>
          <Toggle on={lane.mute} onClick={() => set({ mute: !lane.mute })} label={`Mute ${lane.title}`}>
            M
          </Toggle>
          <Toggle on={lane.solo} onClick={() => set({ solo: !lane.solo })} label={`Solo ${lane.title}`}>
            S
          </Toggle>
        </div>
        <div className="relative h-8 min-w-0 flex-1 rounded-[4px] bg-studio-raised">
          <LaneBlock lane={lane} length={length} pps={pps} onOffset={(s) => set({ offset_s: Math.round(clamp(s, 0, Math.max(0, length - 0.1)) * 1000) / 1000 })} />
        </div>
      </div>
      <div className={cn('mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 md:pl-38')}>
        <span className="font-mono text-[11px] text-studio-faint">at {stamp(lane.offset_s)}</span>
        <Num label="Gain" value={lane.gain_db} onChange={(n) => set({ gain_db: n })} min={-24} max={12} step={0.5} unit="dB" />
        <Num label="Fade in" value={lane.fade_in_s} onChange={(n) => set({ fade_in_s: n })} min={0} max={30} step={0.1} unit="s" />
        <Num label="Fade out" value={lane.fade_out_s} onChange={(n) => set({ fade_out_s: n })} min={0} max={30} step={0.1} unit="s" />
        <label className="flex items-center gap-1 text-[11px]">
          <input type="checkbox" checked={lane.loop} onChange={(e) => set({ loop: e.target.checked })} />
          Loop
        </label>
        <label className="flex items-center gap-1 text-[11px]" title="Dips under the original sound">
          <input type="checkbox" checked={lane.duck} onChange={(e) => set({ duck: e.target.checked })} />
          Duck under dialogue
        </label>
        <button type="button" onClick={() => removeLane(lane.key)} aria-label={`Remove ${lane.title}`} className="ml-auto rounded-[4px] p-1 text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text">
          <Trash2 aria-hidden className="size-3.5" />
        </button>
      </div>
    </li>
  )
}

const GENERATE = [
  { kind: 'music', label: 'Music & Score', to: '/audio/music', icon: Music4 },
  { kind: 'song', label: 'Song', to: '/audio/song', icon: Music },
  { kind: 'sfx', label: 'Sound FX', to: '/audio/sfx', icon: Volume2 },
] as const

/**
 * Score a Clip: a video, its own sound, and up to four tracks laid under it. One transport plays the
 * rendered mix and keeps the muted video on the same frame.
 */
export function ScorePage() {
  const qc = useQueryClient()
  const [params] = useSearchParams()
  const draft = useScoreDraft()
  const video = useMediaItem(draft.videoId)
  const v = video.data
  const [pickVideo, setPickVideo] = useState(false)
  const [pickAudio, setPickAudio] = useState(false)
  const [stems, setStems] = useState(false)
  const [preview, setPreview] = useState<(AudioPreview & { key: string }) | null>(null)
  const [saved, setSaved] = useState<MediaItem | null>(null)
  const videoEl = useRef<HTMLVideoElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const { width } = useSize(track)
  const [metaLength, setMetaLength] = useState(0)
  const length = v?.duration_s || metaLength || 0
  const pps = length ? width / length : 0

  // ?video= and ?audio= from a tile menu or the Library
  const fromAudio = useMediaItem(params.get('audio'))
  const used = useRef(new Set<string>())
  useEffect(() => {
    const vid = params.get('video')
    if (vid && !used.current.has(`v:${vid}`)) {
      used.current.add(`v:${vid}`)
      setVideo(vid)
    }
  }, [params])
  useEffect(() => {
    const a = fromAudio.data
    if (!a || used.current.has(`a:${a.id}`)) return
    used.current.add(`a:${a.id}`)
    if (useScoreDraft.getState().lanes.length < MAX_LANES && !useScoreDraft.getState().lanes.some((l) => l.mediaId === a.id)) addLanes([a])
  }, [fromAudio.data])

  const body = mixBody(draft)
  const bodyKey = JSON.stringify(body)
  const fresh = !!preview && preview.key === bodyKey
  const mixId = `mix:${draft.videoId ?? ''}`
  const pid = usePlayer((s) => s.id)
  const time = usePlayer((s) => (s.id === mixId ? s.time : 0))
  const playing = usePlayer((s) => s.id === mixId && s.playing)

  // the video follows the mix: one clock, the audio's
  useEffect(
    () =>
      usePlayer.subscribe((s) => {
        const el = videoEl.current
        if (!el) return
        if (s.id !== mixId) {
          if (!el.paused) el.pause()
          return
        }
        if (Math.abs(el.currentTime - s.time) > 0.3) el.currentTime = s.time
        if (s.playing && el.paused) Promise.resolve(el.play()).catch(() => {})
        else if (!s.playing && !el.paused) el.pause()
      }),
    [mixId],
  )
  const lastUrl = useRef<string | null>(null)
  useEffect(
    () => () => {
      if (usePlayer.getState().id?.startsWith('mix:')) pauseAudio()
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current)
    },
    [],
  )

  const render = useMutation({
    mutationFn: () => api.audio.mixPreview(body!),
    onSuccess: (p) => {
      const s = usePlayer.getState()
      const at = s.id === mixId ? s.time : 0
      if (s.id === mixId) pauseAudio()
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current)
      lastUrl.current = p.url
      setPreview({ ...p, key: bodyKey })
      // ready to play from where it was, never started by itself
      seekAudio(mixId, p.url, at)
      usePlayer.setState({ title: `Mix · ${v?.title ?? 'clip'}`, mediaId: null, peaks: false })
      announce('Mix preview ready. Press Play to hear it with the picture.')
    },
  })
  const save = useMutation({
    mutationFn: () => api.audio.mix({ ...body!, stems }),
    onSuccess: (res) => {
      upsertJob(qc, res.job)
      trackJobs([res.job], `Score a Clip · ${v?.title ?? 'video'}`, '/video/library')
      setSaved(res.item)
      announce('Mixing a new version of the video. It appears in the video Library when it’s ready.')
    },
  })

  const scrub = (t: number) => {
    if (preview) seekAudio(mixId, preview.url, clamp(t, 0, length))
    else if (videoEl.current) videoEl.current.currentTime = clamp(t, 0, length)
  }

  const lanes = draft.lanes
  const room = MAX_LANES - lanes.length
  const genLength = Math.max(1, Math.round(length))

  return (
    <main data-f6-region tabIndex={-1} aria-labelledby="score-title" className="h-full overflow-y-auto focus-visible:outline-none">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-3 py-4 md:px-6">
        <header className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 id="score-title" className="font-display text-title font-semibold">
              Score a Clip
            </h1>
            <p className="text-small text-studio-muted">Lay music, effects and voice under a video. The original video stays; the mix becomes a new version.</p>
          </div>
          <Button size="sm" onClick={() => setPickVideo(true)}>
            <Film aria-hidden />
            {v ? 'Change video' : 'Pick a video'}
          </Button>
        </header>

        {!draft.videoId ? (
          <EmptyState icon={<Clapperboard />} title="Pick a video to score" action={<Button variant="primary" onClick={() => setPickVideo(true)}>Pick a video</Button>}>
            Choose a clip from your Library. Its own sound comes along as the first lane.
          </EmptyState>
        ) : video.isError ? (
          <ErrorState error={video.error} onRetry={() => video.refetch()} />
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
              <div className="flex min-w-0 flex-col gap-2">
                <div className="relative aspect-video overflow-hidden rounded-[6px] border border-studio-border-strong bg-studio-raised">
                  {v?.media_url && (
                    <video
                      ref={videoEl}
                      src={v.media_url}
                      poster={v.thumb_url ?? undefined}
                      muted
                      playsInline
                      preload="metadata"
                      aria-label={`${v.title}, muted; the mix plays with it`}
                      onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setMetaLength(e.currentTarget.duration)}
                      className="size-full object-contain"
                    />
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!preview}
                    onClick={() => preview && togglePlay(mixId, preview.url, { title: `Mix · ${v?.title ?? 'clip'}` })}
                    aria-label={playing ? 'Pause the mix' : 'Play the mix with the video'}
                    className="flex size-9 shrink-0 items-center justify-center rounded-full bg-studio-accent text-studio-accent-fg shadow-card hover:bg-studio-accent-hover disabled:opacity-40"
                  >
                    {playing ? <Pause aria-hidden className="size-4" /> : <Play aria-hidden className="size-4 translate-x-px" />}
                  </button>
                  <input
                    type="range"
                    aria-label="Mix position"
                    min={0}
                    max={Math.max(1, length)}
                    step={0.1}
                    value={pid === mixId ? time : 0}
                    aria-valuetext={`${stamp(time)} of ${stamp(length)}`}
                    onChange={(e) => scrub(Number(e.target.value))}
                    className="h-1.5 min-w-0 flex-1 accent-studio-accent"
                  />
                  <span aria-hidden className="font-mono text-[11px] tabular-nums text-studio-muted">
                    {stamp(pid === mixId ? time : 0)} / {stamp(length)}
                  </span>
                </div>
                {!preview && <p className="text-[11px] text-studio-faint">Render a preview to hear the mix with the picture.</p>}
                {preview && !fresh && <p className="text-[11px] text-studio-warning" role="status">The mix changed since this preview. Render again to hear it.</p>}
              </div>

              <aside aria-label="Mix settings" className="flex flex-col gap-3 rounded-[6px] border border-studio-border bg-studio-panel p-3 text-small">
                <label className="flex flex-col gap-1">
                  <span className="section-label">Ducking</span>
                  <span className="flex items-center gap-2">
                    <input
                      type="range"
                      min={0}
                      max={24}
                      step={1}
                      value={draft.duckDb}
                      aria-label="Duck amount"
                      aria-valuetext={`${draft.duckDb} dB`}
                      onChange={(e) => useScoreDraft.setState({ duckDb: Number(e.target.value) })}
                      className="h-1.5 flex-1 accent-studio-accent"
                    />
                    <span className="w-12 text-right font-mono">{draft.duckDb} dB</span>
                  </span>
                  <span className="text-[11px] text-studio-faint">How far marked tracks dip while the original sound is talking.</span>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="section-label">Loudness</span>
                  <select value={draft.loudness ?? ''} onChange={(e) => useScoreDraft.setState({ loudness: (e.target.value || null) as LoudnessTarget | null })} className="h-8 rounded-[6px] border border-studio-border-strong bg-studio-raised px-2">
                    <option value="">As mixed</option>
                    {LOUDNESS.map((l) => (
                      <option key={l.value} value={l.value}>
                        {loudnessLabel(l.value)}
                      </option>
                    ))}
                  </select>
                </label>
                <Button onClick={() => render.mutate()} loading={render.isPending} disabled={!body || !v}>
                  <Headphones aria-hidden />
                  {preview ? 'Render preview again' : 'Render preview'}
                </Button>
                {render.isError && <ErrorState compact title="The preview didn't render" error={render.error} />}
                {preview?.lufsI != null && (
                  <p className="font-mono text-[11px] text-studio-muted">
                    Mix {minus(preview.lufsI, 1)} LUFS{preview.truePeakDb != null ? ` · ${minus(preview.truePeakDb, 1)} dBTP` : ''}
                  </p>
                )}
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={stems} onChange={(e) => setStems(e.target.checked)} />
                  Also export stems (a zip of each track)
                </label>
                <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!body || !v}>
                  Save as new video version
                </Button>
                {save.isError && <ErrorState compact title="Couldn't start the mix" error={save.error} />}
                {saved && (
                  <p role="status" className="text-small">
                    Mixing now.{' '}
                    <Link to="/video/library" className="font-medium underline underline-offset-2">
                      Open the video Library
                    </Link>{' '}
                    to see “{saved.title}” when it’s done.
                  </p>
                )}
              </aside>
            </div>

            <section aria-labelledby="timeline-title" className="rounded-[6px] border border-studio-border bg-studio-panel p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h2 id="timeline-title" className="section-label flex-1">
                  Timeline · {stamp(length)}
                </h2>
                <Button size="sm" disabled={room <= 0} onClick={() => setPickAudio(true)}>
                  <Plus aria-hidden />
                  Add from Library
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger className={buttonVariants({ size: 'sm' })} disabled={room <= 0 || !length}>
                    Generate at clip length
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {GENERATE.map((g) => (
                      <DropdownMenuItem key={g.kind} asChild>
                        <Link to={`${g.to}?duration=${genLength}&from=score`}>
                          <g.icon aria-hidden />
                          {g.label} · {stamp(genLength).replace(/\.0$/, '')}
                        </Link>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <ul aria-label="Lanes" className="flex flex-col">
                <li aria-label="Video" className="flex items-stretch gap-2 py-1.5">
                  <span className={cn('flex shrink-0 items-center gap-1.5 text-small font-medium', LABEL_W)}>
                    <Film aria-hidden className="size-3.5 text-studio-muted" />
                    Video
                  </span>
                  <div
                    ref={track}
                    aria-hidden
                    className="h-8 min-w-0 flex-1 rounded-[4px] border border-studio-border bg-studio-raised bg-repeat-x"
                    style={v?.thumb_url ? { backgroundImage: `url(${v.thumb_url})`, backgroundSize: 'auto 100%' } : undefined}
                  />
                </li>
                <li aria-label="Original sound" className="border-t border-studio-border py-1.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className={cn('shrink-0 text-small font-medium', LABEL_W)}>Original sound</span>
                    <label className="flex items-center gap-1 text-[11px]">
                      <input type="checkbox" checked={draft.original.keep} onChange={(e) => useScoreDraft.setState((s) => ({ original: { ...s.original, keep: e.target.checked } }))} />
                      Keep
                    </label>
                    <Num
                      label="Gain"
                      value={draft.original.gain_db}
                      onChange={(n) => useScoreDraft.setState((s) => ({ original: { ...s.original, gain_db: n } }))}
                      min={-24}
                      max={12}
                      step={0.5}
                      unit="dB"
                    />
                  </div>
                </li>
                {lanes.map((l) => (
                  <LaneRow key={l.key} lane={l} length={length} pps={pps} />
                ))}
              </ul>
              {lanes.length === 0 && <p className="border-t border-studio-border pt-2 text-small text-studio-faint">No tracks yet. Add up to {MAX_LANES} from your Library, or generate one the clip’s exact length.</p>}
              <p className="mt-2 text-[11px] text-studio-faint">Drag a track to move it, or focus it and use the arrow keys (Shift for whole seconds).</p>
            </section>
          </>
        )}
      </div>

      <MediaPicker
        open={pickVideo}
        onOpenChange={setPickVideo}
        kind="video"
        max={1}
        title="Pick a video to score"
        confirmLabel="Score this"
        onConfirm={([m]) => {
          if (!m) return
          setVideo(m.id)
          setPreview(null)
          setSaved(null)
        }}
      />
      <MediaPicker
        open={pickAudio}
        onOpenChange={setPickAudio}
        kind="audio"
        max={MAX_LANES}
        taken={lanes.map((l) => l.mediaId)}
        title="Add tracks"
        description={`Pick up to ${room} tracks to lay under the video.`}
        confirmLabel="Add"
        onConfirm={(items) => {
          addLanes(items)
          announce(`${items.length} track${items.length === 1 ? '' : 's'} added.`)
        }}
      />
    </main>
  )
}
