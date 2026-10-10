import { AudioLines, Pause, Play } from 'lucide-react'
import { clock } from '@/lib/audio'
import { cn } from '@/lib/utils'
import { seekAudio, togglePlay, useTrack } from './sharedAudio'

export const SEEK_STEP_S = 5

interface Props {
  id: string
  src: string
  title: string
  wave?: string | null
  durationS?: number | null
  className?: string
}

/** The lightbox player: big waveform, play/pause, a scrubber. Never starts by itself. */
export function AudioPlayer({ id, src, title, wave, durationS, className }: Props) {
  const track = useTrack(id)
  const length = durationS || track.duration || 0
  const time = Math.min(track.time, length || track.time)
  const pct = length ? (time / length) * 100 : 0
  const seek = (t: number) => seekAudio(id, src, length ? Math.min(length, Math.max(0, t)) : Math.max(0, t))

  const onScrubKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const by: Record<string, number> = { ArrowLeft: -SEEK_STEP_S, ArrowDown: -SEEK_STEP_S, ArrowRight: SEEK_STEP_S, ArrowUp: SEEK_STEP_S }
    if (e.key in by) seek(time + by[e.key])
    else if (e.key === 'Home') seek(0)
    else if (e.key === 'End' && length) seek(length)
    else if (e.key === ' ') togglePlay(id, src)
    else return
    // the native range would move by one step as well, and the lightbox would browse
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div className={cn('flex w-full max-w-3xl flex-col gap-4 text-studio-on-dark', className)}>
      <div role="img" aria-label={`Waveform, ${length ? clock(length) : 'length unknown'}`} className="relative aspect-[5/1] w-full overflow-hidden rounded-[6px] ring-1 ring-studio-gold/30">
        {wave ? <img src={wave} alt="" className="size-full object-fill" /> : <AudioLines aria-hidden className="m-auto size-full p-8 text-studio-on-dark-muted" />}
        <span aria-hidden className={cn('pointer-events-none absolute inset-y-0 left-0 bg-studio-gold/15', pct > 0 && 'border-r-2 border-studio-gold')} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => togglePlay(id, src)}
          aria-label={`${track.playing ? 'Pause' : 'Play'} ${title}`}
          className="flex size-12 shrink-0 items-center justify-center rounded-full bg-studio-gold text-studio-darkroom shadow-card hover:brightness-110"
        >
          {track.playing ? <Pause aria-hidden className="size-5" /> : <Play aria-hidden className="size-5 translate-x-px" />}
        </button>
        <input
          type="range"
          aria-label="Seek"
          min={0}
          max={Math.max(1, Math.round(length))}
          step={1}
          value={Math.round(time)}
          aria-valuetext={`${clock(time)} of ${length ? clock(length) : 'unknown length'}`}
          onChange={(e) => seek(Number(e.target.value))}
          onKeyDown={onScrubKey}
          className="h-2 min-w-0 flex-1 cursor-pointer accent-studio-gold"
        />
        <span className="shrink-0 font-mono text-small tabular-nums" aria-hidden>
          {clock(time)} / {length ? clock(length) : '–:––'}
        </span>
      </div>
    </div>
  )
}
