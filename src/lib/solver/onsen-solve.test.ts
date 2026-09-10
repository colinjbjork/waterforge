import { describe, expect, it } from 'vitest'
import { estimatePh, solve } from './solve'
import { buildMatrix, contribution, forward } from './matrix'
import {
  ATOMIC_WEIGHTS,
  CO3_WEIGHT,
  H2O_WEIGHT,
  H2SIO3_WEIGHT,
  HCO3_WEIGHT,
  ION_ORDER,
  IONS,
  SALT_ORDER,
  SALTS,
  SO4_WEIGHT,
  type IonId,
  type SaltId,
} from '../chem'
import type { SaltDose } from './types'

// Tests for the onsen-fork engine additions: the two new ions, the six new
// salts, the opt-in `'relative'` weighting, and the approximate pH readout.

/** Expected mg ion / g salt / L from first principles. */
function expected(saltId: SaltId, ion: IonId, moles: number): number {
  return (1000 * moles * IONS[ion].molarMass) / SALTS[saltId].molarMass
}

describe('new ions', () => {
  it('carbonate and metasilicic acid are modelled with derived molar masses', () => {
    expect(IONS.CO3.charge).toBe(-2)
    // C + 3*O = 60.008; the commonly quoted 60.009 rounds the same sum.
    expect(IONS.CO3.molarMass).toBeCloseTo(60.008, 3)
    expect(IONS.H2SiO3.charge).toBe(0)
    expect(H2SIO3_WEIGHT).toBeCloseTo(
      2 * ATOMIC_WEIGHTS.H + ATOMIC_WEIGHTS.Si + 3 * ATOMIC_WEIGHTS.O,
      9,
    )
    expect(IONS.H2SiO3.molarMass).toBeCloseTo(78.098, 3)
    expect(ION_ORDER.slice(-2)).toEqual(['CO3', 'H2SiO3'])
  })
})

describe('new salt molar masses are summed from atomic weights', () => {
  it('sodium carbonate, anhydrous and decahydrate', () => {
    expect(SALTS.sodiumCarbonate.molarMass).toBeCloseTo(
      2 * ATOMIC_WEIGHTS.Na + CO3_WEIGHT,
      9,
    )
    expect(SALTS.sodiumCarbonate.molarMass).toBeCloseTo(105.989, 2)
    expect(SALTS.sodiumCarbonateDecahydrate.molarMass).toBeCloseTo(
      SALTS.sodiumCarbonate.molarMass + 10 * H2O_WEIGHT,
      9,
    )
    expect(SALTS.sodiumCarbonateDecahydrate.molarMass).toBeCloseTo(286.14, 1)
  })

  it('sodium sulfate, anhydrous and decahydrate', () => {
    expect(SALTS.sodiumSulfate.molarMass).toBeCloseTo(
      2 * ATOMIC_WEIGHTS.Na + SO4_WEIGHT,
      9,
    )
    expect(SALTS.sodiumSulfate.molarMass).toBeCloseTo(142.04, 1)
    expect(SALTS.sodiumSulfateDecahydrate.molarMass).toBeCloseTo(
      SALTS.sodiumSulfate.molarMass + 10 * H2O_WEIGHT,
      9,
    )
    expect(SALTS.sodiumSulfateDecahydrate.molarMass).toBeCloseTo(322.19, 1)
  })

  it('potassium chloride and sodium metasilicate pentahydrate', () => {
    expect(SALTS.potassiumChloride.molarMass).toBeCloseTo(
      ATOMIC_WEIGHTS.K + ATOMIC_WEIGHTS.Cl,
      9,
    )
    expect(SALTS.potassiumChloride.molarMass).toBeCloseTo(74.55, 1)
    expect(SALTS.sodiumMetasilicate.molarMass).toBeCloseTo(
      2 * ATOMIC_WEIGHTS.Na +
        ATOMIC_WEIGHTS.Si +
        3 * ATOMIC_WEIGHTS.O +
        5 * H2O_WEIGHT,
      9,
    )
    expect(SALTS.sodiumMetasilicate.molarMass).toBeCloseTo(212.14, 1)
  })
})

