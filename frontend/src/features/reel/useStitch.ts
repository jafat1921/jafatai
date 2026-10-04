import { useMemo, useState } from 'react'
import { resolveSelection, stitchScenes, type StitchMode } from '@/lib/stitch'
import type { Reel } from '@/lib/types'

/** Stitch selection for the Reel. `from`/`to` stay null until touched, so new scenes join the default range. */
export function useStitch(reel: Reel | undefined) {
  const scenes = useMemo(() => (reel ? stitchScenes(reel) : []), [reel])
  const [mode, setMode] = useState<StitchMode>('range')
  const [from, setFrom] = useState<number | null>(null)
  const [to, setTo] = useState<number | null>(null)
  const [picked, setPicked] = useState<string[] | null>(null)

  const last = scenes.length || 1
  const state = {
    mode,
    from: Math.min(from ?? 1, last),
    to: Math.min(to ?? last, last),
    picked: picked ?? scenes.filter((s) => s.ready).map((s) => s.scene.scene_id),
  }
  const selection = resolveSelection(scenes, state)

  return {
    scenes,
    state,
    selection,
    setMode,
    setFrom: (n: number) => {
      setFrom(n)
      if (n > state.to) setTo(n)
    },
    setTo: (n: number) => {
      setTo(n)
      if (n < state.from) setFrom(n)
    },
    togglePick: (id: string) =>
      setPicked(state.picked.includes(id) ? state.picked.filter((x) => x !== id) : [...state.picked, id]),
    setPicked,
    inSelection: new Set(selection.included.map((s) => s.scene.scene_id)),
  }
}

export type Stitch = ReturnType<typeof useStitch>
