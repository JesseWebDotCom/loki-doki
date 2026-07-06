import { describe, expect, test } from 'bun:test'
import { atempoChain, compileFilterGraph, type RenderPlan } from './filtergraph'

const CANVAS = { width: 1280, height: 720, fps: 30 }

function planWith(clips: RenderPlan['clips'], inputs?: RenderPlan['inputs']): RenderPlan {
  return {
    canvas: CANVAS,
    inputs: inputs ?? [{ path: '/tmp/a.mp4', hasAudio: true }, { path: '/tmp/b.mp4', hasAudio: false }],
    clips,
  }
}

describe('atempoChain', () => {
  test('identity at 1x', () => expect(atempoChain(1)).toEqual([]))
  test('single instance within range', () => expect(atempoChain(1.5)).toEqual(['atempo=1.5']))
  test('chains above 2x', () => expect(atempoChain(4)).toEqual(['atempo=2', 'atempo=2']))
  test('chains below 0.5x', () => expect(atempoChain(0.25)).toEqual(['atempo=0.5', 'atempo=0.5']))
  test('mixed chain for 3x', () => {
    const chain = atempoChain(3)
    expect(chain[0]).toBe('atempo=2')
    expect(chain[1]).toBe('atempo=1.5')
    // Product of factors reproduces the requested speed.
    const product = chain.map((c) => parseFloat(c.split('=')[1]!)).reduce((a, b) => a * b, 1)
    expect(product).toBeCloseTo(3)
  })
})

describe('compileFilterGraph', () => {
  test('rejects an empty timeline', () => {
    expect(() => compileFilterGraph(planWith([]))).toThrow(/empty timeline/)
  })

  test('rejects a clip pointing at a missing input', () => {
    expect(() => compileFilterGraph(planWith([{ inputIndex: 5, in: 0, out: 3, speed: 1, muted: false }])))
      .toThrow(/missing input/)
  })

  test('single clip: normalize chain + 1-part concat', () => {
    const g = compileFilterGraph(planWith([{ inputIndex: 0, in: 2, out: 8, speed: 1, muted: false }]))
    expect(g.inputArgs).toEqual(['-i', '/tmp/a.mp4', '-i', '/tmp/b.mp4'])
    expect(g.filterComplex).toContain('[0:v]trim=start=2:end=8')
    expect(g.filterComplex).toContain('setpts=(PTS-STARTPTS)/1')
    expect(g.filterComplex).toContain(`scale=1280:720:force_original_aspect_ratio=decrease`)
    expect(g.filterComplex).toContain('pad=1280:720:(ow-iw)/2:(oh-ih)/2')
    expect(g.filterComplex).toContain('[0:a]atrim=start=2:end=8')
    expect(g.filterComplex).toContain('concat=n=1:v=1:a=1[outv][outa]')
    expect(g.mapArgs).toEqual(['-map', '[outv]', '-map', '[outa]'])
  })

  test('speed applies to video PTS and audio tempo', () => {
    const g = compileFilterGraph(planWith([{ inputIndex: 0, in: 0, out: 10, speed: 2, muted: false }]))
    expect(g.filterComplex).toContain('setpts=(PTS-STARTPTS)/2')
    expect(g.filterComplex).toContain('atempo=2')
  })

  test('muted and audio-less clips get exact-duration silence', () => {
    const g = compileFilterGraph(planWith([
      { inputIndex: 0, in: 0, out: 6, speed: 2, muted: true },    // has audio but muted
      { inputIndex: 1, in: 1, out: 4, speed: 1, muted: false },   // source has no audio
    ]))
    // 6s at 2x → 3s silence; 3s at 1x → 3s silence.
    const silences = g.filterComplex.match(/anullsrc[^;]*atrim=duration=3\[a\d\]/g) ?? []
    expect(silences.length).toBe(2)
    expect(g.filterComplex).toContain('concat=n=2:v=1:a=1')
  })

  test('clips from the same input reuse one -i entry', () => {
    const g = compileFilterGraph(planWith([
      { inputIndex: 0, in: 0, out: 2, speed: 1, muted: false },
      { inputIndex: 0, in: 5, out: 9, speed: 1, muted: false },
    ]))
    expect(g.inputArgs.filter((a) => a === '-i').length).toBe(2)   // 2 declared inputs, not per-clip
    expect(g.filterComplex).toContain('concat=n=2:v=1:a=1')
  })
})
