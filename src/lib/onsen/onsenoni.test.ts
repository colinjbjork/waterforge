import { describe, expect, it } from 'vitest'
import { fromOnsenOni, pickSource } from './onsenoni'
import {
  normalizeOnsen,
  renderText,
  runOnsen,
  validateOnsenInput,
} from './index'

// Trimmed from a real get_water_analysis payload (Gekkoen Yugetsusanso, Arima,
// 2026-09-10): two sources, the second poorly extracted.
const PAYLOAD = {
  hasAnalysis: true,
  place: {
    id: '9c11c92592',
    nameEn: 'Gekkoen Yugetsusanso',
    nameJa: '有馬温泉 月光園游月山荘',
  },
  sourceCount: 2,
  sources: [
    {
      nameEn: 'Arima Onsen Gekkoen Spring No. 2',
      sourceId: 'act3vx3pys',
      analysis: {
        classification: {
          primaryType: 'CHLORIDE',
          springQualityFull: 'ナトリウム−塩化物泉(低張性・中性・温泉)',
          springQualityShort: 'Na-Cl泉',
        },
        components: [
          { block: 'CATION', code: 'Na', mg: 1788, qualifier: 'EXACT' },
          { block: 'CATION', code: 'Ca', mg: 327, qualifier: 'EXACT' },
          { block: 'CATION', code: 'K', mg: 84.1, qualifier: 'EXACT' },
          { block: 'CATION', code: 'Mg', mg: 18.15, qualifier: 'EXACT' },
          { block: 'CATION', code: 'NH4', mg: 1.3, qualifier: 'EXACT' },
          { block: 'CATION', code: 'Fe2', mg: 0.1, qualifier: 'EXACT' },
          { block: 'ANION', code: 'Cl', mg: 3036, qualifier: 'EXACT' },
          { block: 'ANION', code: 'Br', mg: 6.72, qualifier: 'EXACT' },
          { block: 'ANION', code: 'HS', mg: null, qualifier: 'LESS_THAN' },
          {
            block: 'NON_DISSOCIATED',
            code: 'H2SiO3',
            mg: 84.1,
            qualifier: 'EXACT',
          },
          {
            block: 'NON_DISSOCIATED',
            code: 'HBO2',
            mg: 60.2,
            qualifier: 'EXACT',
          },
          { block: 'GAS', code: 'CO2', mg: 400.2, qualifier: 'EXACT' },
        ],
        measured: {
          phSource: 6.4,
          sourceTempC: 38.3,
          freeCo2Mg: 400.2,
          freeH2sMg: null,
          totalSoluteMg: 6508,
        },
        extraction: {
          confidence: 'PARTIAL',
          lowConfidenceNotes: 'digits read with effort',
        },
        certificate: {
          labName: '日本水処理工業株式会社',
          certificateNumber: 'No.188-019',
          analyzedAt: '2018-10-29T00:00:00.000Z',
        },
      },
    },
    {
      nameEn: 'Kobe Arima Onsen Kutani Spring',
      sourceId: 'r8jog83twn',
      analysis: {
        classification: {
          primaryType: 'CHLORIDE',
          springQualityShort: 'Na-Cl強塩泉',
        },
        components: [
          { block: 'CATION', code: 'Na', mg: 4358, qualifier: 'EXACT' },
          { block: 'CATION', code: 'Ca', mg: null, qualifier: 'UNKNOWN' },
          { block: 'ANION', code: 'Cl', mg: 7689, qualifier: 'EXACT' },
        ],
        measured: { phSource: null, sourceTempC: null, totalSoluteMg: 14440 },
        extraction: { confidence: 'LOW', lowConfidenceNotes: 'half the frame' },
      },
    },
  ],
}

describe('fromOnsenOni', () => {
  it('defaults to the best-extracted source and maps blocks to groups', () => {
    const { input, sourceIndex } = fromOnsenOni(PAYLOAD)
    expect(sourceIndex).toBe(0)
    expect(input.units).toBe('mg/kg')
    expect(input.name).toContain('Gekkoen Yugetsusanso')
    expect(input.name).toContain('Spring No. 2')
    expect(input.cations).toEqual({
      Na: 1788,
      Ca: 327,
      K: 84.1,
      Mg: 18.15,
      NH4: 1.3,
      Fe2: 0.1,
    })
    expect(input.anions).toEqual({ Cl: 3036, Br: 6.72 })
    expect(input.undissociated).toEqual({
      H2SiO3: 84.1,
      HBO2: 60.2,
      CO2: 400.2,
    })
    expect(input.ph).toBe(6.4)
    expect(input.temperature_c).toBe(38.3)
    expect(input.spring_type).toContain('塩化物泉')
  })

  it('drops non-EXACT components and says so in the notes', () => {
    const { input } = fromOnsenOni(PAYLOAD)
    expect(input.anions?.HS).toBeUndefined()
    expect(input.notes?.join('\n')).toContain('HS (below detection)')
    expect(input.notes?.join('\n')).toContain('PARTIAL')
    expect(input.notes?.join('\n')).toContain('2 sources')
  })

  it('produces input the validator accepts and the pipeline can run', () => {
    const { input } = fromOnsenOni(PAYLOAD, {
      bathVolume: { value: 200, unit: 'L' },
    })
    const v = validateOnsenInput(input)
    expect(v.ok).toBe(true)
    const r = runOnsen(normalizeOnsen(input))
    expect(r.batch).toEqual({ volume: 200, unit: 'L' })
    expect(r.recipe.length).toBeGreaterThan(0)
    const na = r.match.find((m) => m.ion === 'Na')!
    // The card is not exactly NaCl-proportioned, so a best fit lands within ~10%.
    expect(Math.abs(na.diffPct!)).toBeLessThan(10)
    const txt = renderText(r)
    expect(txt).toContain('extraction confidence for this sheet is PARTIAL')
    expect(txt).toContain('iron species')
  })

  it('selects a source by index, id, or name substring', () => {
    expect(pickSource(PAYLOAD.sources, 1)).toBe(1)
    expect(pickSource(PAYLOAD.sources, '1')).toBe(1)
    expect(pickSource(PAYLOAD.sources, 'r8jog83twn')).toBe(1)
    expect(pickSource(PAYLOAD.sources, 'kutani')).toBe(1)
    expect(pickSource(PAYLOAD.sources, 'nope')).toBe(-1)
    expect(fromOnsenOni(PAYLOAD, { source: 'kutani' }).input.cations).toEqual({
      Na: 4358,
    })
    expect(() => fromOnsenOni(PAYLOAD, { source: 'nope' })).toThrow(/not found/)
  })

  it('refuses a place with no analysis', () => {
    expect(() =>
      fromOnsenOni({ hasAnalysis: false, place: { nameEn: 'X' }, sources: [] }),
    ).toThrow(/no water analysis/)
  })

  it('adds free H2S from measured when the table lacks it', () => {
    const p = JSON.parse(JSON.stringify(PAYLOAD))
    p.sources[0].analysis.measured.freeH2sMg = 2.5
    const { input } = fromOnsenOni(p)
    expect(input.undissociated?.H2S).toBe(2.5)
  })
})
