import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { qk } from '@/hooks/keys'
import { useProjectShots } from '@/hooks/useShots'
import { cleanLines } from '@/lib/shots'
import type { Character, Shot } from '@/lib/types'
import { mockApi, PID, renderStage, scene, shot } from '@/test/storyboard-fixtures'
import { ShotFields } from './ShotFields'

afterEach(() => vi.unstubAllGlobals())

const person = (id: string, name: string): Character => ({
  id, project_id: PID, name, description: '', source: 'user', locked: false, voice_id: null,
})
const CAST = [person('c1', 'Maya'), person('c2', 'Tomas'), person('c3', 'Ayesha')]

function LiveShot({ id }: { id: string }) {
  const s = useProjectShots(PID).data?.find((x) => x.id === id)
  return s ? <ShotFields shot={s} label="1.1" /> : null
}

function setup(extra: Partial<Shot> = {}) {
  const s = shot('s1', 'a', 0, { character_ids: ['c1', 'c2'], ...extra })
  const calls = mockApi([s])
  renderStage(<LiveShot id="s1" />, { scenes: [scene('a', 0)], shots: [s], seed: (qc) => qc.setQueryData(qk.characters(PID), CAST) })
  const patches = () => calls.filter((c) => c.method === 'PATCH').map((c) => (c.body as { dialogue: unknown }).dialogue)
  return { patches, user: userEvent.setup(), lines: () => screen.queryByRole('list', { name: 'Lines in shot 1.1' }) }
}

describe('shot dialogue', () => {
  it('cleans lines the way the server stores them', () => {
    expect(cleanLines([{ character_id: 'c1', text: '  One   more ' }, { character_id: 'c1', text: ' ' }, { character_id: 'c2', text: 'Go', pause_after_s: 0.5 }])).toEqual([
      { character_id: 'c1', text: 'One more' },
      { character_id: 'c2', text: 'Go', pause_after_s: 0.5 },
    ])
  })

  it('adds a line for a speaker in the shot and saves it when the field is left', async () => {
    const { patches, user, lines } = setup()
    await user.click(screen.getByRole('button', { name: 'Add line' }))
    const list = lines()!
    // only the shot's own characters can speak
    const who = within(list).getByRole('combobox', { name: 'Speaker of line 1' })
    expect(within(who).getAllByRole('option').map((o) => o.textContent)).toEqual(['Maya', 'Tomas'])
    await user.selectOptions(who, 'c2')
    expect(patches()).toEqual([])  // an empty line isn't sent
    await user.type(within(list).getByRole('textbox', { name: 'Line 1, said by Tomas' }), 'Sleep now.')
    await user.tab()
    expect(patches()).toEqual([[{ character_id: 'c2', text: 'Sleep now.' }]])
    expect(screen.getByText(/Lip sync works best with one visible speaker\./)).toBeInTheDocument()
  })

  it('warns about two speakers and shows the server notice', async () => {
    const { patches, user, lines } = setup({
      dialogue: [{ character_id: 'c1', text: 'One more dive.' }, { character_id: 'c2', text: 'Then home.' }],
      dialogue_notice: 'Tomas has no voice yet, so this shot’s lines use the video model’s own audio instead of lip sync.',
    })
    expect(screen.getByText(/try one shot per speaker, or an over-the-shoulder shot/)).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('Tomas has no voice yet')
    await user.click(within(lines()!).getByRole('button', { name: 'Remove line 2' }))
    expect(patches()).toEqual([[{ character_id: 'c1', text: 'One more dive.' }]])
  })

  it('asks for a character before lines can be added', () => {
    setup({ character_ids: [] })
    expect(screen.queryByRole('button', { name: 'Add line' })).not.toBeInTheDocument()
    expect(screen.getByText('Put a character in the shot to give them lines.')).toBeInTheDocument()
  })
})
