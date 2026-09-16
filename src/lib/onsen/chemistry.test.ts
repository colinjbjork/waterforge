import { describe, expect, it } from 'vitest'
import {
  acidReleased,
  amorphousSilicaLogK,
  cardAcidity,
  daviesLogGamma,
  estimateBathPh,
  hydroxideReleased,
  ionicStrength,
  precipitationWarnings,
  protonBalance,
  speciate,
  strongIonDifference,
} from './chemistry'
import { normalizeOnsen } from './normalize'
import { renderText, runOnsen } from './index'
import {
  ACIDS,
  IONS,
  MURIATIC_ACID_DENSITY_G_PER_ML,
  SALT_ORDER,
  SALTS,
} from '../chem'
import { forward } from '../solver/matrix'
import type { IonProfile } from '../solver/types'

// Tests for the bath chemistry the fit cannot see: hydroxide released by
// sodium metasilicate, the acid dosed to cancel it, the proton-balance pH,
// and the precipitation checks. Numbers are checked against hand
// calculations at 25 °C with activity = concentration.

/** mg/L profile of n mmol/L of a species. */
function mg(ion: keyof typeof IONS, mmol: number): number {
  return mmol * IONS[ion].molarMass
}

describe('proton-balance pH', () => {
  it('pure water and a neutral strong electrolyte read pH 7', () => {
    expect(estimateBathPh({})).toBeCloseTo(7, 6)
    expect(estimateBathPh({ Na: mg('Na', 20), Cl: mg('Cl', 20) })).toBeCloseTo(
      7,
      6,
    )
  })

  it('4.8 mM sodium metasilicate alone sits near pH 11.7', () => {
    // 2 OH⁻ per mole; the second silicic pKa (13.2) keeps most silicate as
    // HSiO₃⁻ so the free hydroxide is a little under 2 × 4.8 mM.
    const bath: IonProfile = { Na: mg('Na', 9.6), H2SiO3: mg('H2SiO3', 4.8) }
    const ph = estimateBathPh(bath)
    expect(ph).toBeGreaterThan(11.4)
    expect(ph).toBeLessThan(11.9)
    expect(strongIonDifference(bath)).toBeCloseTo(9.6e-3, 9)
  })

  it('neutralising that hydroxide with 9.7 mM HCl lands at pH 4.0', () => {
    const bath: IonProfile = {
      Na: mg('Na', 9.6),
      H2SiO3: mg('H2SiO3', 4.8),
      Cl: mg('Cl', 9.7),
    }
    // Net 0.1 mM free acid → [H⁺] = 1e-4 → pH 4.0 (silicic acid is fully
    // protonated this far below its pKa).
    expect(estimateBathPh(bath)).toBeCloseTo(4.0, 1)
    const s = speciate(bath, 4.0)
    expect(s.h4sio4 / 4.8e-3).toBeGreaterThan(0.999)
  })

  it('a bicarbonate solution reads near pH 8.3 and carbonate/bicarbonate near Henderson–Hasselbalch', () => {
    expect(
      estimateBathPh({ Na: mg('Na', 3), HCO3: mg('HCO3', 3) }),
    ).toBeCloseTo(8.3, 0)
    const mixed = forward({ sodiumCarbonate: 0.1, bakingSoda: 0.2 })
    const hh =
      10.33 +
      Math.log10(
        mixed.CO3! / IONS.CO3.molarMass / (mixed.HCO3! / IONS.HCO3.molarMass),
      )
    expect(Math.abs(estimateBathPh(mixed) - hh)).toBeLessThan(0.1)
  })

  it('the balance is monotonic in pH and zero at the estimate', () => {
    const bath: IonProfile = {
      Na: mg('Na', 9.6),
      H2SiO3: mg('H2SiO3', 4.8),
      Cl: mg('Cl', 5),
      HCO3: mg('HCO3', 1),
    }
    let prev = -Infinity
    for (let ph = 0; ph <= 14; ph += 0.5) {
      const v = protonBalance(bath, ph)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
    expect(Math.abs(protonBalance(bath, estimateBathPh(bath)))).toBeLessThan(
      1e-9,
    )
  })
})

describe('hydroxide and acid from doses', () => {
  it('sodium metasilicate releases 2 meq per mmol; muriatic acid 1 meq H⁺ per mmol', () => {
    // 1.046 g/L Na2SiO3·5H2O = 4.93 mmol/L → 9.86 meq/L OH⁻.
    expect(hydroxideReleased({ sodiumMetasilicate: 1.046 })).toBeCloseTo(
      (1.046 / SALTS.sodiumMetasilicate.molarMass) * 2000,
      9,
    )
    expect(hydroxideReleased({ sodiumMetasilicate: 1.046 })).toBeCloseTo(
      9.86,
      1,
    )
    expect(acidReleased({ hydrochloricAcid: 1.155 })).toBeCloseTo(
      (1.155 / SALTS.hydrochloricAcid.molarMass) * 1000,
      9,
    )
    // Ordinary salts release neither.
    expect(hydroxideReleased({ gypsum: 1, tableSalt: 2, bakingSoda: 1 })).toBe(
      0,
    )
    expect(
      acidReleased({ gypsum: 1, tableSalt: 2, sodiumMetasilicate: 1 }),
    ).toBe(0)
  })

  it('acids are defined as the retail product, sit outside SALT_ORDER, and carry a negative net charge', () => {
    for (const id of ACIDS) {
      expect(SALT_ORDER).not.toContain(id)
      expect(SALTS[id].netCharge).toBeLessThan(0)
      expect(SALTS[id].handling?.length ?? 0).toBeGreaterThan(0)
    }
    // Liquids carry a density; the two powders do not.
    expect(SALTS.hydrochloricAcid.densityGPerMl).toBeGreaterThan(0)
    expect(SALTS.lacticAcid.densityGPerMl).toBeGreaterThan(0)
    expect(SALTS.citricAcid.densityGPerMl).toBeUndefined()
    expect(SALTS.sodiumBisulfate.densityGPerMl).toBeUndefined()
    // 88 % w/w lactic acid: one mole (90.08 g) in 102.4 g of solution.
    expect(SALTS.lacticAcid.molarMass).toBeCloseTo(90.078 / 0.88, 2)
    expect(SALTS.citricAcid.molarMass).toBeCloseTo(192.12, 1)
    expect(SALTS.sodiumBisulfate.molarMass).toBeCloseTo(120.05, 1)
    // 14.5 % w/w: one mole of HCl (36.46 g) in 251.4 g of solution.
    expect(SALTS.hydrochloricAcid.molarMass).toBeCloseTo(36.458 / 0.145, 2)
  })
})

describe('card acidity', () => {
  it('reads the H⁺ / OH⁻ lines first, then the pH, else zero', () => {
    const withH = normalizeOnsen({
      units: 'mg/kg',
      ph: 3.9,
      cations: { Na: 10, H: 0.1 },
      anions: { Cl: 15 },
    })
    expect(cardAcidity(withH)).toEqual({
      meqPerL: expect.closeTo(0.1 / 1.008, 6),
      basis: 'card H⁺/OH⁻ lines',
    })
    const withOh = normalizeOnsen({
      units: 'mg/kg',
      cations: { Na: 10 },
      anions: { Cl: 15, OH: 0.17 },
    })
    expect(cardAcidity(withOh).meqPerL).toBeCloseTo(-0.01, 3)
    const phOnly = normalizeOnsen({
      units: 'mg/kg',
      ph: 3,
      cations: { Na: 10 },
      anions: { Cl: 15 },
    })
    expect(cardAcidity(phOnly)).toEqual({
      meqPerL: expect.closeTo(1.0, 6),
      basis: 'card pH',
    })
    const none = normalizeOnsen({ units: 'mg/kg', cations: { Na: 10 } })
    expect(cardAcidity(none)).toEqual({ meqPerL: 0, basis: 'none' })
  })
})

describe('precipitation checks', () => {
  const alkaline: IonProfile = {
    Na: mg('Na', 9.6),
    H2SiO3: mg('H2SiO3', 4.8),
    Ca: 40,
    Mg: 5.5,
  }

  it('flags brucite and silicate hydrate at pH 11.7, nothing of the sort at pH 4', () => {
    const hot = precipitationWarnings(alkaline, 11.7).map((w) => w.mineral)
    expect(hot).toContain('brucite')
    expect(hot).toContain('silicate-hydrate')
    const cold = precipitationWarnings(alkaline, 4.0).map((w) => w.mineral)
    expect(cold).not.toContain('brucite')
    expect(cold).not.toContain('silicate-hydrate')
    expect(cold).not.toContain('portlandite')
  })

  it('brucite SI follows log10([Mg][OH]²) + 11.25 with Davies activity coefficients', () => {
    const w = precipitationWarnings({ Mg: 5.5 }, 11.7).find(
      (x) => x.mineral === 'brucite',
    )!
    const mgMol = 5.5 / IONS.Mg.molarMass / 1000
    const oh = 10 ** (11.7 - 14)
    const I = ionicStrength({ Mg: 5.5 })
    expect(I).toBeCloseTo(mgMol * 2, 12)
    expect(w.saturationIndex).toBeCloseTo(
      Math.log10(mgMol * oh * oh) +
        daviesLogGamma(2, I) +
        2 * daviesLogGamma(1, I) +
        11.25,
      9,
    )
  })

  it('amorphous silica: −2.71 at 25 °C, flagged above ~200 mg/L H₂SiO₃ at 40 °C', () => {
    expect(amorphousSilicaLogK(25)).toBeCloseTo(-2.71, 1)
    const soluble = 10 ** amorphousSilicaLogK(40) * 1000 * IONS.H2SiO3.molarMass
    expect(soluble).toBeGreaterThan(190)
    expect(soluble).toBeLessThan(215)
    const rich = precipitationWarnings({ H2SiO3: 385 }, 4.0)
    expect(rich.map((w) => w.mineral)).toEqual(['amorphous-silica'])
    expect(rich[0].saturationIndex).toBeGreaterThan(0)
    expect(precipitationWarnings({ H2SiO3: 100 }, 4.0)).toEqual([])
  })
})

describe('report: acid dosing end to end', () => {
  // Hotel Fugetsu (Beppu), the fitted subset of its 温泉分析書.
  const fugetsu = normalizeOnsen({
    name: 'Hotel Fugetsu',
    units: 'mg/kg',
    ph: 3.9,
    cations: { Na: 964.6, K: 147.4, Ca: 40, Mg: 5.5, H: 0.1 },
    anions: { Cl: 1446, SO4: 454 },
    undissociated: { H2SiO3: 387.3 },
  })
  const r = runOnsen(fugetsu)

  it('adds muriatic acid to cancel the metasilicate hydroxide and reach the card pH', () => {
    const acid = r.recipe.find((x) => x.saltId === 'hydrochloricAcid')!
    expect(acid).toBeDefined()
    expect(acid.millilitres).toBeCloseTo(
      acid.grams / MURIATIC_ACID_DENSITY_G_PER_ML,
      6,
    )
    expect(r.readouts.acid).toBeDefined()
    const a = r.readouts.acid!
    // Cancels the hydroxide, then the card's free acidity (pH 3.9 ≈ 0.13 mmol/L
    // H⁺ plus the little sulfate that protonates to bisulfate there).
    expect(a.mmolPerL).toBeGreaterThan(a.hydroxideReleased + 0.1 / 1.008)
    expect(a.mmolPerL).toBeLessThan(a.hydroxideReleased + 0.3)
    expect(a.basis).toBe('card pH')
    expect(a.targetPh).toBe(3.9)
    expect(a.phWithoutAcid).toBeGreaterThan(11)
    // The metasilicate dose fixes the acid dose: 2 × mmol/L Na2SiO3·5H2O.
    const meta = r.recipe.find((x) => x.saltId === 'sodiumMetasilicate')!
    expect(a.hydroxideReleased).toBeCloseTo(
      (meta.gramsPerLitre / SALTS.sodiumMetasilicate.molarMass) * 2000,
      9,
    )
  })

  it('leaves the bath at the card pH with no hydroxide precipitation', () => {
    expect(r.readouts.chargeResidual).toBeLessThan(0)
    expect(r.readouts.phEstimate).toBeCloseTo(3.9, 2)
    expect(r.readouts.precipitation.map((p) => p.mineral)).not.toContain(
      'brucite',
    )
    expect(r.readouts.precipitation.map((p) => p.mineral)).not.toContain(
      'silicate-hydrate',
    )
  })

  it("credits the acid's chloride back to the fit so Na and Cl land close", () => {
    for (const ion of ['Na', 'Cl', 'H2SiO3', 'Ca', 'Mg', 'K', 'SO4'] as const) {
      const m = r.match.find((x) => x.ion === ion)!
      expect(Math.abs(m.diffPct!), ion).toBeLessThan(5)
    }
  })

  it('prints the liquid line, the hydroxide accounting and the handling notes', () => {
    const txt = renderText(r)
    expect(txt).toContain('Liquid: muriatic acid')
    expect(txt).toMatch(/≈ \d+ mL/)
    expect(txt).toContain('Hydroxide: sodium metasilicate releases')
    expect(txt).toContain('Order of addition')
    expect(txt).toContain('Estimated pH 3.9 (card 3.9)')
    expect(txt).not.toContain('a positive residual here is expected')
  })

  it('a card without silicate gets no acid and no hydroxide line', () => {
    const plain = runOnsen(
      normalizeOnsen({
        units: 'mg/kg',
        ph: 7.2,
        cations: { Na: 300, Ca: 40 },
        anions: { Cl: 462.7, SO4: 95.9 },
      }),
    )
    expect(plain.recipe.map((x) => x.saltId)).not.toContain('hydrochloricAcid')
    expect(plain.readouts.acid).toBeUndefined()
    expect(plain.readouts.phEstimate).toBeCloseTo(7, 0)
    expect(renderText(plain)).not.toContain('Hydroxide:')
  })
})
