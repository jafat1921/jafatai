import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { qk } from '@/hooks/keys'
import type { Job, Shot } from '@/lib/types'
import { useWorkspace } from '@/stores/workspace'
import { frame, mockApi, renderStage, scene, shot, PID } from '@/test/storyboard-fixtures'
import { StoryboardCanvas } from './StoryboardCanvas'

const T = '2026-10-04T00:00:00Z'
const pending = [scene('a', 0, { shots_review: 'pending' })]
const plan = () => [
  shot('s1', 'a', 1, { description: 'Maya kneels. She checks the valve.', duration_s: 6 }),
  shot('s2', 'a', 2, { description: 'She stands.', duration_s: 4 }),
  shot('s3', 'a', 3, { description: 'Tomas waves.', duration_s: 3 }),
]

beforeEach(() => {
  useWorkspace.setState({ selectedShot: {}, storyboardView: { [PID]: 'shots' }, selectedScene: { [PID]: 'a' } })
})
afterEach(() => vi.unstubAllGlobals())

const table = () => screen.getByRole('table', { name: /planned shots of scene 1/i })
const posts = (calls: { method: string; path: string; body: unknown }[], path: string) =>
  calls.filter((c) => c.method === 'POST' && c.path === path)

describe('Shot-list review gate', () => {
  it('shows the table instead of frames, with the locked header and no frame buttons', () => {
    mockApi(plan())
    renderStage(<StoryboardCanvas />, { scenes: pending, shots: plan() })
    expect(within(table()).getAllByRole('row')).toHaveLength(4)
    expect(screen.getByRole('group', { name: /locked for every frame/i })).toHaveTextContent('16:9')
    expect(screen.queryByRole('button', { name: /^START frame/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /generate all frames/i })).not.toBeInTheDocument()
    // three cut shots: START and END each
    expect(screen.getByRole('button', { name: /approve shot list & generate 6 frames/i })).toBeInTheDocument()
  })

  it('edits a description inline and saves on blur', async () => {
    const calls = mockApi(plan())
    renderStage(<StoryboardCanvas />, { scenes: pending, shots: plan() })
    const user = userEvent.setup()
    const box = screen.getByRole('textbox', { name: 'Description of 1.2' })
    await user.clear(box)
    await user.type(box, 'She rises fast.')
    await user.tab()
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: '/shots/s2', body: { description: 'She rises fast.' } }))
  })

  it('reorders with the keyboard on the grip and keeps focus on it', async () => {
    const moved = plan().map((s) => ({ ...s, order: { s1: 2, s2: 1, s3: 3 }[s.id]! }))
    const calls = mockApi(plan(), (method, path) => (method === 'GET' && path === `/projects/${PID}/shots` ? moved : undefined))
    renderStage(<StoryboardCanvas />, { scenes: pending, shots: plan() })
    const user = userEvent.setup()
    screen.getByRole('button', { name: 'Move shot 1.1' }).focus()
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(posts(calls, '/scenes/a/shots/reorder')).toEqual([
      { method: 'POST', path: '/scenes/a/shots/reorder', body: { shot_ids: ['s2', 's1', 's3'] } },
    ]))
    // the moved shot is now 1.2, and still focused
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-move-handle', 's1'))
  })

  it('merges neighbouring shots only, after a confirm', async () => {
    const calls = mockApi(plan())
    renderStage(<StoryboardCanvas />, { scenes: pending, shots: plan() })
    const user = userEvent.setup()
    const merge = screen.getByRole('button', { name: /merge selected/i })
    await user.click(screen.getByRole('checkbox', { name: 'Select shot 1.1' }))
    await user.click(screen.getByRole('checkbox', { name: 'Select shot 1.3' }))
    expect(merge).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: 'Select shot 1.3' }))
    await user.click(screen.getByRole('checkbox', { name: 'Select shot 1.2' }))
    expect(merge).toBeEnabled()
    await user.click(merge)
    expect(screen.getByRole('alertdialog')).toHaveTextContent('one 10 s shot')
    await user.click(screen.getByRole('button', { name: 'Merge shots' }))
    await waitFor(() => expect(posts(calls, '/shots/merge')[0]?.body).toEqual({ shot_ids: ['s1', 's2'] }))
  })

  it('splits a shot at the chosen point, with editable halves', async () => {
    const calls = mockApi(plan())
    renderStage(<StoryboardCanvas />, { scenes: pending, shots: plan() })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Split shot 1.1' }))
    const dialog = screen.getByRole('dialog', { name: /split shot 1\.1/i })
    expect(within(dialog).getByRole('textbox', { name: 'First shot' })).toHaveValue('Maya kneels.')
    expect(within(dialog).getByRole('textbox', { name: 'Second shot' })).toHaveValue('She checks the valve.')
    expect(dialog).toHaveTextContent('3 s + 3 s')
    await user.type(within(dialog).getByRole('textbox', { name: 'Second shot' }), ' Slowly.')
    await user.click(within(dialog).getByRole('button', { name: 'Split' }))
    await waitFor(() =>
      expect(posts(calls, '/shots/s1/split')[0]?.body).toEqual({
        at_ratio: 0.5,
        descriptions: ['Maya kneels.', 'She checks the valve. Slowly.'],
      }),
    )
  })

  it('approves the list, sending the image model, and then queues frames', async () => {
    const job: Job = { id: 'j1', type: 'generate', status: 'queued', progress: 0, message: '', attempts: 0, created_at: T }
    const calls = mockApi(plan(), (method, path) =>
      method === 'POST' && path === '/scenes/a/shots-review/approve' ? { scene: scene('a', 0), jobs: [job] } : undefined,
    )
    renderStage(<StoryboardCanvas />, { scenes: pending, shots: plan() })
    await userEvent.setup().click(screen.getByRole('button', { name: /approve shot list/i }))
    await waitFor(() => expect(posts(calls, '/scenes/a/shots-review/approve')).toHaveLength(1))
    expect(posts(calls, '/scenes/a/shots-review/approve')[0].body).toMatchObject({ generate_frames: true })
  })

  it('scenes view points at the pending list instead of empty frames', async () => {
    mockApi(plan())
    useWorkspace.setState({ storyboardView: { [PID]: 'scenes' } })
    renderStage(<StoryboardCanvas />, { scenes: pending, shots: plan() })
    expect(screen.getByText(/shot list waiting for review · 3 shots/i)).toBeInTheDocument()
    expect(screen.getByText(/1 scene has a shot list waiting for review/i)).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: /^review shot list$/i }))
    expect(useWorkspace.getState().storyboardView[PID]).toBe('shots')
    expect(table()).toBeInTheDocument()
  })
})

