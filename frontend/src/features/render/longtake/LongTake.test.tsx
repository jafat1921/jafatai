import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Beat, Generation, TakeChunk } from '@/lib/types'
import { useWorkspace } from '@/stores/workspace'
import { frame, mockApi, renderStage, scene, shot, PID } from '@/test/storyboard-fixtures'
import { RenderInspector } from '../RenderInspector'

const beats: Beat[] = [
  { t_start: 0, t_end: 8, prompt: 'The diver descends', source: 'ai', locked: false },
  { t_start: 7, t_end: 15, prompt: 'She turns', source: 'ai', locked: false },
  { t_start: 14, t_end: 22, prompt: 'The reef opens up', source: 'user', locked: true },
]
const statuses: TakeChunk['status'][] = ['done', 'done', 'done', 'generating', 'queued', 'queued', 'queued', 'failed']
const chunks: TakeChunk[] = statuses.map((status, idx) => ({ idx, t_start: idx * 7, t_end: idx * 7 + 8, frames: 193, status }))

const long = shot('s1', 'a', 0, {
  shot_type: 'long_take',
  duration_s: 22,
  beats,
  start_frame: frame('f1', 'keyframe_start', 's1', 'approved'),
  status: 'take_ready',
})
const take = (params: Record<string, unknown>, status: Generation['status'] = 'ready'): Generation => ({
  ...frame('t1', 'take', 's1', status),
  media_url: '/media/t1.mp4',
  params,
})

beforeEach(() =>
  useWorkspace.setState({
    selectedShot: { [PID]: { shotId: 's1', frame: 'start' } },
    selectedTake: {},
    selectedScene: { [PID]: 'a' },
  }),
)
afterEach(() => vi.unstubAllGlobals())

describe('Long-take panel', () => {
  it('lays beats on the timeline and locks a beat when it is edited', async () => {
    const calls = mockApi([long])
    renderStage(<RenderInspector />, { scenes: [scene('a', 0)], shots: [long], stage: 'render' })
    const user = userEvent.setup()

    const bar = screen.getByRole('group', { name: 'Beats of shot 1.1' })
    expect(within(bar).getAllByRole('button')).toHaveLength(3)
    expect(within(bar).getByRole('button', { name: /^Beat 3, 14 s to 22 s, locked/ })).toBeInTheDocument()
    expect(screen.getByText(/END 22 s/)).toBeInTheDocument()

    await user.click(within(bar).getByRole('button', { name: /^Beat 2/ }))
    const text = screen.getByRole('textbox', { name: /Beat 2 · 7 s–15 s/ })
    await user.clear(text)
    await user.type(text, 'She turns toward the light')
    await user.tab()

    const patch = calls.find((c) => c.method === 'PATCH' && c.path === '/shots/s1')
    expect(patch?.body).toEqual({
      beats: [beats[0], { ...beats[1], prompt: 'She turns toward the light', source: 'user', locked: true }, beats[2]],
    })
  })

  it('asks the AI for beats', async () => {
    const calls = mockApi([long])
    renderStage(<RenderInspector />, { scenes: [scene('a', 0)], shots: [long], stage: 'render' })
    await userEvent.setup().click(screen.getByRole('button', { name: /rewrite beats with ai/i }))
    expect(calls).toContainEqual({ method: 'POST', path: '/shots/s1/ai/beats', body: {} })
  })

  it('shows each chunk state and says how many chunks a re-roll redoes', async () => {
    const done = chunks.map((c) => ({ ...c, status: 'done' as const }))
    const calls = mockApi([long])
    renderStage(<RenderInspector />, {
      scenes: [scene('a', 0)],
      shots: [long],
      stage: 'render',
      takes: { s1: [take({ chunks: done })] },
    })
    const user = userEvent.setup()
    const strip = screen.getByRole('list', { name: 'Chunks of this take' })
    expect(within(strip).getAllByRole('button')).toHaveLength(8)
    expect(screen.getByText('8 of 8 done')).toBeInTheDocument()

    await user.click(within(strip).getByRole('button', { name: /^Chunk 3,/ }))
    await user.click(screen.getByRole('button', { name: 'Re-roll from chunk 3' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('This regenerates 6 chunks of 8 (chunk 3 to 8)')
    await user.click(within(dialog).getByRole('button', { name: 'Re-roll 6 chunks' }))
    expect(calls).toContainEqual({ method: 'POST', path: '/generations/t1/chunks/2/regenerate', body: {} })
  })

  it('labels chunk states with text, not just colour, and blocks re-rolls mid-render', () => {
    mockApi([long])
    renderStage(<RenderInspector />, {
      scenes: [scene('a', 0)],
      shots: [long],
      stage: 'render',
      takes: { s1: [take({ chunks }, 'generating')] },
    })
    const strip = screen.getByRole('list', { name: 'Chunks of this take' })
    expect(within(strip).getByRole('button', { name: /^Chunk 1,.*Done$/ })).toBeInTheDocument()
    expect(within(strip).getByRole('button', { name: /^Chunk 4,.*Generating$/ })).toBeInTheDocument()
    expect(within(strip).getByRole('button', { name: /^Chunk 5,.*Waiting$/ })).toBeInTheDocument()
    expect(within(strip).getByRole('button', { name: /^Chunk 8,.*Failed$/ })).toBeInTheDocument()
    expect(screen.getByText('3 of 8 done · 1 generating · 1 failed')).toBeInTheDocument()
    // the failed chunk is picked by default; another is still generating, so no re-roll yet
    expect(screen.getByRole('button', { name: 'Re-roll from chunk 8' })).toBeDisabled()
  })
})
