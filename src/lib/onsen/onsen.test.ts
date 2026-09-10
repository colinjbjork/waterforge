import { describe, expect, it } from 'vitest'
import {
  EXCLUDED_KEYS,
  EXTRA_SPECIES,
  mvalToMg,
  normalizeOnsen,
  boxTable,
  renderMarkdown,
  renderText,
  runOnsen,
  toMgPerL,
  validateOnsenInput,
} from './index'
import type { OnsenInput } from './index'
import { IONS, SALT_ORDER, SALTS } from '../chem'
import { forward } from '../solver/matrix'
import { LITRES_PER_US_GALLON } from '../chem/conversions'

const EXAMPLE: OnsenInput = {
  name: 'Example Onsen, Source No. 1',
  units: 'mg/kg',
  ph: 8.4,
  temperature_c: 52.0,
  spring_type: 'Sodium-Chloride',
  cations: { Na: 820.0, K: 35.0, Ca: 60.0, Mg: 4.2, Fe2: 0.3 },
  anions: { Cl: 1150.0, SO4: 210.0, HCO3: 180.0, CO3: 6.0, OH: 0.1, HS: 1.2 },
  undissociated: { H2SiO3: 95.0, HBO2: 12.0, CO2: 3.0, H2S: 0.8 },
  bath_volume: { value: 250, unit: 'L' },
  source_water: { Ca: 8.0, Mg: 2.0, Na: 5.0, HCO3: 30.0, Cl: 4.0, SO4: 3.0 },
}

function errorsOf(raw: unknown): string[] {
  const v = validateOnsenInput(raw)
  return v.ok ? [] : v.errors.map((e) => e.path)
}

describe('validation', () => {
  it('accepts the documented example', () => {
    expect(validateOnsenInput(EXAMPLE).ok).toBe(true)
  })

  it('rejects unknown or missing units', () => {
    expect(errorsOf({ ...EXAMPLE, units: 'ppm' })).toContain('units')
    const { units: _units, ...noUnits } = EXAMPLE
    void _units
    expect(errorsOf(noUnits)).toContain('units')
  })

  it('rejects negative and non-numeric concentrations', () => {
    expect(errorsOf({ ...EXAMPLE, cations: { Na: -1 } })).toContain(
      'cations.Na',
    )
    expect(errorsOf({ ...EXAMPLE, anions: { Cl: 'lots' } })).toContain(
      'anions.Cl',
    )
    expect(errorsOf({ ...EXAMPLE, source_water: { Ca: -8 } })).toContain(
      'source_water.Ca',
    )
  })

  it('rejects a bad bath volume', () => {
    expect(
      errorsOf({ ...EXAMPLE, bath_volume: { value: 0, unit: 'L' } }),
    ).toContain('bath_volume.value')
    expect(
      errorsOf({ ...EXAMPLE, bath_volume: { value: 50, unit: 'm3' } }),
    ).toContain('bath_volume.unit')
  })

  it('rejects a card with no components, duplicate keys, and unknown top-level fields', () => {
    expect(errorsOf({ units: 'mg/L' })).toContain('cations')
    expect(
      errorsOf({ units: 'mg/L', cations: { Na: 1 }, anions: { Na: 1 } }),
    ).toContain('anions.Na')
    expect(errorsOf({ ...EXAMPLE, typo: 1 })).toContain('typo')
  })

  it('in mval mode, a charge-neutral species must be under undissociated', () => {
    expect(errorsOf({ units: 'mval', anions: { H2SiO3: 1.2 } })).toContain(
      'anions.H2SiO3',
    )
    expect(
      validateOnsenInput({ units: 'mval', undissociated: { H2SiO3: 95 } }).ok,
    ).toBe(true)
  })

  it('rejects an out-of-range pH', () => {
    expect(errorsOf({ ...EXAMPLE, ph: 15 })).toContain('ph')
  })
})

