import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { FALLBACK_RANGES, setValue } from '@/lib/photo/params'
import type { DevelopParams, UprightMode } from '@/lib/photo/types'
import { CropOverlay } from './CropOverlay'
import { DetailPanel, LensPanel, TransformPanel } from './OpticsPanels'

function Harness({ panel, initial = {}, spy, onUpright, onAutoCa }: {
  panel: 'detail' | 'lens' | 'transform'
  initial?: DevelopParams
  spy?: (p: DevelopParams) => void
  onUpright?: (m: UprightMode) => void
  onAutoCa?: (on: boolean) => void
}) {
  const [p, setP] = useState<DevelopParams>(initial)
  const [mask, setMask] = useState(false)
  const put = (next: DevelopParams) => {
    setP(next)
    spy?.(next)
  }
  const onSet = (k: string, v: number) => put(setValue(p, k, v))
  const onUpdate = (fn: (x: DevelopParams) => DevelopParams) => put(fn(p))
  if (panel === 'detail') return <DetailPanel params={p} ranges={FALLBACK_RANGES} onSet={onSet} maskView={mask} onMaskView={setMask} />
  if (panel === 'lens') return <LensPanel params={p} ranges={FALLBACK_RANGES} onSet={onSet} onUpdate={onUpdate} onAutoCa={onAutoCa} onPick={() => {}} />
  return <TransformPanel params={p} ranges={FALLBACK_RANGES} onSet={onSet} onUpdate={onUpdate} onUpright={onUpright} note="12 straight lines found." />
}

// spatial sliders say "· exact on release" after their name
const slider = (name: string) => screen.getByRole('slider', { name: new RegExp(`^${name}( ?·|$)`) }) as HTMLInputElement

describe('Detail, Lens corrections and Transform panels', () => {
  it('Detail: four sharpening sliders with Lightroom defaults, six for noise, and the mask view', async () => {
    const spy = vi.fn()
    render(<Harness panel="detail" spy={spy} />)
    expect(slider('Radius')).toHaveValue('1')
    expect(slider('Detail').value).toBe('25')
    for (const n of ['Amount', 'Masking', 'Luminance', 'Luminance detail', 'Luminance contrast', 'Colour', 'Colour detail', 'Smoothness']) expect(slider(n)).toBeInTheDocument()
    expect(screen.getAllByText(/exact on release/).length).toBeGreaterThanOrEqual(10)
    fireEvent.change(slider('Amount'), { target: { value: '70' } })
    expect(spy).toHaveBeenLastCalledWith({ sharpen: { amount: 70 } })
    const mask = screen.getByRole('button', { name: /Show mask/ })
    await userEvent.click(mask)
    expect(mask).toHaveAttribute('aria-pressed', 'true')
  })

  it('Lens: CA on the Profile tab, distortion / defringe / vignetting on Manual', async () => {
    const user = userEvent.setup()
    const onAutoCa = vi.fn()
    const spy = vi.fn()
    render(<Harness panel="lens" spy={spy} onAutoCa={onAutoCa} />)
    await user.click(screen.getByRole('checkbox', { name: 'Remove chromatic aberration' }))
    expect(onAutoCa).toHaveBeenCalledWith(true)
    expect(slider('Red / cyan')).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Manual' }))
    fireEvent.change(slider('Distortion'), { target: { value: '-30' } })
    expect(spy).toHaveBeenLastCalledWith({ lens: { distortion: -30 } })
    await user.click(screen.getByRole('checkbox', { name: 'Constrain crop' }))
    expect(spy).toHaveBeenLastCalledWith({ lens: { distortion: -30 }, transform: { constrain: true } })
    expect(slider('Purple hue from')).toHaveValue('30')
    expect(slider('Green hue to')).toHaveValue('60')
    expect(slider('Midpoint')).toHaveValue('50')
    expect(screen.getByRole('button', { name: 'Fringe colour selector' })).toBeInTheDocument()
  })

  it('Transform: Upright buttons ask for a measurement, manual sliders and constrain', async () => {
    const user = userEvent.setup()
    const onUpright = vi.fn()
    const spy = vi.fn()
    render(<Harness panel="transform" spy={spy} onUpright={onUpright} />)
    const group = screen.getByRole('radiogroup', { name: 'Upright' })
    expect(group).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Vertical' }))
    expect(onUpright).toHaveBeenCalledWith('vertical')
    expect(screen.getByRole('status')).toHaveTextContent('12 straight lines found.')
    expect(slider('Scale')).toHaveValue('100')
    fireEvent.change(slider('Vertical'), { target: { value: '-25' } })
    expect(spy).toHaveBeenLastCalledWith({ transform: { vertical: -25 } })
    expect(slider('Rotate').step).toBe('0.1')
  })
})

describe('Crop overlay', () => {
  const crop = { x: 0, y: 0, width: 300, height: 200 }
  it('draws the chosen overlay, turned, at the chosen opacity', () => {
    const { container, rerender } = render(<CropOverlay crop={crop} src={{ w: 300, h: 200 }} box={{ width: 300, height: 200 }} ratio={null} onChange={() => {}} overlay="thirds" />)
    expect(container.querySelectorAll('line')).toHaveLength(4)
    rerender(<CropOverlay crop={crop} src={{ w: 300, h: 200 }} box={{ width: 300, height: 200 }} ratio={null} onChange={() => {}} overlay="spiral" orient={3} opacity={0.25} />)
    expect(container.querySelector('path')).toBeInTheDocument()
    expect(container.querySelector('g')?.getAttribute('transform')).toContain('scale(-1 -1)')
    expect((screen.getByRole('group', { name: 'Crop' }) as HTMLElement).style.boxShadow).toContain('0.25')
    rerender(<CropOverlay crop={crop} src={{ w: 300, h: 200 }} box={{ width: 300, height: 200 }} ratio={null} onChange={() => {}} overlay="none" />)
    expect(container.querySelector('svg')).toBeNull()
  })
})
