import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { qk } from '@/hooks/keys'
import { useProjectShots } from '@/hooks/useShots'
import { closingOf, logoCheckOf, logoRetryNote, placementsLocked } from '@/lib/brand'
import type { Shot } from '@/lib/types'
import { kit } from '@/test/brand-fixtures'
import { frame, mockApi, PID, project, renderStage, scene, shot } from '@/test/storyboard-fixtures'
import { FrameSlot } from './FrameSlot'
import { ShotFields } from './ShotFields'

// reads the shot from the cache like FrameRow does, so optimistic patches show up
function LiveShot({ id }: { id: string }) {
  const s = useProjectShots(PID).data?.find((x) => x.id === id)
  return s ? <ShotFields shot={s} label="1.1" /> : null
}

afterEach(() => vi.unstubAllGlobals())

const LEAF = kit('k1', {
  name: 'Leaf',
  logos: { primary: { media_id: 'lg', description: 'round green leaf' } },
  products: [{ media_id: 'p1', name: 'Cold brew can', description: '' }],
  assets: { lg: { media_id: 'lg', media_url: '/m/lg.png', missing: false }, p1: { media_id: 'p1', media_url: '/m/p1.png', missing: false } },
})

function setup(extra: Partial<Shot> = {}) {
  const s = shot('s1', 'a', 0, {
    brand_placements: [{ asset_id: 'lg', asset_type: 'logo', surface: 'cup sleeve', prominence: 'hero', source: 'ai' }],
    ...extra,
  })
  const calls = mockApi([s])
  renderStage(<LiveShot id="s1" />, {
    scenes: [scene('a', 0)],
    shots: [s],
    seed: (qc) => {
      qc.setQueryData(qk.project(PID), { ...project, settings: { brand_kit_id: 'k1' } })
      qc.setQueryData(qk.brandKit('k1'), LEAF)
    },
  })
  const patches = () => calls.filter((c) => c.method === 'PATCH').map((c) => (c.body as { brand_placements: unknown }).brand_placements)
  return { patches, user: userEvent.setup(), group: () => screen.getByRole('group', { name: 'Brand in shot 1.1' }) }
}

describe('brand placements on a shot', () => {
  it('shows the planned logo with its surface and prominence', () => {
    const { group } = setup()
    expect(within(group()).getByText('Logo · cup sleeve')).toBeInTheDocument()
    expect(within(group()).getByText('Hero')).toBeInTheDocument()
    expect(within(group()).queryByText(/Edited by you/)).not.toBeInTheDocument()
  })

  it('adds a product placement and locks the list as the user’s', async () => {
    const { patches, user, group } = setup()
    await user.click(within(group()).getByRole('button', { name: 'Add brand' }))
    const form = screen.getByRole('dialog', { name: 'Add a brand placement' })
    await user.selectOptions(within(form).getByRole('combobox', { name: 'What' }), 'p1')
    await user.type(within(form).getByRole('textbox', { name: 'Where in the shot' }), 'on the counter')
    await user.click(within(form).getByRole('radio', { name: 'Background' }))
    await user.click(within(form).getByRole('button', { name: 'Add' }))

    expect(patches()[0]).toEqual([
      { asset_id: 'lg', asset_type: 'logo', surface: 'cup sleeve', prominence: 'hero', source: 'user' },
      { asset_id: 'p1', asset_type: 'product', surface: 'on the counter', prominence: 'background', source: 'user' },
    ])
    expect(await within(group()).findByText('Cold brew can · on the counter')).toBeInTheDocument()
    expect(within(group()).getByText(/Edited by you; the AI keeps these/)).toBeInTheDocument()
  })

  it('edits and removes a placement', async () => {
    const { patches, user, group } = setup()
    await user.click(within(group()).getByRole('button', { name: 'Edit Logo · cup sleeve' }))
    const form = screen.getByRole('dialog', { name: 'Edit Logo placement' })
    const where = within(form).getByRole('textbox', { name: 'Where in the shot' })
    await user.clear(where)
    await user.type(where, 'shop sign')
    await user.click(within(form).getByRole('button', { name: 'Save' }))
    expect(patches()[0]).toEqual([{ asset_id: 'lg', asset_type: 'logo', surface: 'shop sign', prominence: 'hero', source: 'user' }])

    await user.click(await within(group()).findByRole('button', { name: 'Remove Logo · shop sign' }))
    expect(patches()[1]).toEqual([])
  })

  it('stays out of the way when the project has no kit and no placements', () => {
    const s = shot('s2', 'a', 0)
    mockApi([s])
    renderStage(<ShotFields shot={s} label="1.2" />, { scenes: [scene('a', 0)], shots: [s] })
    expect(screen.queryByRole('group', { name: 'Brand in shot 1.2' })).not.toBeInTheDocument()
  })

  it('reads the lock from the server flag or user-made placements, and the closing shot kind', () => {
    expect(placementsLocked(shot('x', 'a', 0, { brand_placements_locked: true }))).toBe(true)
    expect(placementsLocked(shot('x', 'a', 0, { brand_placements: [{ asset_id: 'a', asset_type: 'logo', surface: '', prominence: 'hero', source: 'ai' }] }))).toBe(false)
    expect(closingOf(shot('x', 'a', 0, { closing: 'logo_reveal' }))).toBe('logo_reveal')
    expect(closingOf(shot('x', 'a', 0, { brand_closing: 'ai_packshot' }))).toBe('ai_packshot')
    expect(closingOf(shot('x', 'a', 0, { closing: 'something' }))).toBeNull()
  })
})

const withCheck = (logo_check: unknown) => ({ ...frame('f1', 'keyframe_start', 's1'), params: { logo_check } })

function slot(f: ReturnType<typeof withCheck>, onRegenerate = vi.fn()) {
  mockApi([])
  renderStage(
    <FrameSlot side="START" frame={f} alt="START frame" aspectClass="aspect-video" selected={false} onSelect={() => {}} onRegenerateWithLogo={onRegenerate} />,
    { scenes: [], shots: [] },
  )
  return onRegenerate
}

describe('logo check badge', () => {
  it('passes with a tick and words', () => {
    slot(withCheck({ checked: true, passed: true, score: 8 }))
    expect(screen.getByText('Logo OK')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Regenerate with logo/ })).not.toBeInTheDocument()
  })

  it('lists the issues and regenerates with them', async () => {
    const onRegenerate = slot(withCheck({ checked: true, passed: false, present: true, legible: false, issues: ['Wordmark is blurred.'] }))
    expect(screen.getByText('Logo issues')).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Logo issues' })).getByText('Wordmark is blurred.')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: /Regenerate with logo/ }))
    expect(onRegenerate).toHaveBeenCalledWith(['Wordmark is blurred.'])
  })

  it('says when the check could not run, and shows nothing for frames without one', () => {
    slot(withCheck({ checked: false, reason: 'Vision model offline' }))
    expect(screen.getByLabelText('Logo not checked: Vision model offline')).toBeInTheDocument()
    expect(logoCheckOf(frame('f2', 'keyframe_end', 's1'))).toBeNull()
    expect(logoCheckOf({ params: { logo_check: { checked: true, passed: false, present: false } } })).toEqual({ state: 'issues', issues: ["The logo isn't in the frame."] })
    expect(logoRetryNote(['Too small.'])).toMatch(/^Show the brand logo clearly.*Fix: Too small\.$/)
  })
})