describe('units', () => {
  it('mval converts per ion as mval × M ÷ |z|', () => {
    expect(mvalToMg(10, IONS.Na.molarMass, +1)).toBeCloseTo(229.9, 6)
    expect(mvalToMg(2, IONS.Ca.molarMass, +2)).toBeCloseTo(40.078, 6)
    expect(toMgPerL('SO4', 1, 'mval', 'anions')).toBeCloseTo(
      IONS.SO4.molarMass / 2,
      9,
    )
    expect(toMgPerL('CO3', 1, 'mval', 'anions')).toBeCloseTo(
      IONS.CO3.molarMass / 2,
      9,
    )
    // Non-fitted but known species convert too, so the report can show mg/L.
    expect(toMgPerL('HS', 1, 'mval', 'anions')).toBeCloseTo(
      EXTRA_SPECIES.HS.molarMass,
      9,
    )
    expect(toMgPerL('Fe2', 1, 'mval', 'cations')).toBeCloseTo(
      EXTRA_SPECIES.Fe2.molarMass / 2,
      9,
    )
  })

  it('undissociated components are always mg, even on an mval card', () => {
    expect(toMgPerL('H2SiO3', 95, 'mval', 'undissociated')).toBe(95)
    expect(toMgPerL('CO2', 3, 'mval', 'undissociated')).toBe(3)
  })

  it('an unknown species in mval cannot be converted and gets no mg/L', () => {
    expect(toMgPerL('Xx', 1, 'mval', 'anions')).toBeUndefined()
    const norm = normalizeOnsen({ units: 'mval', anions: { Xx: 1, Cl: 1 } })
    expect(norm.notReplicated[0]).toMatchObject({
      key: 'Xx',
      reported: 1,
      unit: 'mval',
    })
    expect(norm.notReplicated[0].mgPerL).toBeUndefined()
  })

  it('an mval card normalises to the same mg/L target as its mg/L twin', () => {
    const mgCard: OnsenInput = {
      units: 'mg/L',
      cations: { Na: 229.9, Ca: 40.078 },
      anions: { Cl: 354.5, HCO3: 61.017 },
    }
    const mvalCard: OnsenInput = {
      units: 'mval',
      cations: {
        Na: 229.9 / IONS.Na.molarMass,
        Ca: (2 * 40.078) / IONS.Ca.molarMass,
      },
      anions: {
        Cl: 354.5 / IONS.Cl.molarMass,
        HCO3: 61.017 / IONS.HCO3.molarMass,
      },
    }
    const a = normalizeOnsen(mgCard).target
    const b = normalizeOnsen(mvalCard).target
    for (const ion of ['Na', 'Ca', 'Cl', 'HCO3'] as const) {
      expect(b[ion]).toBeCloseTo(a[ion]!, 9)
    }
  })

  it('mg/kg is treated as mg/L', () => {
    const kg = normalizeOnsen({ units: 'mg/kg', cations: { Na: 820 } })
    const l = normalizeOnsen({ units: 'mg/L', cations: { Na: 820 } })
    expect(kg.target).toEqual(l.target)
  })
})

