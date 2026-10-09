import { describe, expect, it } from 'vitest'
import { initUndo, jumpTo, push, timeline } from './undo'
import { bypass, modifiedGroups, pasteGroups, pickGroups, stepLabel, toggleGroup } from './workflow'

describe('develop workflow', () => {
  it('switches panels off without losing their settings', () => {
    const p = toggleGroup({ exposure: 30, vignette: -20 }, 'basic')
    expect(p.off).toEqual(['basic'])
    expect(bypass(p)).toEqual({ vignette: -20, off: ['basic'] })
    expect(toggleGroup(p, 'basic')).toEqual({ exposure: 30, vignette: -20 })
  })

  it('copies and pastes only the ticked groups', () => {
    const src = { exposure: 30, temperature: 10, vignette: -20, crop: { x: 0, y: 0, width: 5, height: 5 }, off: ['effects'] }
    const copied = pickGroups(src, ['basic', 'effects'])
    expect(copied).toEqual({ exposure: 30, temperature: 10, vignette: -20, off: ['effects'] })
    const mine = { exposure: -5, contrast: 40, clarity: 12, crop: { x: 1, y: 1, width: 2, height: 2 } }
    const out = pasteGroups(mine, copied, ['basic', 'effects'])
    // contrast was mine but Basic was pasted whole: it goes back to default
    expect(out).toEqual({ exposure: 30, temperature: 10, vignette: -20, clarity: 12, crop: { x: 1, y: 1, width: 2, height: 2 }, off: ['effects'] })
    expect(modifiedGroups(src).sort()).toEqual(['basic', 'effects', 'geometry'])
  })

  it('labels history steps like Lightroom', () => {
    expect(stepLabel({}, { exposure: 0.38 })).toBe('Exposure +0.38 EV')
    expect(stepLabel({}, { contrast: 12 })).toBe('Contrast +12')
    expect(stepLabel({}, { grading: { shadows: { h: 200 } } })).toBe('Colour grading shadows')
    expect(stepLabel({ exposure: 38 }, { exposure: 38, crop: { x: 0, y: 0, width: 1, height: 1 } })).toBe('Crop')
    expect(stepLabel({}, { curve: { mids: 10 } })).toBe('Tone curve mids')
    expect(stepLabel({ exposure: 1 }, { exposure: 1 })).toBe('No change')
  })

  it('jumps to any history step and keeps later ones redoable', () => {
    let s = initUndo<number>(0)
    s = push(s, 1, null)
    s = push(s, 2, null)
    s = jumpTo(s, 0)
    expect(timeline(s)).toEqual({ states: [0, 1, 2], at: 0 })
    s = jumpTo(s, 2)
    expect(s.present).toBe(2)
  })
})
