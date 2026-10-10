import { forwardRef, useEffect, useEffectEvent, useImperativeHandle, useRef } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { Dub } from '@/lib/dub'
import { cueAudio, pauseAudio, seekAudio, usePlayer } from '../sharedAudio'

export type Listen = 'original' | 'dub'

export interface PlayerHandle {
  seek: (t: number) => void
  toggle: () => void
  nudge: (by: number) => void
  time: () => number
}

interface Props {
  dub: Dub
  lang: string
  langName: string
  listen: Listen
  onListen: (l: Listen) => void
  onTime: (t: number) => void
}

const DRIFT_S = 0.25

/**
 * One picture, two soundtracks. "Original" is the video's own sound; "Dub" mutes it and plays the
 * language's mixed track through the shared player, slaved to the video so the playhead never jumps.
 */
export const DubPlayer = forwardRef<PlayerHandle, Props>(function DubPlayer({ dub, lang, langName, listen, onListen, onTime }, ref) {
  const video = useRef<HTMLVideoElement>(null)
  const track = dub.tracks[lang]
  const dubbing = listen === 'dub' && !!track?.url
  const trackId = `dub:${dub.id}:${lang}`
  const meta = { title: `${dub.title} · ${langName} dub`, mediaId: track?.media_id ?? null }

  const follow = (play: boolean) => {
    const v = video.current
    if (!v || !track?.url) return
    cueAudio(trackId, track.url, meta, v.currentTime, play)
  }

  useImperativeHandle(ref, () => ({
    seek: (t) => {
      const v = video.current
      if (!v) return
      v.currentTime = Math.max(0, t)
      onTime(v.currentTime)
    },
    toggle: () => {
      const v = video.current
      if (!v) return
      if (v.paused) void Promise.resolve(v.play()).catch(() => {})
      else v.pause()
    },
    nudge: (by) => {
      const v = video.current
      if (!v) return
      v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + by))
      onTime(v.currentTime)
    },
    time: () => video.current?.currentTime ?? 0,
  }))

  // switching A/B keeps the playhead: the dub picks up where the picture is, or lets go of it
  const switchTo = useEffectEvent((on: boolean) => {
    const v = video.current
    if (!v) return
    v.muted = on
    if (on) follow(!v.paused)
    else if (usePlayer.getState().id === trackId) pauseAudio()
  })
  useEffect(() => switchTo(dubbing), [dubbing, trackId, track?.url])

  useEffect(() => () => {
    if (usePlayer.getState().id?.startsWith(`dub:${dub.id}:`)) pauseAudio()
  }, [dub.id])

  return (
    <div className="flex flex-col gap-2">
      <video
        ref={video}
        src={dub.video_url ?? undefined}
        controls
        playsInline
        preload="metadata"
        aria-label={`${dub.title}: ${dubbing ? `${langName} dub` : 'original sound'}`}
        className="aspect-video w-full rounded-[6px] bg-black object-contain"
        onPlay={() => dubbing && follow(true)}
        onPause={() => dubbing && pauseAudio()}
        onSeeked={() => {
          const v = video.current
          if (dubbing && v && track?.url) seekAudio(trackId, track.url, v.currentTime)
        }}
        onTimeUpdate={() => {
          const v = video.current
          if (!v) return
          onTime(v.currentTime)
          if (!dubbing || !track?.url) return
          const p = usePlayer.getState()
          if (p.id === trackId && Math.abs(p.time - v.currentTime) > DRIFT_S) seekAudio(trackId, track.url, v.currentTime)
        }}
      />
      <div className="flex flex-wrap items-center gap-2 text-small">
        <span className="section-label" id={`ab-${dub.id}`}>
          Listen
        </span>
        <ToggleGroup type="single" aria-labelledby={`ab-${dub.id}`} value={dubbing ? 'dub' : 'original'} onValueChange={(v) => v && onListen(v as Listen)}>
          <ToggleGroupItem value="original" className="px-3 text-small">
            Original
          </ToggleGroupItem>
          <ToggleGroupItem value="dub" disabled={!track?.url} className="px-3 text-small">
            Dub · {langName}
          </ToggleGroupItem>
        </ToggleGroup>
        {!track?.url && <span className="text-studio-muted">The {langName} dub plays here once it's mixed.</span>}
      </div>
    </div>
  )
})
