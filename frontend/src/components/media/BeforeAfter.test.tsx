import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { containedRect } from '@/lib/media'
import { BeforeAfter } from './BeforeAfter'

const size = (el: Element, w: number, h: number) => {
  ;(el as HTMLElement).getBoundingClientRect = () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON: () => ({}) })
}
const natural = (img: HTMLElement, w: number, h: number) => {
  Object.defineProperty(img, 'naturalWidth', { value: w })
  Object.defineProperty(img, 'naturalHeight', { value: h })
  fireEvent.load(img)
}

describe('before / after', () => {
  it('moves the divider with arrows, Shift+arrows, Home and End', async () => {
    render(<BeforeAfter before="/a.png" after="/b.png" alt="Harbour" aspectClass="aspect-[4/3]" />)
    const user = userEvent.setup()
    const divider = screen.getByRole('slider', { name: 'Before and after divider' })
    expect(divider).toHaveAttribute('aria-valuenow', '50')
    divider.focus()
    await user.keyboard('{ArrowRight}')
    expect(divider).toHaveAttribute('aria-valuenow', '52')
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    expect(divider).toHaveAttribute('aria-valuenow', '42')
    await user.keyboard('{End}')
    expect(divider).toHaveAttribute('aria-valuenow', '100')
    expect(divider).toHaveAttribute('aria-valuetext', '0% after showing')
    await user.keyboard('{Home}')
    expect(divider).toHaveAttribute('aria-valuenow', '0')
    expect(screen.getByRole('img', { name: 'After: Harbour' })).toBeInTheDocument()
  })

  it('drags the divider with the pointer (mouse or touch)', () => {
    render(<BeforeAfter before="/a.png" after="/b.png" alt="Harbour" />)
    const divider = screen.getByRole('slider')
    const stage = divider.parentElement!
    size(stage, 400, 300)
    fireEvent.pointerDown(stage, { clientX: 100, clientY: 10, pointerType: 'touch' })
    expect(divider).toHaveAttribute('aria-valuenow', '25')
    fireEvent.pointerMove(stage, { clientX: 300, clientY: 10, pointerType: 'touch' })
    fireEvent.pointerUp(stage, { pointerType: 'touch' })
    expect(divider).toHaveAttribute('aria-valuenow', '75')
  })

  it('L toggles a 1:1 loupe that reads true pixels of the side under it', async () => {
    render(<BeforeAfter before="/small.png" after="/big.png" alt="Harbour" />)
    const user = userEvent.setup()
    const divider = screen.getByRole('slider')
    const stage = divider.parentElement!
    size(stage, 400, 300)
    natural(screen.getByRole('img', { name: 'Before: Harbour' }), 800, 600)
    natural(screen.getByRole('img', { name: 'After: Harbour' }), 1600, 1200)
    const toggle = screen.getByRole('button', { name: /1:1 loupe/ })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    divider.focus()
    await user.keyboard('l')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    // from the keyboard it sits on the divider, which is the after side's left edge
    let lens = screen.getByTestId('loupe')
    expect(lens.style.backgroundImage).toContain('/big.png')
    expect(lens.style.backgroundSize).toBe('1600px 1200px')

    fireEvent.pointerMove(stage, { clientX: 100, clientY: 150, pointerType: 'mouse' })
    lens = screen.getByTestId('loupe')
    expect(lens.style.backgroundImage).toContain('/small.png')
    // 100 px of a 400 px stage showing an 800 px picture is pixel 200; the lens is 168 wide
    expect(lens.style.backgroundPosition).toBe('-116px -216px')

    await user.keyboard('L')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('loupe')).not.toBeInTheDocument()
  })

  it('works out where a contained picture sits', () => {
    expect(containedRect(400, 300, 1600, 900)).toEqual({ x: 0, y: 37.5, w: 400, h: 225 })
  })

  it('plays two videos as one for the frame-synced compare', async () => {
    render(<BeforeAfter kind="video" before="/a.mp4" after="/b.mp4" alt="Film" aspectClass="aspect-video" />)
    expect(screen.getByLabelText('Before: Film').tagName).toBe('VIDEO')
    expect(screen.getByLabelText('After: Film').tagName).toBe('VIDEO')
    expect(screen.queryByRole('button', { name: /loupe/ })).not.toBeInTheDocument()
    const scrub = screen.getByRole('slider', { name: 'Position in both clips' })
    fireEvent.change(scrub, { target: { value: '0' } })
    expect(screen.getByRole('button', { name: 'Play both' })).toBeInTheDocument()
  })
})
