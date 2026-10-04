import { Clapperboard, Film, LayoutGrid, MonitorPlay, ScrollText, Users } from 'lucide-react'

export const STAGES = [
  { id: 'script', label: 'Script', icon: ScrollText },
  { id: 'cast', label: 'Cast & World', icon: Users },
  { id: 'storyboard', label: 'Storyboard', icon: LayoutGrid },
  { id: 'render', label: 'Render', icon: Clapperboard },
  { id: 'reel', label: 'Reel', icon: Film },
  { id: 'output', label: 'Output', icon: MonitorPlay },
] as const

export type StageId = (typeof STAGES)[number]['id']

export const isStage = (s: string | undefined): s is StageId => STAGES.some((x) => x.id === s)
