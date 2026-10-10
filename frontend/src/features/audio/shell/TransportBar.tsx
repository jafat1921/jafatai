import { useEffect, useRef } from 'react'
import { Link } from 'react-router'
import { Pause, Play, Repeat, Scissors, Volume2, VolumeX } from 'lucide-react'
import { usePeaks } from '@/hooks/useAudioEdit'
import { clock } from '@/lib/audio'
import { cn } from '@/lib/utils'
import { seekCurrent, setLoop, setVolume, toggleCurrent, usePlayer } from '../sharedAudio'
import { drawPeaks, prepare, token, useSize } from '../waveDraw'

const NUDGE_S = 5

function MiniWave({ mediaId, time, duration }: { mediaId: string | null; time: number; duration: number }) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const { width, height } = useSize(box)
  const peaks = usePeaks(mediaId, null, 400).data
  const length = peaks?.duration_s || duration

  useEffect(() => {
    const c = canvas.current
    if (!c || !width || !height) return
    const ctx = prepare(c, width, height)
    if (!ctx || !peaks) return
    const played = length ? (time / length) * width : 0
    drawPeaks(ctx, peaks.peaks, peaks.duration_s, 0, peaks.duration_s, width, height, token('--color-studio-border-strong', '#b9a27d'))
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, played, height)
    ctx.clip()
    drawPeaks(ctx, peaks.peaks, peaks.duration_s, 0, peaks.duration_s, width, height, token('--color-studio-accent', '#8a5a2b'))
    ctx.restore()
  }, [peaks, width, height, time, length])

  return (
    <div ref={box} aria-hidden className="relative h-7 w-28 shrink-0 overflow-hidden rounded-[4px] bg-studio-raised md:w-40">
      <canvas ref={canvas} className="size-full" />
    </div>
  )
}

/** The Audio room's one transport: whatever the shared player has loaded, from any page. */
export function TransportBar() {
  const { id, title, mediaId, peaks, playing, time, duration, volume, loop } = usePlayer()
  const loaded = !!id
  const length = duration || 0

  const onScrubKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const by: Record<string, number> = { ArrowLeft: -NUDGE_S, ArrowDown: -NUDGE_S, ArrowRight: NUDGE_S, ArrowUp: NUDGE_S }
    if (e.key in by) seekCurrent(time + by[e.key] * (e.shiftKey ? 2 : 1))
    else if (e.key === 'Home') seekCurrent(0)
    else if (e.key === 'End' && length) seekCurrent(length)
    else return
    e.preventDefault()
  }

  return (
    <div role="region" aria-label="Transport" className="flex h-12 shrink-0 items-center gap-2 border-t border-studio-border bg-studio-panel px-2 md:gap-3 md:px-3">
      <button
        type="button"
        onClick={toggleCurrent}
        disabled={!loaded}
        aria-label={loaded ? `${playing ? 'Pause' : 'Play'} ${title || 'track'}` : 'Play (nothing loaded)'}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-studio-accent text-studio-accent-fg shadow-card hover:bg-studio-accent-hover disabled:opacity-40"
      >
        {playing ? <Pause aria-hidden className="size-4" /> : <Play aria-hidden className="size-4 translate-x-px" />}
      </button>
      <div className="hidden min-w-0 max-w-48 flex-col sm:flex">
        <span className="truncate text-small font-medium" data-testid="transport-title">
          {title || (loaded ? 'Untitled' : 'Nothing playing')}
        </span>
        <span className="truncate text-[11px] text-studio-faint">{loaded ? 'Now playing' : 'Play a track from any page'}</span>
      </div>
      {peaks && mediaId && <MiniWave mediaId={mediaId} time={time} duration={length} />}
      <input
        type="range"
        aria-label="Position"
        min={0}
        max={Math.max(1, length)}
        step={0.1}
        value={Math.min(time, Math.max(1, length))}
        disabled={!loaded}
        aria-valuetext={`${clock(time)} of ${length ? clock(length) : 'unknown length'}`}
        onChange={(e) => seekCurrent(Number(e.target.value))}
        onKeyDown={onScrubKey}
        className="h-1.5 min-w-16 flex-1 cursor-pointer accent-studio-accent disabled:cursor-default"
      />
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-studio-muted" aria-hidden data-testid="transport-time">
        {clock(time)} / {length ? clock(length) : '–:––'}
      </span>
      <button
        type="button"
        onClick={() => setLoop(!loop)}
        aria-pressed={loop}
        aria-label="Loop"
        title="Loop"
        className={cn('flex size-8 shrink-0 items-center justify-center rounded-[4px]', loop ? 'bg-studio-accent-soft text-studio-text' : 'text-studio-muted hover:bg-studio-panel-hover')}
      >
        <Repeat aria-hidden className="size-4" />
      </button>
      <div className="hidden items-center gap-1 md:flex">
        <button
          type="button"
          onClick={() => setVolume(volume > 0 ? 0 : 1)}
          aria-label={volume > 0 ? 'Mute' : 'Unmute'}
          className="flex size-8 items-center justify-center rounded-[4px] text-studio-muted hover:bg-studio-panel-hover"
        >
          {volume > 0 ? <Volume2 aria-hidden className="size-4" /> : <VolumeX aria-hidden className="size-4" />}
        </button>
        <input
          type="range"
          aria-label="Volume"
          min={0}
          max={100}
          step={5}
          value={Math.round(volume * 100)}
          aria-valuetext={`${Math.round(volume * 100)}%`}
          onChange={(e) => setVolume(Number(e.target.value) / 100)}
          className="h-1.5 w-20 cursor-pointer accent-studio-accent"
        />
      </div>
      {mediaId ? (
        <Link
          to={`/audio/edit/${mediaId}`}
          aria-label="Open in Editor"
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-[4px] border border-studio-border-strong px-2 text-small hover:bg-studio-panel-hover"
        >
          <Scissors aria-hidden className="size-3.5" />
          <span aria-hidden className="hidden lg:inline">
            Open in Editor
          </span>
        </Link>
      ) : null}
    </div>
  )
}
