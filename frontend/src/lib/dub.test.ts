import { describe, expect, it } from 'vitest'
import {
  allDone,
  changedIds,
  checkpoint,
  currentStage,
  DUB_STAGES,
  dubBusy,
  failure,
  fitPill,
  flagged,
  searchSegments,
  segmentAt,
  stamp,
  subtitlesUrl,
  windowRange,
  type DubSegment,
  type DubStage,
  type DubStageName,
} from './dub'

const stages = (over: Partial<Record<DubStageName, Partial<DubStage>>> = {}) =>
  Object.fromEntries(DUB_STAGES.map((s) => [s, { status: 'pending', progress: 0, ...over[s] }])) as Record<DubStageName, DubStage>

const done = (upto: DubStageName) => Object.fromEntries(DUB_STAGES.slice(0, DUB_STAGES.indexOf(upto) + 1).map((s) => [s, { status: 'done' }]))

const seg = (id: string, start: number, status?: string, extra: Partial<DubSegment> = {}): DubSegment => ({
  id,
  start,
  end: start + 2,
  speaker_id: 'spk1',
  source_text: `line ${id}`,
  target: status ? { ur: { text: 'متن', status: status as never } } : {},
  ...extra,
})

describe('the dub pipeline state', () => {
  it('says what the user has to check at each stop', () => {
    expect(checkpoint({ stage: 'speakers', stages: stages({ ...done('transcribe'), speakers: { status: 'review' } }) })).toMatch(/^Transcript ready/)
    expect(checkpoint({ stage: 'translate', stages: stages({ ...done('speakers'), translate: { status: 'review' } }) })).toMatch(/^Translation ready/)
    expect(checkpoint({ stage: 'render', stages: stages({ ...done('cast'), render: { status: 'running' } }) })).toBeNull()
  })

  it('finds the current, failed and finished stages', () => {
    const running = { stage: 'render' as const, stages: stages({ ...done('cast'), render: { status: 'running' } }), job: null }
    expect(currentStage(running)).toBe('render')
    expect(dubBusy(running)).toBe(true)
    expect(dubBusy({ ...running, stages: stages(done('cast')), job: { id: 'j', type: 'dub_stage', status: 'queued', progress: 0, message: '', attempts: 0, created_at: '' } })).toBe(true)
    const failed = stages({ ...done('cast'), render: { status: 'failed', error: 'CUDA out of memory' } })
    expect(failure({ stages: failed })).toEqual({ stage: 'render', error: 'CUDA out of memory' })
    expect(currentStage({ stage: 'cast', stages: failed })).toBe('render')
    expect(allDone({ stages: stages(done('mix')) })).toBe(true)
    expect(allDone({ stages: failed })).toBe(false)
  })

  it('counts the lines a regen would redo', () => {
    const segs = [seg('a', 0, 'verified'), seg('b', 2, 'stale'), seg('c', 4, 'failed'), seg('d', 6), seg('e', 8, 'skipped')]
    expect(changedIds(segs, 'ur')).toEqual(['b', 'c', 'd'])
  })

  it('turns verify results and fit into short labels', () => {
    expect(flagged({ verify: { wer: 0.5, overrun_s: 0.42, flags: ['wer', 'overrun'] } })).toEqual(['Heard differently (WER 50%)', 'Runs 0.4 s over'])
    expect(flagged({ verify: { wer: 0, overrun_s: 0, flags: [] } })).toEqual([])
    expect(fitPill({ fit: 'smart', tempo: 1.25 })).toEqual({ label: 'Smart fit · 1.25×', tone: 'warn' })
    expect(fitPill({ fit: 'stretch', tempo: 0.9 })).toEqual({ label: 'Stretch · 0.90×', tone: 'ok' })
    expect(fitPill({ fit: 'strict' }).label).toBe('Strict slot')
  })
})

describe('helpers', () => {
  it('windows a long list', () => {
    expect(windowRange(0, 420, 60, 1000)).toEqual([0, 23])
    expect(windowRange(6000, 420, 60, 1000)).toEqual([92, 115])
    expect(windowRange(59580, 420, 60, 1000)).toEqual([985, 1000])
    // nothing measured yet: a screenful anyway
    expect(windowRange(0, 0, 60, 5)).toEqual([0, 5])
  })

  it('finds lines by time and by words', () => {
    const rows = [
      { start: 0, end: 2, text: 'The boat left', clean: 'The boat left.' },
      { start: 2.5, end: 4, text: 'um, at dawn', clean: 'At dawn.' },
    ]
    expect(segmentAt(rows, 3)).toBe(1)
    expect(segmentAt(rows, 2.2)).toBe(-1)
    expect(searchSegments(rows, 'BOAT')).toEqual([0])
    expect(searchSegments(rows, 'um')).toEqual([1])
    expect(searchSegments(rows, 'um', true)).toEqual([])
    expect(searchSegments(rows, '  ')).toEqual([0, 1])
  })

  it('formats timestamps and subtitle links', () => {
    expect(stamp(0)).toBe('0:00.0')
    expect(stamp(75.26)).toBe('1:15.3')
    expect(subtitlesUrl('t1', 'vtt', true)).toBe('/api/transcripts/t1/subtitles?format=vtt&clean=true')
    expect(subtitlesUrl('t1', 'srt')).toBe('/api/transcripts/t1/subtitles?format=srt')
  })
})
