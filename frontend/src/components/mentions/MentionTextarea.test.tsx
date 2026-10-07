import { useState } from 'react'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockApi, renderAt } from '@/test/media-fixtures'
import { MentionTextarea, type MentionOptions } from './MentionTextarea'

afterEach(() => vi.unstubAllGlobals())

const OPTIONS = [
  { type: 'character', id: 'c1', label: 'Mara', hint: 'Reef', thumb_url: '/m/mara.png', ref_generation_id: 'g1' },
  { type: 'character', id: 'c2', label: 'مارا', hint: 'Reef', thumb_url: null, ref_generation_id: 'g2' },
  { type: 'location', id: 'l1', label: 'Harbour', hint: 'Reef', thumb_url: '/m/harbour.png', ref_generation_id: 'g3' },
  { type: 'product', id: 'p1', label: 'Leaf Cold Brew', hint: 'Leaf', thumb_url: '/m/brew.png', ref_generation_id: 'g4' },
]

function api() {
  return mockApi((_m, path, query) => {
    if (path === '/mentions') {
      const q = (query.q ?? '').toLowerCase()
      return OPTIONS.filter((o) => !q || o.label.toLowerCase().split(' ').some((w) => w.startsWith(q)))
    }
  })
}

function Harness(props: MentionOptions & { start?: string }) {
  const [v, setV] = useState(props.start ?? '')
  return (
    <>
      <label htmlFor="p">Prompt</label>
      <MentionTextarea id="p" value={v} onValueChange={setV} {...props} />
      <output data-testid="value">{v}</output>
    </>
  )
}

const show = (props: MentionOptions & { start?: string } = {}) => renderAt('/', [{ path: '/', element: <Harness {...props} /> }])
const value = () => screen.getByTestId('value').textContent

describe('@-mentions', () => {
  it('suggests by group, picks with the keyboard and keeps the server token in the value', async () => {
    const calls = api()
    show({ refBudget: 3 })
    const user = userEvent.setup()
    const box = screen.getByRole('textbox', { name: 'Prompt' })
    expect(box).toHaveAttribute('dir', 'auto')
    await user.type(box, 'Close on @')
    const list = await screen.findByRole('listbox', { name: 'Mention suggestions' })
    expect(within(list).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Cast', 'Locations', 'Products'])
    expect(box).toHaveAttribute('aria-activedescendant', within(list).getByRole('option', { name: /^Mara/ }).id)

    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(within(list).getByRole('option', { name: /Harbour/ })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(box).toHaveValue('Close on @Harbour ')
    expect(value()).toBe('Close on @[Harbour](location:l1) ')
    expect(calls.some((c) => c.path === '/mentions')).toBe(true)

    await user.type(box, 'with @le')
    await screen.findByRole('option', { name: /Leaf Cold Brew/ })
    await user.keyboard('{Enter}')
    expect(value()).toBe('Close on @[Harbour](location:l1) with @[Leaf Cold Brew](product:p1) ')
    expect(screen.getByText('Uses 2 of 3 references')).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Mentions' })).getAllByRole('listitem')).toHaveLength(2)
  })

  it('Esc closes the list without leaving the field, and removing a mention keeps the word', async () => {
    api()
    show({ start: '@[Mara](character:c1) on the quay', refBudget: 3, refsUsed: 2 })
    const user = userEvent.setup()
    const box = screen.getByRole('textbox', { name: 'Prompt' })
    expect(box).toHaveValue('@Mara on the quay')
    expect(screen.getByText('Uses 3 of 3 references')).toBeInTheDocument()

    await user.click(box)
    await user.keyboard('{End} @')
    await screen.findByRole('listbox')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(box).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Remove the mention of Mara' }))
    expect(value()).toBe('Mara on the quay @')
    expect(screen.queryByRole('list', { name: 'Mentions' })).not.toBeInTheDocument()
  })

  it('deleting the name in the text drops its reference', async () => {
    api()
    show({ start: 'A @[Mara](character:c1)', refBudget: 3 })
    const user = userEvent.setup()
    const box = screen.getByRole('textbox', { name: 'Prompt' })
    await user.click(box)
    await user.keyboard('{End}{Backspace}{Backspace}')
    expect(value()).toBe('A @Ma')
    expect(screen.queryByText(/Uses/)).not.toBeInTheDocument()
  })

  it('warns when the mentions need more references than the model takes', async () => {
    api()
    show({ start: '@[Mara](character:c1) @[Harbour](location:l1)', refBudget: 3, refsUsed: 2 })
    expect(screen.getByText('Uses 4 of 3 references. Remove a mention to run.')).toBeInTheDocument()
  })

  it('works inside Urdu text, right to left', async () => {
    api()
    show({ refBudget: 0, namesOnlyNote: 'Names only.' })
    const user = userEvent.setup()
    const box = screen.getByRole('textbox', { name: 'Prompt' })
    await user.type(box, 'ساحل پر @ما')
    await user.click(await screen.findByRole('option', { name: /مارا/ }))
    await user.type(box, 'چل رہی ہے')
    expect(box).toHaveValue('ساحل پر @مارا چل رہی ہے')
    expect(value()).toBe('ساحل پر @[مارا](character:c2) چل رہی ہے')
    expect(screen.getByText('Names only.')).toBeInTheDocument()
  })
})
