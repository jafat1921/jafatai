import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { FALLBACK_RANGES } from '@/lib/photo/params'
import { DevelopSlider } from './DevelopSlider'

function Harness({ onChange = () => {} }: { onChange?: (v: number, g: string) => void }) {
  const [v, setV] = useState(0)
  return (
    <DevelopSlider
      name="exposure"
      label="Exposure"
      value={v}
      range={FALLBACK_RANGES.exposure}
      onChange={(next, g) => {
        setV(next)
        onChange(next, g)
      }}
    />
  )
}

describe('DevelopSlider', () => {
  it('has accessible names for the track and the number field', () => {
    render(<Harness />)
    expect(screen.getByRole('slider', { name: 'Exposure' })).toHaveAttribute('aria-valuetext', 'Exposure 0')
    expect(screen.getByRole('textbox', { name: 'Exposure value' })).toHaveValue('0')
  })

  it('nudges with the arrows, ten at a time with Shift, and jumps with Home / End', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const slider = screen.getByRole('slider', { name: 'Exposure' })
    slider.focus()
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(slider).toHaveValue('2')
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    expect(slider).toHaveValue('12')
    await user.keyboard('{Shift>}{ArrowLeft}{ArrowLeft}{/Shift}')
    expect(slider).toHaveValue('-8')
    await user.keyboard('{End}')
    expect(slider).toHaveValue('100')
    expect(screen.getByRole('textbox', { name: 'Exposure value' })).toHaveValue('+100')
  })

  it('resets on double-click', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const slider = screen.getByRole('slider', { name: 'Exposure' })
    fireEvent.change(slider, { target: { value: '45' } })
    expect(slider).toHaveValue('45')
    await user.dblClick(slider)
    expect(slider).toHaveValue('0')
    expect(onChange).toHaveBeenLastCalledWith(0, 'reset:exposure')
  })

  it('takes a typed value, clamped to the range', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const field = screen.getByRole('textbox', { name: 'Exposure value' })
    await user.clear(field)
    await user.type(field, '250{Enter}')
    expect(screen.getByRole('slider', { name: 'Exposure' })).toHaveValue('100')
    await user.clear(field)
    await user.type(field, '-33')
    await user.tab()
    expect(screen.getByRole('slider', { name: 'Exposure' })).toHaveValue('-33')
  })
})
