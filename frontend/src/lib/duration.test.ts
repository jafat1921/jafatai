import { describe, expect, it } from 'vitest'
import { durationError, estimateText, formatDuration, formatTimecode, isLongTake, localEstimate, parseDuration } from './duration'

describe('parseDuration', () => {
  it.each([
    ['75', 75],
    ['75s', 75],
    ['75 sec', 75],
    ['1:15', 75],
    ['0:09', 9],
    ['2m', 120],
    ['2 min', 120],
    ['2 minutes', 120],
    ['1m30s', 90],
    ['1m 30', 90],
    ['1.5m', 90],
    [' 20 ', 20],
  ])('reads %j as %i s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected)
  })

  it.each(['', 'abc', '1:75', '-5', 'm', '2h'])('rejects %j', (input) => {
    expect(parseDuration(input)).toBeNull()
  })
})

describe('durationError', () => {
  it('enforces 1 s and the server maximum', () => {
    expect(durationError(0)).toMatch(/at least 1 second/i)
    expect(durationError(1)).toBeNull()
    expect(durationError(300)).toBeNull()
    expect(durationError(301)).toBe('Up to 5 min per take.')
    expect(durationError(200, 180)).toBe('Up to 3 min per take.')
    expect(durationError(null)).toMatch(/1:15/)
  })
})

describe('formatting', () => {
  it('formats durations and timecodes', () => {
    expect(formatDuration(45)).toBe('45 s')
    expect(formatDuration(120)).toBe('2 min')
    expect(formatDuration(75)).toBe('1 min 15 s')
    expect(formatTimecode(1122)).toBe('18:42')
    expect(formatTimecode(3725)).toBe('1:02:05')
  })

  it('says chunks and GPU time in plain words', () => {
    expect(estimateText({ chunks: 8, est_gpu_s: 360 })).toBe('8 chunks · about 6 min on the GPU')
    expect(estimateText({ chunks: 1, est_gpu_s: 30 })).toBe('1 chunk · about 30 s on the GPU')
    expect(estimateText({ chunks: 8, est_gpu_s: 360 }, 3)).toBe('3 takes × 8 chunks · about 18 min on the GPU')
  })

  it('guesses chunks locally like the server does', () => {
    expect(localEstimate(10).chunks).toBe(1)
    expect(localEstimate(60).chunks).toBe(9)
    expect(localEstimate(60).est_gpu_s).toBe(360)
  })

  it('treats anything past one chunk, or the long-take type, as a long take', () => {
    expect(isLongTake({ duration_s: 10, shot_type: 'wide' })).toBe(false)
    expect(isLongTake({ duration_s: 11, shot_type: 'wide' })).toBe(true)
    expect(isLongTake({ duration_s: 5, shot_type: 'long_take' })).toBe(true)
  })
})
