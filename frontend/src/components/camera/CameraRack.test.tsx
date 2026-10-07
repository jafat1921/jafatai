import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { cameraPayload, cameraSummary, type CameraSetting } from '@/lib/camera'
import { CameraChip, CameraRack } from './CameraRack'

function Harness({ start = {}, chip = false }: { start?: CameraSetting; chip?: boolean }) {
  const [cam, setCam] = useState<CameraSetting>(start)
  return (
    <>
      {chip ? <CameraChip value={cam} onChange={setCam} /> : <CameraRack value={cam} onChange={setCam} />}
      <output data-testid="cam">{JSON.stringify(cameraPayload(cam) ?? null)}</output>
    </>
  )
}

const sent = () => JSON.parse(screen.getByTestId('cam').textContent || 'null')

describe('camera vocabulary', () => {
  it('summarises for the chip and leaves out speed where it means nothing', () => {
    expect(cameraSummary({ size: 'ms', angle: 'low', motion: 'push_in', speed: 'slow' })).toBe('MS · Low · Push-in slow')
    expect(cameraSummary({ motion: 'push_in' })).toBe('Push-in slow')
    expect(cameraSummary({ size: 'ls', motion: 'static', speed: 'fast' })).toBe('Wide · Static')
    expect(cameraSummary({})).toBe('')
    expect(cameraPayload({})).toBeUndefined()
    expect(cameraPayload({ angle: 'dutch', speed: 'fast' })).toEqual({ angle: 'dutch' })
    expect(cameraPayload({ motion: 'orbit_left' })).toEqual({ motion: 'orbit_left', speed: 'slow' })
  })
})

describe('CameraRack', () => {
  it('has three radio rows with one tab stop each, and arrows move and pick', async () => {
    render(<Harness />)
    const user = userEvent.setup()
    const sizes = screen.getByRole('radiogroup', { name: 'Shot size' })
    const motion = screen.getByRole('radiogroup', { name: 'Motion' })
    expect(within(sizes).getAllByRole('radio')).toHaveLength(7)
    expect(within(screen.getByRole('radiogroup', { name: 'Angle' })).getAllByRole('radio')).toHaveLength(7)
    expect(within(motion).getAllByRole('radio').length).toBe(16)
    // only the first chip of each row is in the tab order
    expect(within(sizes).getAllByRole('radio').filter((r) => r.tabIndex === 0)).toHaveLength(1)

    await user.tab()
    expect(within(sizes).getByRole('radio', { name: 'Extreme close-up' })).toHaveFocus()
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')
    const ms = within(sizes).getByRole('radio', { name: 'Medium shot' })
    expect(ms).toHaveFocus()
    expect(ms).toBeChecked()
    expect(ms).toHaveAccessibleDescription('From the waist up.')
    await user.keyboard('{End}')
    expect(within(sizes).getByRole('radio', { name: 'Extreme wide' })).toBeChecked()
    await user.keyboard('{ArrowRight}')
    expect(within(sizes).getByRole('radio', { name: 'Extreme close-up' })).toBeChecked()
    // the next Tab leaves the row for the next one
    await user.tab()
    expect(within(screen.getByRole('radiogroup', { name: 'Angle' })).getByRole('radio', { name: 'Eye level' })).toHaveFocus()
  })

  it('picks a move, sets its speed, shows the summary and resets', async () => {
    render(<Harness />)
    const user = userEvent.setup()
    const speed = screen.getByRole('radiogroup', { name: 'Speed' })
    expect(within(speed).getByRole('radio', { name: 'Fast' })).toBeDisabled()
    expect(screen.getByText('No camera direction: the model decides.')).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'Medium shot' }))
    await user.click(screen.getByRole('radio', { name: 'Low angle' }))
    await user.click(screen.getByRole('radio', { name: 'Push in' }))
    expect(screen.getByText('MS · Low · Push-in slow')).toBeInTheDocument()
    await user.click(within(speed).getByRole('radio', { name: 'Fast' }))
    expect(sent()).toEqual({ size: 'ms', angle: 'low', motion: 'push_in', speed: 'fast' })

    // clicking the picked chip clears that row
    await user.click(screen.getByRole('radio', { name: 'Low angle' }))
    expect(sent()).toEqual({ size: 'ms', motion: 'push_in', speed: 'fast' })

    await user.click(screen.getByRole('button', { name: 'Reset' }))
    expect(sent()).toBeNull()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()
  })

  it('lives in a dock chip that shows the summary', async () => {
    render(<Harness chip start={{ size: 'ms', angle: 'low', motion: 'push_in', speed: 'slow' }} />)
    const user = userEvent.setup()
    const chip = screen.getByRole('button', { name: 'Camera: MS · Low · Push-in slow' })
    await user.click(chip)
    const rack = await screen.findByRole('dialog', { name: 'Camera' })
    await user.click(within(rack).getByRole('radio', { name: 'Static' }))
    expect(screen.getByRole('button', { name: 'Camera: MS · Low · Static' })).toBeInTheDocument()
    expect(sent()).toEqual({ size: 'ms', angle: 'low', motion: 'static' })
  })
})
