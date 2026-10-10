import { create } from 'zustand'

// One <audio> element for the whole app, so starting a track stops whatever else was playing.
// Tiles and the lightbox only read this store; nothing here ever starts without a click.

interface PlayerState {
  id: string | null
  playing: boolean
  time: number
  duration: number
}

export const usePlayer = create<PlayerState>(() => ({ id: null, playing: false, time: 0, duration: 0 }))

let el: HTMLAudioElement | null = null

function element() {
  if (el) return el
  const a = document.createElement('audio')
  a.preload = 'metadata'
  const set = usePlayer.setState
  a.addEventListener('timeupdate', () => set({ time: a.currentTime }))
  a.addEventListener('durationchange', () => Number.isFinite(a.duration) && set({ duration: a.duration }))
  // read paused rather than trusting the event: the pause from switching tracks arrives after the new play()
  const sync = () => set({ playing: !a.paused })
  a.addEventListener('play', sync)
  a.addEventListener('pause', sync)
  a.addEventListener('ended', () => set({ playing: false, time: 0 }))
  el = a
  return a
}

function load(id: string, src: string) {
  const a = element()
  if (usePlayer.getState().id !== id) {
    a.pause()
    a.src = src
    usePlayer.setState({ id, playing: false, time: 0, duration: 0 })
  }
  return a
}

export function togglePlay(id: string, src: string) {
  const s = usePlayer.getState()
  if (s.id === id && s.playing) return pauseAudio()
  const a = load(id, src)
  usePlayer.setState({ playing: true })
  // a refused play (autoplay rules, a bad file) leaves the button saying Play
  Promise.resolve(a.play()).catch(() => usePlayer.setState({ playing: false }))
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
  usePlayer.setState({ id: null, playing: false, time: 0, duration: 0 })
}