describe('new salt matrix coefficients (mg ion / g salt / L)', () => {
  it('sodium carbonate (anhydrous): 2 Na + 1 CO3, nothing else', () => {
    expect(contribution('sodiumCarbonate', 'Na')).toBeCloseTo(
      expected('sodiumCarbonate', 'Na', 2),
      9,
    )
    expect(contribution('sodiumCarbonate', 'CO3')).toBeCloseTo(
      expected('sodiumCarbonate', 'CO3', 1),
      9,
    )
    expect(contribution('sodiumCarbonate', 'HCO3')).toBe(0)
    expect(contribution('sodiumCarbonate', 'Cl')).toBe(0)
  })

  it('sodium carbonate decahydrate: same ions, lower per-gram yield', () => {
    expect(contribution('sodiumCarbonateDecahydrate', 'Na')).toBeCloseTo(
      expected('sodiumCarbonateDecahydrate', 'Na', 2),
      9,
    )
    expect(contribution('sodiumCarbonateDecahydrate', 'CO3')).toBeCloseTo(
      expected('sodiumCarbonateDecahydrate', 'CO3', 1),
      9,
    )
    expect(contribution('sodiumCarbonateDecahydrate', 'CO3')).toBeLessThan(
      contribution('sodiumCarbonate', 'CO3'),
    )
  })

  it("sodium sulfate decahydrate (Glauber's salt): 2 Na + 1 SO4", () => {
    expect(contribution('sodiumSulfateDecahydrate', 'Na')).toBeCloseTo(
      expected('sodiumSulfateDecahydrate', 'Na', 2),
      9,
    )
    expect(contribution('sodiumSulfateDecahydrate', 'SO4')).toBeCloseTo(
      expected('sodiumSulfateDecahydrate', 'SO4', 1),
      9,
    )
    expect(contribution('sodiumSulfateDecahydrate', 'Ca')).toBe(0)
  })

  it('sodium sulfate (anhydrous): 2 Na + 1 SO4', () => {
    expect(contribution('sodiumSulfate', 'Na')).toBeCloseTo(
      expected('sodiumSulfate', 'Na', 2),
      9,
    )
    expect(contribution('sodiumSulfate', 'SO4')).toBeCloseTo(
      expected('sodiumSulfate', 'SO4', 1),
      9,
    )
    // Two mmol Na per mmol SO4: mass ratio = 2 * Na / SO4 molar masses.
    expect(
      contribution('sodiumSulfate', 'Na') /
        contribution('sodiumSulfate', 'SO4'),
    ).toBeCloseTo((2 * IONS.Na.molarMass) / IONS.SO4.molarMass, 12)
  })

  it('potassium chloride: 1 K + 1 Cl', () => {
    expect(contribution('potassiumChloride', 'K')).toBeCloseTo(
      expected('potassiumChloride', 'K', 1),
      9,
    )
    expect(contribution('potassiumChloride', 'Cl')).toBeCloseTo(
      expected('potassiumChloride', 'Cl', 1),
      9,
    )
    expect(contribution('potassiumChloride', 'Na')).toBe(0)
  })

  it('sodium metasilicate pentahydrate: 2 Na + 1 H2SiO3, declared +2 net charge', () => {
    expect(contribution('sodiumMetasilicate', 'Na')).toBeCloseTo(
      expected('sodiumMetasilicate', 'Na', 2),
      9,
    )
    expect(contribution('sodiumMetasilicate', 'H2SiO3')).toBeCloseTo(
      expected('sodiumMetasilicate', 'H2SiO3', 1),
      9,
    )
    expect(contribution('sodiumMetasilicate', 'CO3')).toBe(0)
    expect(SALTS.sodiumMetasilicate.netCharge).toBe(2)
  })

  it('the matrix has a row for every ion, including the new ones', () => {
    const A = buildMatrix([...SALT_ORDER])
    expect(A.length).toBe(ION_ORDER.length)
    expect(
      A[ION_ORDER.indexOf('CO3')][SALT_ORDER.indexOf('sodiumCarbonate')],
    ).toBeGreaterThan(0)
    expect(
      A[ION_ORDER.indexOf('H2SiO3')][SALT_ORDER.indexOf('sodiumMetasilicate')],
    ).toBeGreaterThan(0)
  })

  it('every salt carries a purchaseName', () => {
    for (const id of SALT_ORDER) {
      expect(SALTS[id].purchaseName.trim().length, id).toBeGreaterThan(0)
    }
  })

  it('the new salts sit at the end of the priority order', () => {
    expect(SALT_ORDER.slice(-6)).toEqual([
      'sodiumCarbonate',
      'sodiumCarbonateDecahydrate',
      'sodiumSulfateDecahydrate',
      'sodiumSulfate',
      'potassiumChloride',
      'sodiumMetasilicate',
    ])
    expect(SALT_ORDER.slice(0, 9)).toEqual([
      'gypsum',
      'epsom',
      'tableSalt',
      'calciumChloride',
      'calciumChlorideAnhydrous',
      'bakingSoda',
      'chalk',
      'magnesiumChloride',
      'potassiumBicarbonate',
    ])
  })
})