describe('Shot cards', () => {
  const scenes = [scene('a', 0)]
  const withVersions = (): Shot[] => [
    shot('s1', 'a', 1, {
      start_frame: frame('f1', 'keyframe_start', 's1', 'approved'),
      end_frame: { ...frame('e2', 'keyframe_end', 's1', 'approved'), version: 2 },
    }),
    shot('s2', 'a', 2, { seam_in: 'continue' }),
  ]

  it('flips END versions in place and makes one current', async () => {
    const calls = mockApi(withVersions())
    const versions = [1, 2, 3].map((v) => ({ ...frame(`e${v}`, 'keyframe_end', 's1', v === 2 ? 'approved' : 'ready'), version: v }))
    renderStage(<StoryboardCanvas />, {
      scenes,
      shots: withVersions(),
      seed: (qc) => qc.setQueryData(qk.generations('shot', 's1', 'keyframe_end', false), versions),
    })
    const user = userEvent.setup()
    const card = screen.getByRole('article', { name: 'Shot 1.1' })
    expect(within(card).getByText('v2/3')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Previous version of END frame of 1.1' }))
    expect(within(card).getByText('v1/3')).toBeInTheDocument()
    expect(within(within(card).getByRole('button', { name: /^END frame/ })).getByRole('img')).toHaveAttribute('src', '/media/e1.png')
    await user.click(within(card).getByRole('button', { name: 'Use v1' }))
    await waitFor(() => expect(calls.map((c) => `${c.method} ${c.path}`)).toContain('POST /generations/e1/approve'))
  })

  it('shows live progress from the job behind a frame', () => {
    mockApi([])
    const busy = shot('s1', 'a', 1, { activity: [{ id: 'g1', kind: 'keyframe_end', status: 'generating', job_id: 'j1', version: 1 }] })
    renderStage(<StoryboardCanvas />, {
      scenes,
      shots: [busy],
      seed: (qc) =>
        qc.setQueryData(qk.jobs, [{ id: 'j1', type: 'generate', status: 'running', progress: 0.42, message: '', attempts: 0, created_at: T }]),
    })
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Rendering 42%')
  })

  it('re-render warns about the Continue shot after it, and touches only this shot', async () => {
    const calls = mockApi(withVersions(), (_method, path) =>
      path === '/shots/s1/rerender' ? { jobs: [], linked_next_shot_id: 's2' } : undefined,
    )
    renderStage(<StoryboardCanvas />, { scenes, shots: withVersions() })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Actions for shot 1.1' }))
    await user.click(await screen.findByRole('menuitem', { name: /re-render this shot/i }))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByRole('note')).toHaveTextContent(/shot 1\.2 continues from this END frame/i)
    await user.click(within(dialog).getByRole('button', { name: 'Re-render this shot' }))
    await waitFor(() => expect(posts(calls, '/shots/s1/rerender')[0]?.body).toMatchObject({ what: 'frames' }))
    expect(calls.filter((c) => c.path.startsWith('/shots/s2'))).toEqual([])
  })

  it('extends a shot with an optional next beat', async () => {
    const created = shot('s9', 'a', 2, { seam_in: 'continue', duration_s: 4 })
    const job: Job = { id: 'j9', type: 'ai_extend_shot', status: 'queued', progress: 0, message: '', attempts: 0, created_at: T }
    const calls = mockApi(withVersions(), (_method, path) => (path === '/shots/s1/extend' ? { shot: created, job } : undefined))
    renderStage(<StoryboardCanvas />, { scenes, shots: withVersions() })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Actions for shot 1.1' }))
    await user.click(await screen.findByRole('menuitem', { name: /extend shot/i }))
    const dialog = screen.getByRole('dialog', { name: /extend shot 1\.1/i })
    const len = within(dialog).getByRole('spinbutton', { name: /length/i })
    await user.clear(len)
    await user.type(len, '4')
    await user.type(within(dialog).getByRole('textbox', { name: /what happens next/i }), 'She dives')
    await user.click(within(dialog).getByRole('button', { name: 'Extend shot' }))
    await waitFor(() => expect(posts(calls, '/shots/s1/extend')[0]?.body).toEqual({ duration_s: 4, prompt: 'She dives' }))
    await waitFor(() => expect(useWorkspace.getState().selectedShot[PID]).toEqual({ shotId: 's9', frame: 'end' }))
  })
})

describe('Camera rack on a storyboard shot', () => {
  it('the inspector Camera tab saves the rack as structured shot.camera_rack', async () => {
    const { StoryboardInspector } = await import('./StoryboardInspector')
    const s1 = shot('s1', 'a', 1, { camera_rack: { size: 'ms' } })
    const calls = mockApi([s1])
    useWorkspace.setState({ selectedShot: { [PID]: { shotId: 's1', frame: 'end' } } })
    renderStage(<StoryboardInspector />, { scenes: [scene('a', 0)], shots: [s1] })
    const user = userEvent.setup()
    await user.click(screen.getByRole('tab', { name: /camera/i }))
    expect(screen.getByRole('radio', { name: /medium shot/i })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('radio', { name: /push in/i }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PATCH',
        path: '/shots/s1',
        body: { camera_rack: { size: 'ms', motion: 'push_in', speed: 'slow' } },
      }),
    )
  })
})