describe('normalisation', () => {
  it('splits fitted ions from the not-replicated list', () => {
    const norm = normalizeOnsen(EXAMPLE)
    expect(norm.target).toEqual({
      Na: 820,
      K: 35,
      Ca: 60,
      Mg: 4.2,
      Cl: 1150,
      SO4: 210,
      HCO3: 180,
      CO3: 6,
      H2SiO3: 95,
    })
    expect(norm.notReplicated.map((n) => n.key).sort()).toEqual(
      ['CO2', 'Fe2', 'H2S', 'HBO2', 'HS', 'OH'].sort(),
    )
  })

  it('defaults bath volume to 250 L and source water to distilled', () => {
    const norm = normalizeOnsen({ units: 'mg/L', cations: { Na: 10 } })
    expect(norm.batch).toEqual({ volume: 250, unit: 'L' })
    expect(norm.source).toEqual({})
    expect(norm.name).toBe('Untitled onsen analysis')
  })

  it('keeps the requested bath volume and converts gallons when solving', () => {
    const norm = normalizeOnsen({
      units: 'mg/L',
      cations: { Na: 10 },
      anions: { Cl: 15.42 },
      bath_volume: { value: 60, unit: 'gal' },
    })
    expect(norm.batch).toEqual({ volume: 60, unit: 'gal' })
    const r = runOnsen(norm)
    expect(r.litres).toBeCloseTo(60 * LITRES_PER_US_GALLON, 9)
    const perL = r.recipe.find((x) => x.saltId === 'tableSalt')!
    expect(perL.grams).toBeCloseTo(
      perL.gramsPerLitre * 60 * LITRES_PER_US_GALLON,
      9,
    )
  })

  it('hydroxide is accepted and reported but not a fit target', () => {
    const norm = normalizeOnsen({ units: 'mg/L', anions: { OH: 0.1, Cl: 5 } })
    expect(norm.target.Cl).toBe(5)
    expect('OH' in norm.target).toBe(false)
    const oh = norm.notReplicated.find((n) => n.key === 'OH')!
    expect(oh.reason).toBe('reference-only')
    expect(oh.mgPerL).toBe(0.1)
  })

  it('ignores but names source_water keys the engine does not model', () => {
    const norm = normalizeOnsen({
      units: 'mg/L',
      cations: { Na: 10 },
      source_water: { Na: 2, Fe2: 0.05 },
    })
    expect(norm.source).toEqual({ Na: 2 })
    expect(norm.sourceWaterIgnored).toEqual(['Fe2'])
  })
})

describe('exclusions: sulfur and iron', () => {
  // Na and Cl in exact NaCl proportion so the only salt the fit needs is table
  // salt — any other ion in the result would be a by-product, not a fit.
  const card: OnsenInput = {
    units: 'mg/L',
    cations: { Na: 300, Fe2: 2.5 },
    anions: {
      Cl: (300 * IONS.Cl.molarMass) / IONS.Na.molarMass,
      HS: 6.1,
      S2O3: 0.4,
    },
    undissociated: { H2S: 1.9 },
  }

  it('none of HS, S2O3, H2S, Fe2 is fitted and each is listed as not replicated', () => {
    const norm = normalizeOnsen(card)
    expect(Object.keys(norm.target).sort()).toEqual(['Cl', 'Na'])
    const byKey = Object.fromEntries(norm.notReplicated.map((n) => [n.key, n]))
    expect(byKey.HS.reason).toBe('excluded-sulfur')
    expect(byKey.S2O3.reason).toBe('excluded-sulfur')
    expect(byKey.H2S.reason).toBe('excluded-sulfur')
    expect(byKey.Fe2.reason).toBe('excluded-iron')
    expect(byKey.HS.reported).toBe(6.1)
    expect(byKey.Fe2.reported).toBe(2.5)
  })

  it('the report keeps them out of the recipe and match tables', () => {
    const r = runOnsen(normalizeOnsen(card))
    expect(r.match.map((m) => m.ion)).toEqual(['Na', 'Cl'])
    const md = renderMarkdown(r)
    expect(md).toContain('## Not replicated')
    expect(md).toContain('sulfur species — excluded, never replicated')
    expect(md).toContain('iron species — excluded, never replicated')
    expect(md).toContain('no sulfur or iron ingredient is suggested')
  })

  it('iron aliases from real sheets (FeTotal, FeUnknownAlias) are excluded too', () => {
    const norm = normalizeOnsen({
      units: 'mg/kg',
      cations: { Na: 10, FeTotal: 1.6, FeXyz: 0.2, STotal: 0.1 },
    })
    const byKey = Object.fromEntries(
      norm.notReplicated.map((n) => [n.key, n.reason]),
    )
    expect(byKey.FeTotal).toBe('excluded-iron')
    expect(byKey.FeXyz).toBe('excluded-iron')
    expect(byKey.STotal).toBe('excluded-sulfur')
    expect(
      normalizeOnsen({ units: 'mg/kg', cations: { Sr: 1, Na: 1 } })
        .notReplicated[0].reason,
    ).toBe('no-ingredient')
  })

  it('no salt in the palette contains reduced sulfur or iron', () => {
    for (const id of SALT_ORDER) {
      const salt = SALTS[id]
      for (const key of Object.keys(salt.stoichiometry)) {
        expect(EXCLUDED_KEYS, `${id} releases ${key}`).not.toContain(key)
      }
      expect(salt.formula, id).not.toMatch(/Fe|HS\b|H2S|S2O3/)
    }
    expect(EXCLUDED_KEYS).toEqual(
      expect.arrayContaining(['HS', 'S2O3', 'H2S', 'S', 'Fe2', 'Fe3', 'Fe']),
    )
  })
})

