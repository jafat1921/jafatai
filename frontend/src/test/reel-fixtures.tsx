import { vi } from 'vitest'
import type { MezzanineStatus, Reel, ReelClip } from '@/lib/types'
import { PID, type Call } from './storyboard-fixtures'

export const clip = (id: string, extra: Partial<ReelClip> = {}): ReelClip => ({
  id,
  shot_id: `shot-${id}`,
  scene_id: 'a',
  order: 0,
  generation_id: `take-${id}`,
  media_url: `/media/${id}.mp4`,
  source_duration_s: 8,
  trim_in_s: 0,
  trim_out_s: 0,
  duration_s: 8,
  transition_in: 'cut',
  transition_s: 0.5,
  enabled: true,
  changed: false,
  ...extra,
})

/** One inner array per scene; scene ids are a, b, c… */
export function reelOf(scenes: ReelClip[][], status: MezzanineStatus = 'fresh', extra: Partial<Reel> = {}): Reel {
  const built = scenes.map((clips, i) => {
    const sid = String.fromCharCode(97 + i)
    const own = clips.map((c, k) => ({ ...c, scene_id: sid, order: k }))
    return {
      scene_id: sid,
      heading: `SCENE ${sid.toUpperCase()}`,
      order: i,
      duration_s: own.reduce((t, c) => t + c.duration_s, 0),
      mezzanine: { status },
      clips: own,
    }
  })
  return {
    id: 'reel1',
    project_id: PID,
    duration_s: built.reduce((t, s) => t + s.duration_s, 0),
    scenes: built,
    missing: [],
    last_render: null,
    ...extra,
  }
}

/** fetch stub for the Reel: GET /reel returns the reel, PATCH /reel-clips/:id echoes the merged clip. */
export function mockReelApi(reel: Reel) {
  const calls: Call[] = []
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input).replace(/^\/api/, '').split('?')[0]
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, path, body })
      if (path === `/projects/${PID}/reel` && method === 'GET') return json(reel)
      const m = path.match(/^\/reel-clips\/([^/]+)$/)
      if (m && method === 'PATCH') {
        const c = reel.scenes.flatMap((s) => s.clips).find((x) => x.id === m[1])!
        return json({ ...c, ...(body as object) })
      }
      if (path.endsWith('/reel/reorder')) return json(reel)
      if (method === 'GET') return json([])
      return json({ id: 'job1', type: 'reel_assemble', status: 'queued', progress: 0, message: '', attempts: 0, created_at: '' })
    }),
  )
  return calls
}
