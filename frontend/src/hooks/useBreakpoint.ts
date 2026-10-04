import { useSyncExternalStore } from 'react'

// design-system §2: wide ≥1440 (four columns), medium 1280–1439 (Scenes folds into Library),
// compact 768–1279 (Inspector becomes a slide-over), mobile <768 (review only).
export type Breakpoint = 'mobile' | 'compact' | 'medium' | 'wide'

const queries = {
  wide: '(min-width: 1440px)',
  medium: '(min-width: 1280px)',
  compact: '(min-width: 768px)',
}

function read(): Breakpoint {
  if (typeof window === 'undefined' || !window.matchMedia) return 'wide'
  if (window.matchMedia(queries.wide).matches) return 'wide'
  if (window.matchMedia(queries.medium).matches) return 'medium'
  if (window.matchMedia(queries.compact).matches) return 'compact'
  return 'mobile'
}

function subscribe(cb: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const lists = Object.values(queries).map((q) => window.matchMedia(q))
  lists.forEach((l) => l.addEventListener('change', cb))
  return () => lists.forEach((l) => l.removeEventListener('change', cb))
}

export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, read, () => 'wide')
}
