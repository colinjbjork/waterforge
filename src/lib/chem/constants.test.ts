import { describe, expect, it } from 'vitest'
import {
  CACO3_EQUIVALENT_WEIGHT,
  CACO3_WEIGHT,
  HCO3_WEIGHT,
  IONS,
  SALT_ORDER,
  SALTS,
  SO4_WEIGHT,
} from './constants'

describe('derived group weights', () => {
  it('SO4 weight is summed from S and O', () => {
    // S + 4*O = 96.056; the commonly quoted 96.06 rounds the same sum.
    expect(SO4_WEIGHT).toBeCloseTo(96.056, 3)
  })

  it('HCO3 weight is summed from H, C and O', () => {
    // H + C + 3*O = 61.016; the commonly quoted 61.017 rounds the same sum.
    expect(HCO3_WEIGHT).toBeCloseTo(61.016, 3)
  })

  it('CaCO3 weight and its equivalent weight', () => {
    // Ca + C + 3*O = 100.086; equivalent weight is half (two charge equivalents).
    expect(CACO3_WEIGHT).toBeCloseTo(100.086, 3)
    expect(CACO3_EQUIVALENT_WEIGHT).toBeCloseTo(50.043, 3)
  })
})

describe('ion charges', () => {
  it('matches the expected valences', () => {
    expect(IONS.Ca.charge).toBe(+2)
    expect(IONS.Mg.charge).toBe(+2)
    expect(IONS.Na.charge).toBe(+1)
    expect(IONS.K.charge).toBe(+1)
    expect(IONS.HCO3.charge).toBe(-1)
    expect(IONS.SO4.charge).toBe(-2)
    expect(IONS.Cl.charge).toBe(-1)
  })
})

describe('salt molar masses include water of hydration', () => {
  it('matches the documented constants', () => {
    expect(SALTS.gypsum.molarMass).toBe(172.17)
    expect(SALTS.epsom.molarMass).toBe(246.47)
    expect(SALTS.tableSalt.molarMass).toBe(58.44)
    expect(SALTS.calciumChloride.molarMass).toBe(147.01)
    expect(SALTS.bakingSoda.molarMass).toBe(84.007)
    expect(SALTS.chalk.molarMass).toBe(100.087)
    expect(SALTS.magnesiumChloride.molarMass).toBe(203.3)
    expect(SALTS.potassiumBicarbonate.molarMass).toBe(100.115)
  })

  it('chloride salts release two chloride ions per mole', () => {
    expect(SALTS.calciumChloride.stoichiometry.Cl).toBe(2)
    expect(SALTS.magnesiumChloride.stoichiometry.Cl).toBe(2)
  })
})

describe('salt charge balance', () => {
  // A dissolved salt is electrically neutral: the signed charges of the ions it
  // releases must sum to zero. This invariant guards every salt's stoichiometry
  // — e.g. it catches modelling CaCO3 as Ca + 1 HCO3 rather than Ca + 2 HCO3.
  // The onsen fork's sodium metasilicate and hydrochloric acid are the
  // declared exceptions: the counter-ion is water's own (OH⁻ or H⁺), which is
  // not a modelled ion, so they declare `netCharge` (+2 and −1) and the onsen
  // layer accounts for it. Every other salt must still be zero.
  it('every salt releases ions that sum to its declared net charge (zero unless stated)', () => {
    for (const id of Object.keys(SALTS) as (keyof typeof SALTS)[]) {
      let charge = 0
      for (const [ion, moles] of Object.entries(SALTS[id].stoichiometry)) {
        charge += IONS[ion as keyof typeof IONS].charge * (moles ?? 0)
      }
      expect(charge, `${id} should be charge-balanced`).toBe(
        SALTS[id].netCharge ?? 0,
      )
    }
  })

  it('only sodium metasilicate (in the palette) and the acid declare a net charge', () => {
    const inPalette = SALT_ORDER.filter((id) => SALTS[id].netCharge)
    expect(inPalette).toEqual(['sodiumMetasilicate'])
    expect(SALTS.sodiumMetasilicate.netCharge).toBe(+2)
    const all = (Object.keys(SALTS) as (keyof typeof SALTS)[]).filter(
      (id) => SALTS[id].netCharge,
    )
    expect(all.sort()).toEqual(['hydrochloricAcid', 'sodiumMetasilicate'])
    expect(SALTS.hydrochloricAcid.netCharge).toBe(-1)
  })
})
