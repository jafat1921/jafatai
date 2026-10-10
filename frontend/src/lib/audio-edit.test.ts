import { describe as group, expect, it } from 'vitest'
import {
  addCut,
  changesSound,
  clampRegion,
  compact,
  describe,
  keepRegion,
  keptSegments,
  levelMatch,
  mergeCuts,
  outputLength,
  outputToSource,
  sourceToOutput,
  stamp,
} from './audio-edit'

group('compact', () => {
  it('an untouched edit is an empty object', () => {
    expect(compact({})).toEqual({})
    expect(compact({ gain_db: 0, speed: 1, pitch: 0, cuts: [], append: [], markers: [], silence_trim: false, chain: null, loudness: null, loop_to: null })).toEqual({})
    expect(compact({ fade_in: { s: 0, curve: 'tri' } })).toEqual({})
  })

  it('a trim over the whole file is no trim', () => {
    expect(compact({ trim: { start: 0, end: 30 } }, 30)).toEqual({})
    expect(compact({ trim: { start: 1, end: 30 } }, 30)).toEqual({ version: 1, trim: { start: 1, end: 30 } })
  })

  it('keeps what changed, clamps ranges and merges cuts', () => {
    expect(
      compact({
        gain_db: 40,
        speed: 1.25,
        pitch: -2.4,
        cuts: [{ start: 5, end: 6 }, { start: 2, end: 3 }, { start: 5.5, end: 7 }],
        chain: { preset: 'warm', amount: 42.6 },
        loudness: { target: 'web' },
        markers: [{ t: 1.23456, label: 'x'.repeat(60) }],
      }),
    ).toEqual({
      version: 1,
      gain_db: 24,
      speed: 1.25,
      pitch: -2,
      cuts: [{ start: 2, end: 3 }, { start: 5, end: 7 }],
      chain: { preset: 'warm', amount: 43 },
      loudness: { target: 'web' },
      markers: [{ t: 1.235, label: 'x'.repeat(40) }],
    })
  })

  it('markers alone do not change the sound', () => {
    expect(changesSound(compact({ markers: [{ t: 1, label: 'Hit' }] }))).toBe(false)
    expect(changesSound(compact({ gain_db: 3 }))).toBe(true)
  })
})

group('describe', () => {
  it('reads the stack in plain words', () => {
    expect(describe({})).toBe('No changes')
    expect(
      describe({
        trim: { start: 5, end: 80 },
        cuts: [{ start: 10, end: 12 }, { start: 20, end: 21 }],
        gain_db: 3,
        speed: 1.5,
        pitch: -2,
        chain: { preset: 'cinematic', amount: 60 },
        fade_in: { s: 2, curve: 'qsin' },
        loudness: { target: 'broadcast' },
      }),
    ).toBe('Trim 0:05.0–1:20.0 · 2 cuts · Speed 1.5× · Pitch −2 st · Cinematic 60% · +3 dB · Fade in 2 s · Broadcast −23 LUFS')
  })

  it('stamps carry tenths', () => {
    expect(stamp(65.34)).toBe('1:05.3')
    expect(stamp(-1)).toBe('0:00.0')
  })
})

group('region maths', () => {
  it('clamps and orders a dragged region', () => {
    expect(clampRegion({ start: 12, end: -3 }, 10)).toEqual({ start: 0, end: 10 })
  })

  it('merges overlapping and touching cuts, drops empty ones', () => {
    expect(mergeCuts([{ start: 4, end: 6 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 5, end: 8 }, { start: 9, end: 9 }])).toEqual([
      { start: 1, end: 3 },
      { start: 4, end: 8 },
    ])
  })

  it('a cut stays inside the trim, and keeping a region drops the cuts outside it', () => {
    const e = addCut({ trim: { start: 2, end: 8 } }, { start: 0, end: 3 }, 10)
    expect(e.cuts).toEqual([{ start: 2, end: 3 }])
    expect(addCut({}, { start: 1, end: 1.01 }, 10)).toEqual({})
    const k = keepRegion({ cuts: [{ start: 1, end: 2 }, { start: 5, end: 6 }] }, { start: 4, end: 9 }, 10)
    expect(k).toEqual({ trim: { start: 4, end: 9 }, cuts: [{ start: 5, end: 6 }] })
  })

  it('maps source time to the edited output and back', () => {
    const edit = { trim: { start: 2, end: 10 }, cuts: [{ start: 4, end: 6 }] }
    expect(keptSegments(edit, 12)).toEqual([{ start: 2, end: 4 }, { start: 6, end: 10 }])
    expect(outputLength(edit, 12)).toBe(6)
    expect(sourceToOutput(3, edit, 12)).toBe(1)
    // inside a cut lands on the join
    expect(sourceToOutput(5, edit, 12)).toBe(2)
    expect(sourceToOutput(7, edit, 12)).toBe(3)
    expect(outputToSource(3, edit, 12)).toBe(7)
    expect(outputToSource(99, edit, 12)).toBe(10)
    // speed squeezes the output
    expect(outputLength({ ...edit, speed: 2 }, 12)).toBe(3)
    expect(outputToSource(1.5, { ...edit, speed: 2 }, 12)).toBe(7)
  })

  it('level matching turns the louder side down to the quieter one', () => {
    const { a, b } = levelMatch(-10, -16)
    expect(b).toBe(1)
    expect(a).toBeCloseTo(0.501, 3)
    expect(levelMatch(null, -14)).toEqual({ a: 1, b: 1 })
  })
})
