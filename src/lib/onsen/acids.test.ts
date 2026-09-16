// Four acids, one recipe each: the dosing-to-card-pH loop, the bicarbonate
// compensation, the credited / by-product anions, and the ranking.

import { describe, expect, it } from 'vitest'
import { ACIDS, IONS, SALTS } from '../chem/constants'
import {
  acidDoseForPh,
  anionEquivalents,
  daviesLogGamma,
  estimateBathPh,
  polyproticFractions,
  withAcid,
} from './chemistry'
import { normalizeOnsen } from './normalize'
import { rankVariants, renderMarkdown, renderText, runOnsen } from './index'
import { runCli } from '../../cli/onsen'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Yumenoya (夢のや): a sodium-calcium chloride-bicarbonate spring whose pH 6.8
// is set by its free CO₂, the case the four-acid dosing exists for.
const YUMENOYA = {
  name: 'Yumenoya',
  units: 'mg/kg' as const,
  ph: 6.8,
  temperature_c: 46.2,
  cations: { Na: 386.4, K: 25.4, NH4: 0.3, Mg: 30.1, Ca: 154.2, Fe2: 0.4 },
  anions: { F: 1.2, Cl: 535.8, Br: 1.5, SO4: 164.2, HCO3: 476.1 },
  undissociated: { H2SiO3: 142.1, HBO2: 18.2, CO2: 184.8 },
}

