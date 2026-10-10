import { describe, expect, it } from 'vitest'
import { blankLine, changedLines, gapAfter, mergeServer, mixBlockedReason, moveLine, runtimeEstimate, sentences, splitPreview, type ScriptLine, type ScriptSettings } from './dialogue'

const S: ScriptSettings = { gap_s: 0.5, paragraph_gap_s: 1, loudness: 'podcast', aerab: true }
const line = (id: string, extra: Partial<ScriptLine> = {}): ScriptLine => ({ ...blankLine(), id, text: 'one two three four five', ...extra })

describe('split preview', () => {
  it('casts NAME: lines and keeps unattributed text with the default speaker', () => {
    const p = splitPreview('Maya: We go now. Right now!\nTOMAS: No.\n\nThe sea was calm.', 'sentences')
    expect(p).toEqual([
      { speaker: 'Maya', text: 'We go now.', emotion: undefined },
      { speaker: 'Maya', text: 'Right now!', emotion: undefined },
      { speaker: 'Tomas', text: 'No.', emotion: undefined },
      { speaker: 'Narrator', text: 'The sea was calm.', emotion: undefined },
    ])
  })

  it('reads screenplay cues, parentheticals and action', () => {
    const p = splitPreview('Rain falls.\n\nMAYA (V.O.)\n(quietly)\nWe should go.\n\nTOMAS\nNot yet.', 'paragraphs')
    expect(p.map((x) => [x.speaker, x.text, x.emotion])).toEqual([
      ['Narrator', 'Rain falls.', undefined],
      ['Maya', 'We should go.', 'quietly'],
      ['Tomas', 'Not yet.', undefined],
    ])
  })

  it('splits by paragraph and by line', () => {
    const text = 'One. Two.\nThree.\n\nFour.'
    expect(splitPreview(text, 'paragraphs').map((x) => x.text)).toEqual(['One. Two. Three.', 'Four.'])
    expect(splitPreview(text, 'lines').map((x) => x.text)).toEqual(['One. Two.', 'Three.', 'Four.'])
    expect(splitPreview('  ', 'lines')).toEqual([])
  })

  it('keeps abbreviations and Urdu full stops', () => {
    expect(sentences('Mr. Khan came. He sat.')).toEqual(['Mr. Khan came.', 'He sat.'])
    expect(sentences('یہ پہلا ہے۔ یہ دوسرا ہے؟')).toEqual(['یہ پہلا ہے۔', 'یہ دوسرا ہے؟'])
  })
})

describe('line state', () => {
  it('counts the changed lines and skips blank ones', () => {
    const lines = [line('a', { status: 'ready' }), line('b', { status: 'stale' }), line('c'), line('d', { text: ' ', status: 'empty' }), line('e', { status: 'rendering' }), line('f', { status: 'failed' })]
    expect(changedLines(lines).map((l) => l.id)).toEqual(['b', 'c', 'f'])
  })

  it('gates the mix and says why', () => {
    expect(mixBlockedReason([])).toBe('Add a line to mix')
    expect(mixBlockedReason([line('a', { status: 'ready' }), line('b', { status: 'stale' })])).toBe('1 line to render first')
    expect(mixBlockedReason([line('a', { status: 'ready' }), line('b', { status: 'rendering' })])).toBe('1 line still rendering')
    expect(mixBlockedReason([line('a', { status: 'ready' })], true)).toBe('Saving your changes…')
    expect(mixBlockedReason([line('a', { status: 'ready' }), line('b', { text: '' })])).toBeNull()
  })

  it('marks a line edited since its save as changed', () => {
    const server = [line('a', { status: 'ready', take_id: 'g1' }), line('b', { status: 'ready', take_id: 'g2' })]
    const local = [{ ...server[0], text: 'something else' }, server[1], line('new')]
    const merged = mergeServer(local, server, true)
    expect(merged.map((l) => l.status)).toEqual(['stale', 'ready', 'empty'])
    expect(merged[0].text).toBe('something else')
    expect(mergeServer(local, server, false)).toBe(server)
  })

  it('estimates the runtime from words, real takes and gaps', () => {
    const lines = [line('a'), line('b', { para: true }), line('c', { status: 'ready', duration_s: 3 }), line('d', { pause_after_s: 2 })]
    // 2 + 0.5 + 2 + 1 + 3 + 0.5 + 2 (no gap after the last)
    expect(runtimeEstimate(lines, S)).toBeCloseTo(11)
    expect(gapAfter(lines[3], S)).toBe(2)
  })

  it('moves a line within bounds', () => {
    expect(moveLine(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    const same = ['a', 'b']
    expect(moveLine(same, 0, -1)).toBe(same)
  })
})
