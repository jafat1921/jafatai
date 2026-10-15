import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AdStyle } from '@/lib/ads'
import { LayoutPicker } from './LayoutPicker'

function Harness({ onChange }: { onChange: (v: AdStyle) => void }) {
  const [v, setV] = useState<AdStyle>('frosted')
  return (
    <LayoutPicker
      value={v}
      onChange={(x) => {
        setV(x)
        onChange(x)
      }}
    />
  )
}

describe('LayoutPicker', () => {
  it('lists all thirteen layouts as radios with one tab stop', () => {
    render(<Harness onChange={() => {}} />)
    const group = screen.getByRole('radiogroup', { name: 'Layout' })
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(13)
    expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1)
    expect(screen.getByRole('radio', { name: 'Frosted panel' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Big price' })).toHaveAccessibleDescription('needs a price offer')
    expect(group.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(13)
  })

  it('moves with the arrow keys and picks on click, Enter and Space', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const user = userEvent.setup()
    await user.tab()
    expect(screen.getByRole('radio', { name: 'Frosted panel' })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Side wash' })).toHaveFocus()
    expect(screen.getByRole('radio', { name: 'Side wash' })).toHaveAttribute('aria-checked', 'true')
    // wraps round from the first to the last
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(screen.getByRole('radio', { name: 'Quote card' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(onChange).toHaveBeenLastCalledWith('frosted')
    await user.click(screen.getByRole('radio', { name: 'Photo in a circle' }))
    expect(onChange).toHaveBeenLastCalledWith('circle_mask')
    screen.getByRole('radio', { name: 'Editorial' }).focus()
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenLastCalledWith('editorial')
    screen.getByRole('radio', { name: 'Before / after' }).focus()
    await user.keyboard(' ')
    expect(onChange).toHaveBeenLastCalledWith('before_after')
  })
})