describe('alkaline card: sodium carbonate + baking soda', () => {
  it('fits carbonate and reports an approximate pH', () => {
    const profile = forward({ sodiumCarbonate: 0.05, bakingSoda: 0.2 })
    const r = runOnsen(
      normalizeOnsen({
        units: 'mg/L',
        ph: 9.5,
        cations: { Na: profile.Na! },
        anions: { HCO3: profile.HCO3!, CO3: profile.CO3! },
      }),
    )
    const co3 = r.match.find((m) => m.ion === 'CO3')!
    expect(co3.result).toBeCloseTo(profile.CO3!, 6)
    expect(r.recipe.map((x) => x.saltId).sort()).toEqual([
      'bakingSoda',
      'sodiumCarbonate',
    ])
    expect(r.readouts.phEstimate).toBeDefined()
    expect(r.readouts.cardPh).toBe(9.5)
    const md = renderMarkdown(r)
    expect(md).toMatch(/Approximate pH ≈ \d+\.\d/)
    expect(md).toContain('Card pH: 9.5')
  })
})

describe('bordered text report (CLI default)', () => {
  it('draws a box table with aligned, padded columns', () => {
    const t = boxTable(
      ['Ion', 'mg/L'],
      [
        ['Na', '820.0'],
        ['Cl', '1150.0'],
      ],
      ['left', 'right'],
    )
    const lines = t.split('\n')
    expect(lines[0]).toBe('┌─────┬────────┐')
    expect(lines[1]).toBe('│ Ion │   mg/L │')
    expect(lines[2]).toBe('├─────┼────────┤')
    expect(lines[3]).toBe('│ Na  │  820.0 │')
    expect(lines[4]).toBe('│ Cl  │ 1150.0 │')
    expect(lines[5]).toBe('└─────┴────────┘')
    // every row is the same width
    expect(new Set(lines.map((l) => [...l].length)).size).toBe(1)
  })

  it('renders every section with box borders and no markdown pipe table', () => {
    const txt = renderText(runOnsen(normalizeOnsen(EXAMPLE)))
    for (const h of ['RECIPE', 'MATCH', 'NOT REPLICATED', 'WARNINGS']) {
      expect(txt).toContain(h)
    }
    expect(txt).toContain('┌')
    expect(txt).toContain('│ Ingredient')
    expect(txt).not.toMatch(/^\|.*\|$/m)
    expect(txt).not.toMatch(/\|\s*---/)
  })
})

describe('the documented example end to end', () => {
  const r = runOnsen(normalizeOnsen(EXAMPLE))

  it('builds a recipe from purchasable ingredients only', () => {
    expect(r.recipe.length).toBeGreaterThan(0)
    for (const line of r.recipe) {
      expect(line.purchaseName.length).toBeGreaterThan(0)
      expect(line.grams).toBeGreaterThan(0)
      expect(line.grams).toBeCloseTo(line.gramsPerLitre * 250, 6)
    }
  })

  it('lands the major ions within a few percent', () => {
    for (const ion of ['Na', 'Cl', 'SO4', 'Ca'] as const) {
      const m = r.match.find((x) => x.ion === ion)!
      expect(Math.abs(m.diffPct!), ion).toBeLessThan(5)
    }
  })

  it('renders every required Markdown section', () => {
    const md = renderMarkdown(r)
    for (const h of [
      '## Recipe',
      '## Match',
      '## Not replicated',
      '## Warnings',
    ]) {
      expect(md).toContain(h)
    }
    expect(md).toContain('| Ingredient | Formula | Grams for bath | g/L |')
    expect(md).toContain('| Ion | Target mg/L | Result mg/L | Difference |')
    expect(md).toContain('Charge residual')
  })
})