describe('weak-acid arithmetic', () => {
  it('polyprotic fractions sum to one and reproduce the diprotic case', () => {
    const f = polyproticFractions(10 ** -6.8, [3.13, 4.76, 6.4])
    expect(f).toHaveLength(4)
    expect(f.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
    // At pH 6.8 citrate is mostly the trianion, some dianion.
    expect(f[3]).toBeGreaterThan(0.6)
    expect(f[2]).toBeGreaterThan(0.2)
    expect(f[0] + f[1]).toBeLessThan(0.01)
    // Fully deprotonated at high pH: three equivalents per mole.
    expect(anionEquivalents(10 ** -12, [3.13, 4.76, 6.4])).toBeCloseTo(3, 4)
    // Lactate: one equivalent once well above pKa 3.86.
    expect(anionEquivalents(10 ** -7, [3.86])).toBeCloseTo(1, 2)
  })

  it('Davies: zero at zero ionic strength, about -0.3 for a divalent ion at I = 0.034 M', () => {
    expect(daviesLogGamma(2, 0)).toBeCloseTo(0, 12)
    expect(daviesLogGamma(2, 0.034)).toBeCloseTo(-0.305, 2)
    expect(daviesLogGamma(1, 0.034)).toBeCloseTo(-0.076, 2)
  })

  it('acidDoseForPh: zero when already below target, otherwise lands on it', () => {
    const bicarb = { Na: 230, HCO3: 610 } // 10 mM NaHCO3, pH ≈ 8.3 alone
    expect(acidDoseForPh(bicarb, {}, 'citricAcid', 9).mmolPerL).toBe(0)
    for (const acid of ACIDS) {
      const d = acidDoseForPh(bicarb, {}, acid, 6.5)
      expect(d.capped).toBe(false)
      expect(d.mmolPerL).toBeGreaterThan(0)
      const w = withAcid(bicarb, {}, acid, d.mmolPerL)
      expect(estimateBathPh(w.profile, w.extras)).toBeCloseTo(6.5, 6)
    }
    // A strong acid needs one proton per mole; citric needs fewer moles.
    const hcl = acidDoseForPh(bicarb, {}, 'hydrochloricAcid', 6.5).mmolPerL
    const cit = acidDoseForPh(bicarb, {}, 'citricAcid', 6.5).mmolPerL
    expect(cit).toBeLessThan(hcl / 2)
    expect(cit).toBeGreaterThan(hcl / 3)
  })

  it('withAcid credits modelled ions and tracks organic anions separately', () => {
    const hcl = withAcid({}, {}, 'hydrochloricAcid', 2)
    expect(hcl.profile.Cl).toBeCloseTo(2 * IONS.Cl.molarMass, 9)
    expect(hcl.extras.organic).toEqual([])
    const bis = withAcid({}, {}, 'sodiumBisulfate', 2)
    expect(bis.profile.Na).toBeCloseTo(2 * IONS.Na.molarMass, 9)
    expect(bis.profile.SO4).toBeCloseTo(2 * IONS.SO4.molarMass, 9)
    const cit = withAcid({}, { boronMol: 0.001 }, 'citricAcid', 2)
    expect(cit.profile).toEqual({})
    expect(cit.extras.organic).toEqual([
      { mol: 0.002, pkas: [3.13, 4.76, 6.4], ligand: 'citrate' },
    ])
    expect(cit.extras.boronMol).toBe(0.001)
  })
})

describe('four acids on a CO₂-buffered bicarbonate spring', () => {
  const r = runOnsen(normalizeOnsen(YUMENOYA))

  it('produces one variant per acid, in ACIDS order, each landing on the card pH', () => {
    expect(r.variants.map((v) => v.acid)).toEqual([...ACIDS])
    for (const v of r.variants) {
      expect(v.readouts.phEstimate, v.acid).toBeCloseTo(6.8, 2)
      expect(v.readouts.acid, v.acid).toBeDefined()
      expect(v.readouts.acid!.basis).toBe('card pH')
      expect(v.readouts.acid!.capped).toBe(false)
      expect(v.recipe.map((l) => l.saltId)).toContain(v.acid)
      // Only its own acid appears in its recipe.
      for (const other of ACIDS) {
        if (other !== v.acid) expect(v.recipe.map((l) => l.saltId)).not.toContain(other)
      }
    }
  })

  it('keeps bicarbonate at the card value even though acid turns some of it into CO₂', () => {
    for (const v of r.variants) {
      const hco3 = v.match.find((m) => m.ion === 'HCO3')!
      expect(Math.abs(hco3.diffPct!), v.acid).toBeLessThan(0.5)
      expect(v.readouts.acid!.extraBicarbonateMmolPerL).toBeGreaterThan(1)
      const co2 = v.match.find((m) => m.ion === 'CO2')!
      expect(co2.target).toBeCloseTo(184.8, 6)
      // At pH 6.8 with 476 mg/L HCO₃⁻ the carbonate system holds ~120 mg/L CO₂.
      expect(co2.result).toBeGreaterThan(100)
      expect(co2.result).toBeLessThan(140)
      expect(v.readouts.acid!.dissolvedCo2MgPerL).toBeCloseTo(co2.result, 6)
    }
  })

  it('credits chloride from muriatic acid so its recipe matches best; organic acids leave Na/Cl off', () => {
    const [hcl, lactic, citric, bisulfate] = r.variants
    expect(hcl.worstDiffPct).toBeLessThan(5)
    expect(hcl.extraIons).toEqual([])
    for (const v of [lactic, citric]) {
      expect(v.extraIons).toHaveLength(1)
      expect(v.extraIons[0].key).toBe(SALTS[v.acid].acidAnion!.key)
      expect(v.extraIons[0].mgPerL).toBeCloseTo(
        v.readouts.acid!.mmolPerL * SALTS[v.acid].acidAnion!.molarMass,
        6,
      )
      expect(v.worstDiffPct).toBeGreaterThan(hcl.worstDiffPct)
      expect(v.warnings.join('\n')).toContain('not an onsen ion')
    }
    expect(lactic.worstDiffPct).toBeLessThan(25)
    // Bisulfate brings ~4× the card's sulfate on this water and says so.
    const so4 = bisulfate.match.find((m) => m.ion === 'SO4')!
    expect(so4.diffPct!).toBeGreaterThan(100)
    expect(bisulfate.warnings.join('\n')).toContain('overshoots that ion')
    expect(bisulfate.extraIons).toEqual([])
  })

  it('citrate binds a large share of the calcium and magnesium; lactate only a little', () => {
    const [hcl, lactic, citric] = r.variants
    expect(hcl.readouts.freeCalciumMgPerL).toBeCloseTo(
      hcl.match.find((m) => m.ion === 'Ca')!.result,
      6,
    )
    expect(hcl.match.map((m) => m.ion)).not.toContain('Ca-free')
    const caFree = citric.match.find((m) => m.ion === 'Ca-free')!
    const mgFree = citric.match.find((m) => m.ion === 'Mg-free')!
    expect(caFree.target).toBeCloseTo(154.2, 6)
    expect(caFree.diffPct!).toBeLessThan(-25)
    expect(caFree.diffPct!).toBeGreaterThan(-70)
    expect(mgFree.diffPct!).toBeLessThan(-20)
    expect(citric.worstDiffPct).toBeGreaterThan(25)
    expect(citric.warnings.join('\n')).toContain('held in soluble complexes')
    const lacFree = lactic.match.find((m) => m.ion === 'Ca-free')
    if (lacFree) expect(lacFree.diffPct!).toBeGreaterThan(-15)
    expect(lactic.worstDiffPct).toBeLessThan(citric.worstDiffPct)
    // Binding lowers the free calcium the calcite / gypsum checks see.
    expect(citric.readouts.freeCalciumMgPerL).toBeLessThan(
      hcl.readouts.freeCalciumMgPerL * 0.75,
    )
  })

  it('every variant carries a four-line fidelity block and a degassed pH above the fresh one', () => {
    for (const v of r.variants) {
      expect(v.fidelity.map((f) => f.metric)).toEqual(['smell', 'feel', 'chemistry', 'pH'])
      expect(v.readouts.phAfterDegassing).toBeGreaterThan(v.readouts.phEstimate + 0.5)
      expect(v.fidelity[3].recipe).toContain('degassed')
      expect(v.fidelity[0].note).toContain('not reproduced')
      expect(v.fidelity[1].recipe).toContain('hardness')
    }
    const citric = r.variants[2]
    expect(citric.fidelity[1].note).toContain('binds')
    const txt = renderText(r)
    expect(txt).toContain('FIDELITY (smell / feel / chemistry / pH vs the onsen)')
    expect(txt).toContain('  this recipe: ')
    expect(txt).toContain('  gap:         ')
    expect(renderMarkdown(r)).toContain('### Fidelity')
  })

  it('doses far fewer moles of citric acid than of muriatic for the same pH', () => {
    const hcl = r.variants[0].readouts.acid!
    const cit = r.variants[2].readouts.acid!
    expect(cit.mmolPerL).toBeLessThan(hcl.mmolPerL / 2)
    // Protons delivered are similar (hydroxide + CO₂ generation).
    expect(cit.protonsMeqPerL).toBeGreaterThan(hcl.protonsMeqPerL * 0.9)
    expect(cit.protonsMeqPerL).toBeLessThan(hcl.protonsMeqPerL * 1.3)
  })

  it('ranks composition first: muriatic, then lactic, then citric (binding), then bisulfate', () => {
    expect(r.suggested).toBe('hydrochloricAcid')
    const ranked = rankVariants(r.variants, 6.8).map((v) => v.acid)
    expect(ranked).toEqual([
      'hydrochloricAcid',
      'lacticAcid',
      'citricAcid',
      'sodiumBisulfate',
    ])
  })

  it('calcite sits near saturation at pH 6.8 (as the real spring does), never brucite; borate is in the balance', () => {
    for (const v of r.variants) {
      const calcite = v.readouts.precipitation.find((p) => p.mineral === 'calcite')
      if (calcite) expect(calcite.saturationIndex!).toBeLessThan(0.3)
      expect(v.readouts.precipitation.map((p) => p.mineral)).not.toContain('brucite')
      expect(v.warnings.join('\n')).toContain('borate')
    }
  })

  it('top-level fields mirror the muriatic variant; shared warnings printed once', () => {
    expect(r.recipe).toBe(r.variants[0].recipe)
    expect(r.readouts).toBe(r.variants[0].readouts)
    expect(r.sharedWarnings.join('\n')).toContain('Order of addition')
    expect(r.sharedWarnings.join('\n')).toContain('iron')
    expect(r.variants[0].warnings.join('\n')).not.toContain('Order of addition')
  })

  it('text and markdown render all four recipes with a summary table', () => {
    const txt = renderText(r)
    expect(txt).toContain('ACID OPTIONS (4 recipes below, one per acid)')
    expect(txt.match(/=== RECIPE \d of 4:/g)).toHaveLength(4)
    expect(txt).toContain('MURIATIC ACID (14.5%)')
    expect(txt).toContain('LACTIC ACID (88%)')
    expect(txt).toContain('CITRIC ACID')
    expect(txt).toContain('SODIUM BISULFATE')
    expect(txt).toContain('* suggested: muriatic acid (14.5%)')
    expect(txt).toContain('Liquid: lactic acid, food grade (88% solution)')
    expect(txt).toContain('lactate (C₃H₅O₃⁻) (from the acid)')
    expect(txt).toContain('NOT REPLICATED (same for every recipe)')
    expect(txt).toContain('GENERAL WARNINGS (apply to every recipe)')
    expect(txt).toContain('Handling — citric acid')
    const md = renderMarkdown(r)
    expect(md).toContain('## Acid options')
    expect(md.match(/^## Recipe \d of 4 — /gm)).toHaveLength(4)
    expect(md).toContain('## General warnings')
  })
})

describe('acid on a card with no free-CO₂ buffer', () => {
  it('a silicate-free neutral card needs no acid from any of the four', () => {
    const r = runOnsen(
      normalizeOnsen({
        units: 'mg/kg',
        ph: 7.2,
        cations: { Na: 300, Ca: 40 },
        anions: { Cl: 462.7, SO4: 95.9 },
      }),
    )
    for (const v of r.variants) {
      expect(v.readouts.acid, v.acid).toBeUndefined()
      expect(v.recipe.map((l) => l.saltId)).not.toContain(v.acid)
      expect(v.readouts.phEstimate).toBeCloseTo(7, 0)
    }
  })

  it('with no card pH, each acid just cancels the metasilicate hydroxide', () => {
    const r = runOnsen(
      normalizeOnsen({
        units: 'mg/kg',
        cations: { Na: 200 },
        anions: { Cl: 250 },
        undissociated: { H2SiO3: 100 },
      }),
    )
    const phs = r.variants.map((v) => v.readouts.phEstimate)
    for (const v of r.variants) {
      expect(v.readouts.acid!.basis).toBe('hydroxide cancellation')
      expect(v.readouts.acid!.extraBicarbonateMmolPerL).toBe(0)
      expect(v.readouts.acid!.protonsMeqPerL).toBeGreaterThan(
        v.readouts.acid!.hydroxideReleased * 0.95,
      )
    }
    // All four land on the same reference pH (what a strong acid gives);
    // each variant's own fit moves it by a hundredth or so.
    for (const ph of phs) expect(ph).toBeCloseTo(phs[0], 1)
  })
})

describe('CLI --acid filter', () => {
  it('prints only the requested acid, and rejects unknown names', { timeout: 60000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'onsen-acid-'))
    const file = join(dir, 'y.json')
    writeFileSync(file, JSON.stringify(YUMENOYA))
    const one = runCli([file, '--acid', 'citric'], () => '')
    expect(one.code).toBe(0)
    expect(one.stdout).toContain('ACID OPTIONS (1 recipes below')
    expect(one.stdout.match(/=== RECIPE \d of 1:/g)).toHaveLength(1)
    expect(one.stdout).toContain('CITRIC ACID')
    expect(one.stdout).not.toContain('=== RECIPE 1 of 1: MURIATIC')
    const json = runCli([file, '--acid', 'bisulfate', '--json'], () => '')
    const parsed = JSON.parse(json.stdout) as { variants: { acid: string }[] }
    expect(parsed.variants.map((v) => v.acid)).toEqual(['sodiumBisulfate'])
    const bad = runCli([file, '--acid', 'vinegar'], () => '')
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('--acid needs one of')
  })
})
