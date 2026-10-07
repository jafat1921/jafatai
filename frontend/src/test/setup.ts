import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => cleanup())

// jsdom has no ResizeObserver; Radix ScrollArea and friends only need it to exist
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

// per-browser and per-tab state must not leak between tests
afterEach(async () => {
  try {
    window.localStorage.clear()
  } catch {
    /* jsdom without storage */
  }
  const [{ useSessions }, { useToasts, useMyJobs }, { useFavourites }, { useGenerateInto }] = await Promise.all([
    import('@/stores/sessions'),
    import('@/stores/toasts'),
    import('@/stores/favourites'),
    import('@/stores/generateInto'),
  ])
  useSessions.setState({ requests: [] })
  useToasts.setState({ toasts: [] })
  useMyJobs.setState({ jobs: {}, done: [] })
  useFavourites.setState({ ids: [], mode: 'pending' })
  useGenerateInto.setState({ into: { image: null, video: null } })
})