describe('round trip with relative weighting', () => {
  // A determined palette: Ca, HCO3, CO3, H2SiO3 and K are each supplied by
  // exactly one salt, which pins the shared Na / Cl / SO4 too, so the exact
  // recipe is unique and must be recovered dose for dose.
  const PALETTE: SaltId[] = [
    'gypsum', // Ca + SO4
    'tableSalt', // Na + Cl
    'bakingSoda', // Na + HCO3
    'sodiumCarbonate', // Na + CO3
    'sodiumSulfateDecahydrate', // Na + SO4
    'potassiumChloride', // K + Cl
    'sodiumMetasilicate', // Na + H2SiO3
  ]
  const KNOWN: SaltDose = {
    gypsum: 0.15,
    tableSalt: 1.2,
    bakingSoda: 0.25,
    sodiumCarbonate: 0.02,
    sodiumSulfateDecahydrate: 0.4,
    potassiumChloride: 0.07,
    sodiumMetasilicate: 0.26,
  }

  it('recovers known doses of old and new salts on a determined palette', () => {
    const target = forward(KNOWN)
    const result = solve(
      target,
      {},
      PALETTE,
      { volume: 1, unit: 'L' },
      {
        weighting: 'relative',
      },
    )
    for (const salt of PALETTE) {
      expect(result.dosePerLitre[salt] ?? 0, salt).toBeCloseTo(
        KNOWN[salt] ?? 0,
        6,
      )
    }
    for (const ion of ION_ORDER) {
      expect(result.resultProfile[ion] ?? 0, ion).toBeCloseTo(
        target[ion] ?? 0,
        6,
      )
    }
  })

  it('still hits the target exactly on the full palette (recipe may differ, ions may not)', () => {
    // On the full palette the target is degenerate (KCl + NaHCO3 is the same
    // ion sum as KHCO3 + NaCl), so the priority policy may pick a different
    // exact recipe — but the ions it produces must still match to 6 decimals.
    const target = forward(KNOWN)
    const result = solve(
      target,
      {},
      SALT_ORDER,
      { volume: 1, unit: 'L' },
      {
        weighting: 'relative',
      },
    )
    for (const ion of ION_ORDER) {
      expect(result.resultProfile[ion] ?? 0, ion).toBeCloseTo(
        target[ion] ?? 0,
        6,
      )
    }
    // The unique-source salts cannot be substituted and must come back exact.
    for (const salt of [
      'gypsum',
      'sodiumCarbonate',
      'sodiumMetasilicate',
    ] as const) {
      expect(result.dosePerLitre[salt] ?? 0, salt).toBeCloseTo(KNOWN[salt]!, 6)
    }
  })

  it('scales the recipe to the bath volume', () => {
    const target = forward(KNOWN)
    const result = solve(
      target,
      {},
      PALETTE,
      { volume: 250, unit: 'L' },
      {
        weighting: 'relative',
      },
    )
    expect(result.recipe.sodiumMetasilicate).toBeCloseTo(0.26 * 250, 6)
  })
})

describe('weighting option', () => {
  it("defaults to 'absolute' and matches the explicit absolute call exactly", () => {
    const target = forward({ gypsum: 0.3, epsom: 0.2, tableSalt: 0.1 })
    const implicit = solve(target)
    const explicit = solve(
      target,
      {},
      SALT_ORDER,
      { volume: 1, unit: 'L' },
      {
        weighting: 'absolute',
      },
    )
    expect(explicit).toEqual(implicit)
  })

  it('relative weighting protects a small ion from being swamped by a large one', () => {
    // Palette: table salt only supplies Na+Cl at a fixed ratio; KCl supplies
    // K+Cl. Target: lots of Na and Cl, plus a small potassium figure that is
    // achievable only by adding KCl, which also nudges Cl. With absolute
    // weighting the tiny K residual barely registers against the big Cl row;
    // with relative weighting K is honoured within a few percent.
    const target = { Na: 1000, Cl: 1560, K: 4 }
    const palette: SaltId[] = ['tableSalt', 'potassiumChloride']
    const abs = solve(target, {}, palette)
    const rel = solve(
      target,
      {},
      palette,
      { volume: 1, unit: 'L' },
      {
        weighting: 'relative',
      },
    )
    const kErrAbs = Math.abs((abs.resultProfile.K ?? 0) - 4) / 4
    const kErrRel = Math.abs((rel.resultProfile.K ?? 0) - 4) / 4
    expect(kErrRel).toBeLessThanOrEqual(kErrAbs)
    expect(kErrRel).toBeLessThan(0.05)
  })
})

describe('approximate pH readout', () => {
  it('appears when both HCO3 and CO3 are in the result and follows 10.33 + log10(ratio)', () => {
    const target = forward({ sodiumCarbonate: 0.1, bakingSoda: 0.2 })
    const result = solve(
      target,
      {},
      SALT_ORDER,
      { volume: 1, unit: 'L' },
      {
        weighting: 'relative',
      },
    )
    expect(result.resultProfile.CO3).toBeGreaterThan(0)
    expect(result.resultProfile.HCO3).toBeGreaterThan(0)
    const molCo3 = result.resultProfile.CO3! / CO3_WEIGHT
    const molHco3 = result.resultProfile.HCO3! / HCO3_WEIGHT
    expect(result.readouts.phEstimate).toBeCloseTo(
      10.33 + Math.log10(molCo3 / molHco3),
      9,
    )
  })

  it('is absent when carbonate is missing', () => {
    const result = solve(forward({ bakingSoda: 0.2 }))
    expect(result.readouts.phEstimate).toBeUndefined()
    expect(estimatePh({ HCO3: 100 })).toBeUndefined()
    expect(estimatePh({ CO3: 100 })).toBeUndefined()
  })

  it('reads 10.33 at equal molar carbonate and bicarbonate', () => {
    expect(estimatePh({ HCO3: HCO3_WEIGHT, CO3: CO3_WEIGHT })).toBeCloseTo(
      10.33,
      9,
    )
  })
})
