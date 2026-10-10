import { create } from 'zustand'
import type { TimeRegion } from '@/lib/types'

// One <audio> element for the whole app, so starting a track stops whatever else was playing.
// Tiles and the lightbox only read this store; nothing here ever starts without a click.

export interface TrackMeta {
  title?: string
  // the Library item behind it: the transport draws its peaks and offers "Open in Editor"
  mediaId?: string | null
  // false for rendered previews, whose peaks the server doesn't have
  peaks?: boolean
}

interface PlayerState {
  id: string | null
  src: string | null
  title: string
  mediaId: string | null
  peaks: boolean
  playing: boolean
  time: number
  duration: number
  volume: number
  loop: boolean
  // per-track playback gain, for level-matched A/B; multiplied into the volume
  gain: number
  // the editor's loop region: playback wraps inside it while loop is on
  region: TimeRegion | null
}

const SILENT = { id: null, src: null, title: '', mediaId: null, peaks: false, playing: false, time: 0, duration: 0 }

export const usePlayer = create<PlayerState>(() => ({ ...SILENT, volume: 1, loop: false, gain: 1, region: null }))

let el: HTMLAudioElement | null = null

const applyVolume = (a: HTMLAudioElement) => {
  const { volume, gain } = usePlayer.getState()
  a.volume = Math.max(0, Math.min(1, volume * gain))
}

function element() {
  if (el) return el
  const a = document.createElement('audio')
  a.preload = 'metadata'
  const set = usePlayer.setState
  a.addEventListener('timeupdate', () => {
    const { loop, region } = usePlayer.getState()
    if (loop && region && region.end - region.start > 0.05 && a.currentTime >= region.end) {
      a.currentTime = region.start
      set({ time: region.start })
      return
    }
    set({ time: a.currentTime })
  })
  a.addEventListener('durationchange', () => Number.isFinite(a.duration) && set({ duration: a.duration }))
  // read paused rather than trusting the event: the pause from switching tracks arrives after the new play()
  const sync = () => set({ playing: !a.paused })
  a.addEventListener('play', sync)
  a.addEventListener('pause', sync)
  a.addEventListener('ended', () => {
    const { loop, region } = usePlayer.getState()
    if (loop) {
      a.currentTime = region?.start ?? 0
      Promise.resolve(a.play()).catch(() => set({ playing: false }))
      return
    }
    set({ playing: false, time: 0 })
  })
  applyVolume(a)
  el = a
  return a
}

function load(id: string, src: string, meta?: TrackMeta) {
  const a = element()
  const s = usePlayer.getState()
  if (s.id !== id || s.src !== src) {
    a.pause()
    a.src = src
    usePlayer.setState({ id, src, playing: false, time: 0, duration: 0, region: s.id === id ? s.region : null })
  }
  if (meta) usePlayer.setState({ title: meta.title ?? usePlayer.getState().title, mediaId: meta.mediaId ?? null, peaks: meta.peaks ?? !!meta.mediaId })
  else if (s.id !== id) usePlayer.setState({ title: '', mediaId: null, peaks: false })
  return a
}

function start(a: HTMLAudioElement) {
  usePlayer.setState({ playing: true })
  // a refused play (autoplay rules, a bad file) leaves the button saying Play
  Promise.resolve(a.play()).catch(() => usePlayer.setState({ playing: false }))
}

export function togglePlay(id: string, src: string, meta?: TrackMeta) {
  const s = usePlayer.getState()
  if (s.id === id && s.src === src && s.playing) return pauseAudio()
  start(load(id, src, meta))
}

/** Switch to a track at a given moment, playing or not: A/B and fresh previews keep the playhead. */
export function cueAudio(id: string, src: string, meta: TrackMeta | undefined, at: number, play: boolean) {
  const a = load(id, src, meta)
  seekAudio(id, src, at)
  if (play) start(a)
  else a.pause()
}

export function pauseAudio() {
  el?.pause()
  usePlayer.setState({ playing: false })
}

export function seekAudio(id: string, src: string, t: number) {
  const a = load(id, src)
  const max = usePlayer.getState().duration || Number.POSITIVE_INFINITY
  const next = Math.max(0, Math.min(t, max))
  try {
    a.currentTime = next
  } catch {
    // no metadata yet; the store still moves so the scrubber answers the key
  }
  usePlayer.setState({ time: next })
}

/** Seek whatever is loaded, for the transport bar that doesn't know the track. */
export function seekCurrent(t: number) {
  const { id, src } = usePlayer.getState()
  if (id && src) seekAudio(id, src, t)
}

export function toggleCurrent() {
  const { id, src } = usePlayer.getState()
  if (id && src) togglePlay(id, src)
}

export function setVolume(v: number) {
  usePlayer.setState({ volume: Math.max(0, Math.min(1, v)) })
  if (el) applyVolume(el)
}

export function setGain(g: number) {
  usePlayer.setState({ gain: Math.max(0, g) })
  if (el) applyVolume(el)
}

export function setLoop(on: boolean) {
  usePlayer.setState({ loop: on })
}

export function setLoopRegion(r: TimeRegion | null) {
  usePlayer.setState({ region: r })
}

/** Playback for one item: whether it's the one playing, and where it is. */
export function useTrack(id: string) {
  const mine = usePlayer((s) => s.id === id)
  const playing = usePlayer((s) => s.id === id && s.playing)
  const time = usePlayer((s) => (s.id === id ? s.time : 0))
  const duration = usePlayer((s) => (s.id === id ? s.duration : 0))
  return { mine, playing, time, duration }
}

// tests start each case from silence
export function resetPlayer() {
  el?.pause()
  el = null
  usePlayer.setState({ ...SILENT, volume: 1, loop: false, gain: 1, region: null })
}
