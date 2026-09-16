// Run the solver on a normalised onsen card and render the result — once per
// acid the bath could be acidified with.
//
// The fit uses `'relative'` weighting (each ion row scaled by 1/max(target, 1))
// over the on-hand onsen palette (ONSEN_PALETTE), so a 6 mg/L carbonate figure
// matters as much as an 820 mg/L sodium figure. After the fit, for EACH acid
// in `ACIDS` (muriatic, lactic, citric, sodium bisulfate):
//
// 1. the acid dose is found by bisection so the proton-balance pH of the bath
//    lands on the card pH (falling back to the card's H⁺/OH⁻ line, else to
//    "just cancel the hydroxide sodium metasilicate releases");
// 2. any bicarbonate the acid turns into dissolved CO₂ is added back to the
//    fit target so the card's bicarbonate still matches at that pH — the
//    card's own free CO₂ is what set its pH, and this reproduces it;
// 3. ions the acid adds that the model tracks (Cl⁻ from HCl, Na⁺ + SO₄²⁻ from
//    bisulfate) are credited to the source water so the fit takes less salt;
//    anions it does not track (lactate, citrate) go into the proton balance
//    and are reported as by-products;
// 4. precipitation is screened at the final pH (calcite, brucite, portlandite,
//    silicate hydrate, amorphous silica).
//
// The four variants are ranked — composition first, then precipitation, then
// closeness to the card pH — and all four are printed. See `chemistry.ts`.

import {
  ACIDS,
  ATOMIC_WEIGHTS,
  HCO3_WEIGHT,
  IONS,
  ION_ORDER,
  OH_WEIGHT,
  ONSEN_PALETTE,
  SALTS,
} from '../chem/constants'
import type { IonId, SaltId } from '../chem/constants'
import { GYPSUM_CEILING_G_PER_L, solve } from '../solver/solve'
import type {
  IonProfile,
  SaltDose,
  SaturationWarning,
  SolveResult,
} from '../solver/types'
import {
  ACID_DOSE_CAP_MMOL_PER_L,
  BATH_TEMPERATURE_C,
  acidDoseForPh,
  cardBoronMol,
  estimateBathPh,
  hydroxideReleased,
  phAfterDegassing,
  precipitationWarnings,
  speciate,
  withAcid,
} from './chemistry'
import type {
  AcidAddition,
  PrecipitationWarning,
  WeakExtras,
} from './chemistry'
import { EXTRA_SPECIES, speciesLabel } from './species'
import type { NormalizedOnsen, NotReplicated } from './types'

export interface RecipeLine {
  saltId: SaltId
  purchaseName: string
  name: string
  formula: string
  /** Grams for the whole bath (grams of the product as sold, for a liquid). */
  grams: number
  gramsPerLitre: number
  /** Volume for the whole bath, for an ingredient sold as a liquid. */
  millilitres?: number
}

/** Rows the Match table carries beyond the modelled ions. */
export type DerivedMatchKey = 'CO2' | 'Ca-free' | 'Mg-free'

export interface MatchLine {
  /**
   * A modelled ion; the dissolved CO₂ the carbonate speciation implies; or
   * the FREE calcium / magnesium left after the acid's anion has bound its
   * share (only present when something binds).
   */
  ion: IonId | DerivedMatchKey
  label: string
  /** mg/L the card asks for. */
  target: number
  /** mg/L the recipe (plus source water) produces, speciated at the bath pH. */
  result: number
  /** (result − target) / target × 100; null when target is zero. */
  diffPct: number | null
}

/** An ion the acid adds that no onsen card lists (lactate, citrate). */
export interface ExtraIonLine {
  key: string
  label: string
  mgPerL: number
  gramsForBath: number
}

export type AcidTargetBasis =
  | 'card pH'
  | 'card H⁺/OH⁻ lines'
  | 'hydroxide cancellation'

export interface AcidReadout {
  saltId: SaltId
  /** mmol/L of the acid dosed after the fit. */
  mmolPerL: number
  /** meq/L of protons that dose carries (mmol/L × protons per mole). */
  protonsMeqPerL: number
  /** meq/L of hydroxide the fitted salts release (the first thing the acid cancels). */
  hydroxideReleased: number
  /** The pH the dose was solved for. */
  targetPh: number
  basis: AcidTargetBasis
  /** Estimated pH the bath would have had without the acid. */
  phWithoutAcid: number
  /** mmol/L of bicarbonate added to the fit to replace what the acid turned into CO₂. */
  extraBicarbonateMmolPerL: number
  /** Dissolved CO₂ (mg/L as CO₂) the speciation implies at the final pH. */
  dissolvedCo2MgPerL: number
  /** True when even the dose cap could not reach the target pH. */
  capped: boolean
}

export type FidelityMetric = 'smell' | 'feel' | 'chemistry' | 'pH'

/** One row of the per-recipe fidelity block: how the bath compares to the onsen on one sense. */
export interface FidelityLine {
  metric: FidelityMetric
  /** What this recipe gives. */
  recipe: string
  /** What the card says (or implies). */
  card: string
  /** The gap, or why there is none. */
  note: string
}

export interface OnsenReadouts {
  tds: number
  /** meq/L, cation minus anion equivalents, of the fitted ions (before speciation). */
  chargeResidual: number
  /** meq/L charge residual of the card's fitted ions, for comparison. */
  targetChargeResidual: number
  sulfateChlorideRatio: number
  /** Estimated bath pH from the full proton balance of the final profile. */
  phEstimate: number
  /** Where the pH drifts once the dissolved CO₂ has left the tub. */
  phAfterDegassing: number
  /** Free (unbound) calcium / magnesium, mg/L; equal to the totals unless an organic acid binds some. */
  freeCalciumMgPerL: number
  freeMagnesiumMgPerL: number
  /** pH printed on the card, when given. */
  cardPh?: number
  gypsumCeilingHit: boolean
  /** Solver saturation warnings that do not depend on pH (gypsum). */
  saturation: SaturationWarning[]
  /** Precipitation checks at the estimated pH. */
  precipitation: PrecipitationWarning[]
  /** Present when acid was dosed. */
  acid?: AcidReadout
}

/** One complete recipe: the palette fit plus one acid. */
export interface OnsenVariant {
  acid: SaltId
  acidLabel: string
  recipe: RecipeLine[]
  match: MatchLine[]
  extraIons: ExtraIonLine[]
  readouts: OnsenReadouts
  /** Smell / feel / chemistry / pH against the onsen, one row each. */
  fidelity: FidelityLine[]
  warnings: string[]
  /** Largest |difference| (%) over the card's fitted ions, free Ca/Mg included. */
  worstDiffPct: number
  /** Precipitation flags that the acid choice can change (everything but amorphous silica). */
  precipitationCount: number
}

export interface OnsenResult {
  name: string
  units: NormalizedOnsen['units']
  springType?: string
  temperatureC?: number
  batch: NormalizedOnsen['batch']
  litres: number
  /** The muriatic-acid variant (`variants[0]`), kept at top level for callers of the older shape. */
  recipe: RecipeLine[]
  match: MatchLine[]
  readouts: OnsenReadouts
  /** The muriatic-acid variant's warnings followed by the shared ones. */
  warnings: string[]
  notReplicated: NotReplicated[]
  sourceWaterIgnored: string[]
  /** One recipe per acid, in `ACIDS` order. */
  variants: OnsenVariant[]
  /** The acid the ranking prefers: composition first, then precipitation, then pH. */
  suggested: SaltId
  /** Warnings that apply whatever the acid (printed once). */
  sharedWarnings: string[]
}

/** Short names for the acid-options summary. */
export const ACID_SHORT_NAME: Record<SaltId, string> = {
  hydrochloricAcid: 'muriatic acid (14.5%)',
  lacticAcid: 'lactic acid (88%)',
  citricAcid: 'citric acid',
  sodiumBisulfate: 'sodium bisulfate',
} as Record<SaltId, string>

/** Charge residual (meq/L) of any mg/L profile over the modelled ions. */
function chargeResidualOf(profile: Partial<Record<IonId, number>>): number {
  let meq = 0
  for (const ion of ION_ORDER) {
    const mg = profile[ion] ?? 0
    if (mg === 0) continue
    meq += (mg / IONS[ion].molarMass) * IONS[ion].charge
  }
  return meq
}

export const LITRES_PER_US_GALLON = 3.785411784

/** Doses below this (g/L) are numerical dust from the fit and are not printed. */
export const MIN_DOSE_G_PER_L = 0.0005
/** Ions the card does not list are only shown/warned about above this (mg/L). */
export const MIN_VISIBLE_MG_PER_L = 0.05
/** Speciation by-products (carbonate at low pH, CO₂ at high pH) are shown above this (mg/L). */
const MIN_VISIBLE_SPECIES_MG_PER_L = 1

/** The default acid (the first variant; the pre-2026-09-16 single-recipe report). */
export const NEUTRALISING_ACID: SaltId = 'hydrochloricAcid'

const CO2_MOLAR_MASS = EXTRA_SPECIES.CO2.molarMass

interface PhTarget {
  ph?: number
  basis: AcidTargetBasis
}

/**
 * The pH each acid is dosed to: the card pH; else the card's H⁺ / OH⁻ line;
 * else "cancel the released hydroxide", which resolves per fit.
 */
function phTargetOf(norm: NormalizedOnsen): PhTarget {
  if (norm.ph !== undefined) return { ph: norm.ph, basis: 'card pH' }
  const h = norm.notReplicated.find((n) => n.key === 'H')?.mgPerL
  const oh = norm.notReplicated.find((n) => n.key === 'OH')?.mgPerL
  if (h !== undefined && h > 0) {
    return {
      ph: -Math.log10(h / ATOMIC_WEIGHTS.H / 1000),
      basis: 'card H⁺/OH⁻ lines',
    }
  }
  if (oh !== undefined && oh > 0) {
    return {
      ph: 14 + Math.log10(oh / OH_WEIGHT / 1000),
      basis: 'card H⁺/OH⁻ lines',
    }
  }
  return { basis: 'hydroxide cancellation' }
}

interface VariantFit {
  result: SolveResult
  /** Result profile without the acid's own ions. */
  base: IonProfile
  final: AcidAddition
  acidMmolPerL: number
  hydroxide: number
  targetPh: number
  phFinal: number
  extraBicarbonate: number
  capped: boolean
}

/**
 * Fit the card, then dose one acid to the target pH, re-fitting until the
 * acid's credited ions and the bicarbonate compensation are self-consistent.
 */
function fitVariant(
  norm: NormalizedOnsen,
  acidId: SaltId,
  target: PhTarget,
  baseExtras: WeakExtras,
): VariantFit {
  let extraC = 0
  let acid = 0
  let out!: VariantFit
  for (let i = 0; i < 40; i++) {
    const fitTarget: IonProfile =
      extraC > 0
        ? { ...norm.target, HCO3: (norm.target.HCO3 ?? 0) + extraC * HCO3_WEIGHT }
        : norm.target
    const credited = withAcid(norm.source, {}, acidId, acid).profile
    const result = solve(fitTarget, credited, ONSEN_PALETTE, norm.batch, {
      weighting: 'relative',
    })
    const hydroxide = hydroxideReleased(result.dosePerLitre)
    const base = withAcid(result.resultProfile, {}, acidId, -acid).profile
    for (const ion of ION_ORDER) {
      if ((base[ion] ?? 0) < 0) base[ion] = 0
    }
    const targetPh =
      target.ph ??
      (() => {
        const ref = withAcid(base, baseExtras, 'hydrochloricAcid', hydroxide)
        return estimateBathPh(ref.profile, ref.extras)
      })()
    const dose = acidDoseForPh(base, baseExtras, acidId, targetPh)
    const final = withAcid(base, baseExtras, acidId, dose.mmolPerL)
    const phFinal = estimateBathPh(final.profile, final.extras)
    const spec = speciate(final.profile, phFinal, final.extras)
    let extraCNew = 0
    if (dose.mmolPerL > 0 && target.ph !== undefined) {
      const cardHco3 = (norm.target.HCO3 ?? 0) / HCO3_WEIGHT / 1000
      extraCNew = Math.max(0, extraC + (cardHco3 - spec.hco3) * 1000)
    }
    const done =
      Math.abs(dose.mmolPerL - acid) < 1e-6 &&
      Math.abs(extraCNew - extraC) < 1e-6
    out = {
      result,
      base,
      final,
      acidMmolPerL: dose.mmolPerL,
      hydroxide,
      targetPh,
      phFinal,
      extraBicarbonate: extraC,
      capped: dose.capped,
    }
    acid = dose.mmolPerL
    extraC = extraCNew
    if (done) break
  }
  return out
}

function recipeLines(dosePerLitre: SaltDose, litres: number): RecipeLine[] {
  const order: readonly SaltId[] = [...ONSEN_PALETTE, ...ACIDS]
  return order
    .filter((id) => (dosePerLitre[id] ?? 0) >= MIN_DOSE_G_PER_L)
    .map((id) => {
      const perL = dosePerLitre[id] ?? 0
      const line: RecipeLine = {
        saltId: id,
        purchaseName: SALTS[id].purchaseName,
        name: SALTS[id].name,
        formula: SALTS[id].formula,
        grams: perL * litres,
        gramsPerLitre: perL,
      }
      const density = SALTS[id].densityGPerMl
      if (density !== undefined) line.millilitres = (perL * litres) / density
      return line
    })
}

const pct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(0)}%`

function buildVariant(
  norm: NormalizedOnsen,
  acidId: SaltId,
  target: PhTarget,
  baseExtras: WeakExtras,
  litres: number,
): OnsenVariant {
  const salt = SALTS[acidId]
  const fit = fitVariant(norm, acidId, target, baseExtras)
  const { result, final, acidMmolPerL, hydroxide, phFinal } = fit

  const dosePerLitre: SaltDose = { ...result.dosePerLitre }
  if (acidMmolPerL > 0) {
    dosePerLitre[acidId] = (acidMmolPerL / 1000) * salt.molarMass
  }
  const recipe = recipeLines(dosePerLitre, litres)

  const spec = speciate(final.profile, phFinal, final.extras)
  const match: MatchLine[] = []
  for (const ion of ION_ORDER) {
    const targetMg = norm.target[ion] ?? 0
    let res: number
    let floor = MIN_VISIBLE_MG_PER_L
    if (ion === 'HCO3') {
      res = spec.hco3 * 1000 * IONS.HCO3.molarMass
      floor = MIN_VISIBLE_SPECIES_MG_PER_L
    } else if (ion === 'CO3') {
      res = spec.co3 * 1000 * IONS.CO3.molarMass
      floor = MIN_VISIBLE_SPECIES_MG_PER_L
    } else res = final.profile[ion] ?? 0
    if (targetMg === 0 && res < floor) continue
    match.push({
      ion,
      label: speciesLabel(ion),
      target: targetMg,
      result: res,
      diffPct: targetMg > 0 ? ((res - targetMg) / targetMg) * 100 : null,
    })
  }
  const freeCa = spec.caFree * 1000 * IONS.Ca.molarMass
  const freeMg = spec.mgFree * 1000 * IONS.Mg.molarMass
  const boundCaFrac = spec.caBound / Math.max(spec.caBound + spec.caFree, 1e-30)
  const boundMgFrac = spec.mgBound / Math.max(spec.mgBound + spec.mgFree, 1e-30)
  if (boundCaFrac > 0.01 && (norm.target.Ca ?? 0) > 0) {
    match.push({
      ion: 'Ca-free',
      label: 'free calcium (not bound by the acid)',
      target: norm.target.Ca ?? 0,
      result: freeCa,
      diffPct: ((freeCa - (norm.target.Ca ?? 0)) / (norm.target.Ca ?? 1)) * 100,
    })
  }
  if (boundMgFrac > 0.01 && (norm.target.Mg ?? 0) > 0) {
    match.push({
      ion: 'Mg-free',
      label: 'free magnesium (not bound by the acid)',
      target: norm.target.Mg ?? 0,
      result: freeMg,
      diffPct: ((freeMg - (norm.target.Mg ?? 0)) / (norm.target.Mg ?? 1)) * 100,
    })
  }
  const cardCo2 =
    norm.notReplicated.find((n) => n.key === 'CO2')?.mgPerL ?? 0
  const dissolvedCo2 = spec.h2co3 * 1000 * CO2_MOLAR_MASS
  if (cardCo2 > 0 || dissolvedCo2 >= MIN_VISIBLE_SPECIES_MG_PER_L) {
    match.push({
      ion: 'CO2',
      label: 'dissolved CO₂ (free carbon dioxide)',
      target: cardCo2,
      result: dissolvedCo2,
      diffPct: cardCo2 > 0 ? ((dissolvedCo2 - cardCo2) / cardCo2) * 100 : null,
    })
  }

  const extraIons: ExtraIonLine[] = []
  if (salt.acidAnion && acidMmolPerL > 0) {
    const mg = acidMmolPerL * salt.acidAnion.molarMass
    extraIons.push({
      key: salt.acidAnion.key,
      label: salt.acidAnion.label,
      mgPerL: mg,
      gramsForBath: (mg * litres) / 1000,
    })
  }

  const gypsumCeilingHit =
    (result.dosePerLitre.gypsum ?? 0) >= GYPSUM_CEILING_G_PER_L
  const precipitation = precipitationWarnings(
    final.profile,
    phFinal,
    BATH_TEMPERATURE_C,
    final.extras,
  )
  // The solver's own gypsum/calcite screen ignores pH and ionic strength;
  // the onsen layer's Davies-corrected, speciated checks replace it.
  const saturation: SaturationWarning[] = precipitation
    .filter((p) => p.mineral === 'gypsum' && p.saturationIndex !== undefined)
    .map((p) => ({
      mineral: 'gypsum',
      saturationIndex: p.saturationIndex ?? 0,
      message: p.message,
    }))
  const precipitationCount = precipitation.filter(
    (p) => p.mineral !== 'amorphous-silica',
  ).length

  const phDegassed = phAfterDegassing(final.profile, final.extras)
  const readouts: OnsenReadouts = {
    tds:
      result.readouts.tds +
      extraIons.reduce((acc, e) => acc + e.mgPerL, 0),
    chargeResidual: result.readouts.chargeResidual,
    targetChargeResidual: chargeResidualOf(norm.target),
    sulfateChlorideRatio: result.readouts.sulfateChlorideRatio,
    phEstimate: phFinal,
    phAfterDegassing: phDegassed,
    freeCalciumMgPerL: freeCa,
    freeMagnesiumMgPerL: freeMg,
    gypsumCeilingHit,
    saturation,
    precipitation,
  }
  if (norm.ph !== undefined) readouts.cardPh = norm.ph
  if (acidMmolPerL > 0) {
    readouts.acid = {
      saltId: acidId,
      mmolPerL: acidMmolPerL,
      protonsMeqPerL: acidMmolPerL * -(salt.netCharge ?? 0),
      hydroxideReleased: hydroxide,
      targetPh: fit.targetPh,
      basis: target.basis,
      phWithoutAcid: estimateBathPh(fit.base, baseExtras),
      extraBicarbonateMmolPerL: fit.extraBicarbonate,
      dissolvedCo2MgPerL: dissolvedCo2,
      capped: fit.capped,
    }
  }

  // --- warnings for this variant ---------------------------------------
  const warnings: string[] = []
  if (gypsumCeilingHit) {
    warnings.push(
      `Gypsum dose clamped at its ${GYPSUM_CEILING_G_PER_L} g/L solubility ceiling; calcium/sulfate will fall short of the card.`,
    )
  }
  for (const m of match) {
    if (m.ion === 'CO2') {
      if (m.target > 0 && m.diffPct !== null && Math.abs(m.diffPct) > 10) {
        warnings.push(
          `Dissolved CO₂: ${m.result.toFixed(0)} mg/L modelled vs ${m.target.toFixed(0)} mg/L on the card (${pct(m.diffPct)}). It is not fitted: at the card pH and bicarbonate it can only be this much (carbonic acid pKa 6.30 at 40 °C), so the card's own pH, bicarbonate and free-CO₂ figures do not quite agree with each other; pH and bicarbonate were kept.`,
        )
      }
      continue
    }
    if (m.ion === 'Ca-free' || m.ion === 'Mg-free') {
      if (m.diffPct !== null && Math.abs(m.diffPct) > 10) {
        warnings.push(
          `${m.label}: ${m.result.toFixed(1)} mg/L of the ${m.target.toFixed(1)} mg/L is free (${pct(m.diffPct)}); the rest is held in soluble complexes by the acid's anion and does not act as hardness, scale or the mineral feel on skin.`,
        )
      }
      continue
    }
    if (m.target > 0 && m.diffPct !== null && Math.abs(m.diffPct) > 10) {
      warnings.push(
        `${m.label}: recipe gives ${m.result.toFixed(1)} mg/L vs ${m.target.toFixed(1)} mg/L on the card (${pct(m.diffPct)}).`,
      )
    }
    if (m.target === 0 && m.ion !== 'CO2') {
      warnings.push(
        `${m.label}: ${m.result.toFixed(1)} mg/L present as a by-product (not on the card).`,
      )
    }
  }
  for (const e of extraIons) {
    warnings.push(
      `${e.label}: ${e.mgPerL.toFixed(0)} mg/L (${e.gramsForBath.toFixed(0)} g in the bath) added by the acid; not an onsen ion.`,
    )
  }
  if (readouts.acid) {
    const a = readouts.acid
    for (const [ion, moles] of Object.entries(salt.stoichiometry) as [
      IonId,
      number,
    ][]) {
      const mg = a.mmolPerL * moles * IONS[ion].molarMass
      const cardMg = norm.target[ion] ?? 0
      if (mg > cardMg) {
        warnings.push(
          `The acid's ${speciesLabel(ion)} alone (${mg.toFixed(0)} mg/L) exceeds the card's ${cardMg.toFixed(0)} mg/L; this acid overshoots that ion on this water.`,
        )
      }
    }
    const rest = Math.max(0, a.protonsMeqPerL - a.hydroxideReleased)
    const co2Part =
      rest > 0.01
        ? ` the remaining ${rest.toFixed(2)} meq/L converts bicarbonate into dissolved CO₂ (${a.dissolvedCo2MgPerL.toFixed(0)} mg/L modelled${cardCo2 > 0 ? `, card ${cardCo2.toFixed(0)} mg/L` : ''})${a.extraBicarbonateMmolPerL > 0.001 ? `, and ${a.extraBicarbonateMmolPerL.toFixed(2)} mmol/L extra bicarbonate is fitted so bicarbonate still matches at that pH` : ''}.`
        : ''
    warnings.push(
      `Acid: ${a.mmolPerL.toFixed(2)} mmol/L ${salt.name.toLowerCase()} (${a.protonsMeqPerL.toFixed(2)} meq/L H⁺) takes the bath to pH ${a.targetPh.toFixed(1)} (${a.basis}). Hydroxide: sodium metasilicate releases ${a.hydroxideReleased.toFixed(2)} meq/L OH⁻ (2 per Na₂SiO₃), which the acid cancels first;${co2Part || ' nothing beyond that is needed.'} Without acid the bath would sit near pH ${a.phWithoutAcid.toFixed(1)}.`,
    )
    if (a.capped) {
      warnings.push(
        `Even ${ACID_DOSE_CAP_MMOL_PER_L} mmol/L of this acid does not reach pH ${a.targetPh.toFixed(1)}; the card's pH cannot be reproduced with it.`,
      )
    }
  } else if (target.ph !== undefined && phFinal < target.ph - 0.3) {
    warnings.push(
      `No acid: the salts alone give pH ${phFinal.toFixed(1)}, already below the card's ${target.ph.toFixed(1)}; nothing in the palette raises pH, so the bath is left there.`,
    )
  }
  warnings.push(
    `Charge residual of the fitted ions: ${readouts.chargeResidual.toFixed(2)} meq/L (card's fitted ions: ${readouts.targetChargeResidual.toFixed(2)} meq/L); the acid's anion and the pH speciation close the balance.`,
  )
  {
    const systems = ['carbonate', 'silicate', 'sulfate']
    if (salt.acidAnion && acidMmolPerL > 0) systems.push(salt.acidAnion.key)
    if ((baseExtras.boronMol ?? 0) > 0) systems.push('borate')
    systems.push('water')
    const card =
      readouts.cardPh !== undefined ? ` Card pH: ${readouts.cardPh}.` : ''
    const drift =
      phDegassed - phFinal > 0.2
        ? ` As the dissolved CO₂ leaves the tub the pH climbs toward ${phDegassed.toFixed(1)} — hours in still water, faster with jets or stirring.`
        : ''
    warnings.push(
      `Approximate pH ≈ ${phFinal.toFixed(1)} from the proton balance of the result (${systems.join(', ')}; constants at ${BATH_TEMPERATURE_C} °C, no activity correction — guide to about ±0.2).${card}${drift}`,
    )
    if (
      readouts.cardPh !== undefined &&
      Math.abs(phFinal - readouts.cardPh) > 0.5
    ) {
      warnings.push(
        `Estimated pH is ${Math.abs(phFinal - readouts.cardPh).toFixed(1)} units from the card's: ${
          readouts.acid?.capped
            ? 'the acid dose cap was reached.'
            : 'the card pH sits above what the salts give and no base is dosed; buffers the card lists but the model does not (sulfide, ammonium, phosphate) may also set it.'
        }`,
      )
    }
  }
  for (const p of precipitation) warnings.push(p.message)
  if (readouts.acid) {
    const line = recipe.find((r) => r.saltId === acidId)
    if (line) {
      const vol =
        line.millilitres !== undefined
          ? ` ≈ ${line.millilitres.toFixed(0)} mL`
          : ''
      warnings.push(
        `Handling — ${salt.purchaseName}: ${line.grams.toFixed(0)} g${vol} for the bath. ${salt.handling ?? ''}`.trim(),
      )
    }
  }

  let worst = 0
  for (const m of match) {
    if (m.ion !== 'CO2' && m.target > 0 && m.diffPct !== null) {
      worst = Math.max(worst, Math.abs(m.diffPct))
    }
  }

  const fidelity = fidelityLines(norm, {
    acidId,
    acidMmolPerL,
    phFinal,
    phDegassed,
    worst,
    tds: readouts.tds,
    dissolvedCo2,
    cardCo2,
    silicaMgPerL: final.profile.H2SiO3 ?? 0,
    freeCa,
    freeMg,
    boundCaFrac,
    boundMgFrac,
    extraIons,
    precipitation,
  })

  return {
    acid: acidId,
    acidLabel: salt.purchaseName,
    recipe,
    match,
    extraIons,
    readouts,
    fidelity,
    warnings,
    worstDiffPct: worst,
    precipitationCount,
  }
}

/** Hardness as mg/L CaCO₃ from calcium and magnesium in mg/L. */
function hardnessAsCaCO3(caMg: number, mgMg: number): number {
  return (caMg / IONS.Ca.molarMass + mgMg / IONS.Mg.molarMass) * 100.087
}

/** Sum of everything the card lists, mg/L (fitted ions plus the rest). */
function cardTds(norm: NormalizedOnsen): number {
  let t = 0
  for (const ion of ION_ORDER) t += norm.target[ion] ?? 0
  for (const n of norm.notReplicated) t += n.mgPerL ?? 0
  return t
}

const SMELL_KEYS: Record<string, string> = {
  H2S: 'free hydrogen sulfide',
  HS: 'hydrosulfide',
  S2O3: 'thiosulfate',
  S: 'total sulfur',
  Fe2: 'iron(II)',
  Fe3: 'iron(III)',
  Fe: 'iron',
  NH4: 'ammonium',
}

interface FidelityInputs {
  acidId: SaltId
  acidMmolPerL: number
  phFinal: number
  phDegassed: number
  worst: number
  tds: number
  dissolvedCo2: number
  cardCo2: number
  silicaMgPerL: number
  freeCa: number
  freeMg: number
  boundCaFrac: number
  boundMgFrac: number
  extraIons: ExtraIonLine[]
  precipitation: PrecipitationWarning[]
}

/** The four senses Colin judges a bath by, one line each, recipe vs card. */
function fidelityLines(norm: NormalizedOnsen, f: FidelityInputs): FidelityLine[] {
  const out: FidelityLine[] = []
  const salt = SALTS[f.acidId]

  // --- smell -------------------------------------------------------------
  const smelly = norm.notReplicated.filter((n) => SMELL_KEYS[n.key] !== undefined)
  const sulfur = smelly.filter((n) => ['H2S', 'HS', 'S2O3', 'S'].includes(n.key))
  const iron = smelly.filter((n) => n.key.startsWith('Fe'))
  const cardSmell: string[] = []
  if (sulfur.length) {
    cardSmell.push(
      `sulfur ${sulfur.map((n) => `${n.key} ${n.mgPerL !== undefined ? n.mgPerL.toFixed(1) : n.reported} mg/L`).join(', ')} (rotten-egg onsen smell)`,
    )
  }
  if (iron.length) {
    cardSmell.push(
      `iron ${iron.map((n) => `${n.mgPerL !== undefined ? n.mgPerL.toFixed(1) : n.reported} mg/L`).join(', ')} (metallic note, rust tint)`,
    )
  }
  if (f.cardCo2 >= 100) cardSmell.push(`free CO₂ ${f.cardCo2.toFixed(0)} mg/L (faint fizz)`)
  const recipeSmell: string[] = []
  if (f.dissolvedCo2 >= 100) recipeSmell.push(`CO₂ ${f.dissolvedCo2.toFixed(0)} mg/L fizz`)
  if (f.acidId === 'hydrochloricAcid' && f.acidMmolPerL > 0) recipeSmell.push('no acid odour once mixed')
  if (f.acidId === 'lacticAcid' && f.acidMmolPerL > 0) recipeSmell.push('faint sour-milk note from lactate')
  const ironMg = iron.reduce((acc, n) => acc + (n.mgPerL ?? 0), 0)
  const sulfurMg = sulfur.reduce((acc, n) => acc + (n.mgPerL ?? 0), 0)
  let smellNote = 'no gap'
  if (sulfur.length && sulfurMg >= 1) {
    smellNote = `NOT reproduced: ${sulfurMg.toFixed(1)} mg/L of sulfur species gives the spring its rotten-egg smell and skin effect; sulfur is excluded by policy (no bath-safe ingredient is dosed). This is the largest gap for this spring.`
  } else if (sulfur.length) {
    smellNote = `Faint sulfur note (${sulfurMg.toFixed(1)} mg/L) not reproduced; sulfur is excluded by policy.`
  } else if (iron.length && ironMg >= 1) {
    smellNote = `NOT reproduced: ${ironMg.toFixed(1)} mg/L iron gives a metallic smell and a rust-coloured, staining bath; iron is excluded by policy.`
  } else if (iron.length) {
    smellNote = `Faint metallic note from ${ironMg.toFixed(1)} mg/L iron not reproduced (iron excluded by policy); hard to notice at this level.`
  }
  out.push({
    metric: 'smell',
    recipe: recipeSmell.length ? recipeSmell.join('; ') : 'odourless',
    card: cardSmell.length ? cardSmell.join('; ') : 'nothing smell-defining on the card',
    note: smellNote,
  })

  // --- feel --------------------------------------------------------------
  const cardCa = norm.target.Ca ?? 0
  const cardMg = norm.target.Mg ?? 0
  const cardHard = hardnessAsCaCO3(cardCa, cardMg)
  const freeHard = hardnessAsCaCO3(f.freeCa, f.freeMg)
  const cardT = cardTds(norm)
  const feelNotes: string[] = []
  if (f.boundCaFrac > 0.05 || f.boundMgFrac > 0.05) {
    feelNotes.push(
      `${salt.acidAnion?.key ?? 'the acid'} binds ${(f.boundCaFrac * 100).toFixed(0)}% of the calcium and ${(f.boundMgFrac * 100).toFixed(0)}% of the magnesium: softer, less astringent water than the onsen`,
    )
  }
  if (f.acidId === 'lacticAcid' && f.acidMmolPerL > 0) {
    feelNotes.push('lactate adds a faint humectant / exfoliant (alpha-hydroxy) feel the onsen lacks')
  }
  if (f.dissolvedCo2 >= 250) feelNotes.push('enough dissolved CO₂ for bubbles to form on the skin')
  else if (f.cardCo2 >= 250) feelNotes.push(`card has ${f.cardCo2.toFixed(0)} mg/L CO₂ (bubbles on skin); recipe holds ${f.dissolvedCo2.toFixed(0)} — below the ~250 where bubbles are felt`)
  if (f.silicaMgPerL > 0 && f.precipitation.some((p) => p.mineral === 'amorphous-silica')) {
    feelNotes.push('silica supersaturated: the silky "tsuru-tsuru" film, hazing over hours as it polymerises')
  }
  if (Math.abs(f.tds - cardT) / Math.max(cardT, 1) > 0.15) {
    feelNotes.push(`total minerals ${f.tds > cardT ? 'above' : 'below'} the card by ${(Math.abs(f.tds - cardT) / Math.max(cardT, 1) * 100).toFixed(0)}%`)
  }
  out.push({
    metric: 'feel',
    recipe: `TDS ${f.tds.toFixed(0)} mg/L; hardness ${freeHard.toFixed(0)} mg/L as CaCO₃ (free); CO₂ ${f.dissolvedCo2.toFixed(0)} mg/L; silica ${f.silicaMgPerL.toFixed(0)} mg/L`,
    card: `TDS ${cardT.toFixed(0)} mg/L; hardness ${cardHard.toFixed(0)} mg/L as CaCO₃; CO₂ ${f.cardCo2.toFixed(0)} mg/L; silica ${(norm.target.H2SiO3 ?? 0).toFixed(0)} mg/L`,
    note: feelNotes.length ? feelNotes.join('; ') : 'no gap beyond the ion differences above',
  })

  // --- chemistry ---------------------------------------------------------
  const chemNotes: string[] = []
  if (f.extraIons.length) {
    chemNotes.push(`adds ${f.extraIons.map((e) => `${e.key} ${e.mgPerL.toFixed(0)} mg/L`).join(', ')} that no onsen has`)
  }
  const flags = f.precipitation.filter((p) => p.mineral !== 'amorphous-silica').map((p) => p.mineral)
  if (flags.length) chemNotes.push(`precipitation: ${flags.join(', ')}`)
  out.push({
    metric: 'chemistry',
    recipe: `worst fitted ion ${f.worst.toFixed(0)}% off${f.boundCaFrac > 0.01 ? ` (free calcium counted)` : ''}`,
    card: 'the listed cations, anions and silica',
    note: chemNotes.length ? chemNotes.join('; ') : 'all fitted ions within the Match table',
  })

  // --- pH ----------------------------------------------------------------
  const drift = f.phDegassed - f.phFinal
  const phNote: string[] = []
  if (norm.ph !== undefined && Math.abs(f.phFinal - norm.ph) > 0.2) {
    phNote.push(`${Math.abs(f.phFinal - norm.ph).toFixed(1)} units ${f.phFinal > norm.ph ? 'above' : 'below'} the card`)
  }
  if (drift > 0.2) {
    phNote.push(`climbs to ${f.phDegassed.toFixed(1)} once the CO₂ has left (hours in a still tub; the real onsen bath drifts the same way)`)
  }
  out.push({
    metric: 'pH',
    recipe: drift > 0.2 ? `${f.phFinal.toFixed(1)} fresh → ${f.phDegassed.toFixed(1)} degassed` : f.phFinal.toFixed(1),
    card: norm.ph !== undefined ? norm.ph.toFixed(1) : 'not given',
    note: phNote.length ? phNote.join('; ') : 'matches',
  })

  return out
}

/** Rank variants: composition (whole-percent buckets), precipitation, |ΔpH|, then `ACIDS` order. */
export function rankVariants(
  variants: readonly OnsenVariant[],
  cardPh: number | undefined,
): OnsenVariant[] {
  const dPh = (v: OnsenVariant): number =>
    cardPh === undefined ? 0 : Math.abs(v.readouts.phEstimate - cardPh)
  return [...variants].sort(
    (a, b) =>
      Math.round(a.worstDiffPct) - Math.round(b.worstDiffPct) ||
      a.precipitationCount - b.precipitationCount ||
      dPh(a) - dPh(b) ||
      ACIDS.indexOf(a.acid) - ACIDS.indexOf(b.acid),
  )
}

/** Solve a normalised card once per acid, over the on-hand onsen palette. */
export function runOnsen(norm: NormalizedOnsen): OnsenResult {
  const litres =
    norm.batch.unit === 'gal'
      ? norm.batch.volume * LITRES_PER_US_GALLON
      : norm.batch.volume
  const target = phTargetOf(norm)
  const boronMol = cardBoronMol(norm)
  const baseExtras: WeakExtras = boronMol > 0 ? { boronMol } : {}

  const variants = ACIDS.map((acidId) =>
    buildVariant(norm, acidId, target, baseExtras, litres),
  )
  const suggested = rankVariants(variants, norm.ph)[0].acid

  const sharedWarnings: string[] = []
  if (variants.some((v) => v.recipe.some((l) => l.saltId === 'sodiumMetasilicate'))) {
    sharedWarnings.push(
      `Order of addition: fill the tub, stir in the acid, dissolve the other salts, then dissolve the sodium metasilicate in a bucket of warm water and pour it in slowly while stirring. Silica gels fastest around pH 7–9 and slowest near pH 3–4, so the bath must already be acidic when the silicate goes in. Bath assumed at ${BATH_TEMPERATURE_C} °C for the silica check.`,
    )
  }
  for (const ion of ION_ORDER) {
    const s = norm.source[ion] ?? 0
    const t = norm.target[ion] ?? 0
    if (s > t) {
      sharedWarnings.push(
        `${speciesLabel(ion)}: the source water already has ${s.toFixed(1)} mg/L, above the card's ${t.toFixed(1)} mg/L; salts cannot remove it.`,
      )
    }
  }
  const excluded = norm.notReplicated.filter(
    (n) => n.reason === 'excluded-sulfur' || n.reason === 'excluded-iron',
  )
  if (excluded.length > 0) {
    sharedWarnings.push(
      `Sulfur and iron species on the card (${excluded.map((n) => n.key).join(', ')}) are intentionally not replicated — no sulfur or iron ingredient is suggested.`,
    )
  }
  if (norm.sourceWaterIgnored.length > 0) {
    sharedWarnings.push(
      `source_water keys not modelled and ignored: ${norm.sourceWaterIgnored.join(', ')}.`,
    )
  }
  for (const n of norm.notes) sharedWarnings.push(n)

  const first = variants[0]
  const out: OnsenResult = {
    name: norm.name,
    units: norm.units,
    batch: norm.batch,
    litres,
    recipe: first.recipe,
    match: first.match,
    readouts: first.readouts,
    warnings: [...first.warnings, ...sharedWarnings],
    notReplicated: norm.notReplicated,
    sourceWaterIgnored: norm.sourceWaterIgnored,
    variants,
    suggested,
    sharedWarnings,
  }
  if (norm.springType !== undefined) out.springType = norm.springType
  if (norm.temperatureC !== undefined) out.temperatureC = norm.temperatureC
  return out
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits)
}

function reasonText(n: NotReplicated): string {
  switch (n.reason) {
    case 'excluded-sulfur':
      return 'sulfur species — excluded, never replicated'
    case 'excluded-iron':
      return 'iron species — excluded, never replicated'
    case 'reference-only':
      return 'reported only, not a fit target'
    case 'no-ingredient':
      return 'no ingredient in the palette'
  }
}

/** One line per liquid ingredient: grams as poured and the matching volume. */
export function liquidLines(recipe: readonly RecipeLine[]): string[] {
  return recipe
    .filter((x) => x.millilitres !== undefined)
    .map(
      (x) =>
        `Liquid: ${x.purchaseName}: ${fmt(x.grams, 1)} g ≈ ${fmt(x.millilitres!, 0)} mL (${SALTS[x.saltId].densityGPerMl} g/mL).`,
    )
}

/** Summary rows for the acid-options table (shared by both renderers). */
export function acidSummaryRows(r: OnsenResult): string[][] {
  return r.variants.map((v) => {
    const line = v.recipe.find((l) => l.saltId === v.acid)
    const dose = line
      ? `${fmt(line.grams, 0)} g${line.millilitres !== undefined ? ` ≈ ${fmt(line.millilitres, 0)} mL` : ''}`
      : 'none needed'
    const flags = [
      ...v.readouts.saturation.map((s) => s.mineral),
      ...v.readouts.precipitation
        .filter((p) => p.mineral !== 'amorphous-silica')
        .map((p) => p.mineral),
    ]
    const extras = v.extraIons.map((e) => `${e.key} ${fmt(e.mgPerL, 0)} mg/L`)
    return [
      `${ACID_SHORT_NAME[v.acid]}${v.acid === r.suggested ? ' *' : ''}`,
      dose,
      fmt(v.readouts.phEstimate, 1),
      `${fmt(v.worstDiffPct, 0)}%`,
      flags.length ? flags.join(', ') : 'none',
      extras.length ? extras.join(', ') : '—',
    ]
  })
}

export const ACID_SUMMARY_HEADER = [
  'Acid',
  'Dose for bath',
  'Est. pH',
  'Worst ion off',
  'Precipitation',
  'Extra ions',
]

/** Render an `OnsenResult` as the Markdown report the CLI prints with --markdown. */
export function renderMarkdown(r: OnsenResult): string {
  const lines: string[] = []
  const meta: string[] = []
  if (r.springType) meta.push(r.springType)
  if (r.temperatureC !== undefined) meta.push(`${r.temperatureC} °C at source`)
  if (r.readouts.cardPh !== undefined) meta.push(`card pH ${r.readouts.cardPh}`)
  lines.push(`# Onsen bath recipe — ${r.name}`)
  lines.push('')
  const litresNote = r.batch.unit === 'gal' ? ` (${fmt(r.litres, 0)} L)` : ''
  lines.push(
    `Bath volume: **${r.batch.volume} ${r.batch.unit}**${litresNote}. Card units: ${r.units}${meta.length ? '. ' + meta.join(', ') : ''}.`,
  )
  lines.push('')

  lines.push('## Acid options')
  lines.push('')
  lines.push(`| ${ACID_SUMMARY_HEADER.join(' | ')} |`)
  lines.push('| --- | ---: | ---: | ---: | --- | --- |')
  for (const row of acidSummaryRows(r)) lines.push(`| ${row.join(' | ')} |`)
  lines.push('')
  lines.push(
    `\\* suggested: ${ACID_SHORT_NAME[r.suggested]} (composition first, then precipitation, then closeness to the card pH). ${r.variants.length} recipes follow, one per acid.`,
  )
  lines.push('')

  r.variants.forEach((v, i) => {
    lines.push(`## Recipe ${i + 1} of ${r.variants.length} — ${ACID_SHORT_NAME[v.acid]}`)
    lines.push('')
    lines.push('### Recipe')
    lines.push('')
    if (v.recipe.length === 0) {
      lines.push(
        '_No salt needed — the source water already meets or exceeds every fitted ion._',
      )
    } else {
      lines.push('| Ingredient | Formula | Grams for bath | g/L |')
      lines.push('| --- | --- | ---: | ---: |')
      for (const line of v.recipe) {
        lines.push(
          `| ${line.purchaseName} | ${line.formula} | ${fmt(line.grams, 1)} | ${fmt(line.gramsPerLitre, 3)} |`,
        )
      }
      const liquids = liquidLines(v.recipe)
      if (liquids.length) {
        lines.push('')
        for (const l of liquids) lines.push(l)
      }
    }
    lines.push('')
    lines.push('### Match')
    lines.push('')
    lines.push('| Ion | Target mg/L | Result mg/L | Difference |')
    lines.push('| --- | ---: | ---: | ---: |')
    for (const m of v.match) {
      const diff =
        m.diffPct === null
          ? 'n/a (not on card)'
          : `${m.diffPct >= 0 ? '+' : ''}${fmt(m.diffPct, 1)}%`
      lines.push(
        `| ${m.label} | ${fmt(m.target, 1)} | ${fmt(m.result, 1)} | ${diff} |`,
      )
    }
    for (const e of v.extraIons) {
      lines.push(`| ${e.label} (from the acid) | — | ${fmt(e.mgPerL, 1)} | not an onsen ion |`)
    }
    lines.push('')
    lines.push(
      `TDS of result: ${fmt(v.readouts.tds, 0)} mg/L. Sulfate:chloride ${isFinite(v.readouts.sulfateChlorideRatio) ? fmt(v.readouts.sulfateChlorideRatio, 2) : '∞'}. Estimated pH ${fmt(v.readouts.phEstimate, 1)}${v.readouts.cardPh !== undefined ? ` (card ${v.readouts.cardPh})` : ''}.`,
    )
    lines.push('')
    lines.push('### Fidelity')
    lines.push('')
    lines.push('| Metric | This recipe | The onsen card | Gap |')
    lines.push('| --- | --- | --- | --- |')
    for (const fl of v.fidelity) {
      lines.push(`| ${fl.metric} | ${fl.recipe} | ${fl.card} | ${fl.note} |`)
    }
    lines.push('')
    lines.push('### Warnings')
    lines.push('')
    for (const w of v.warnings) lines.push(`- ${w}`)
    lines.push('')
  })

  lines.push('## Not replicated')
  lines.push('')
  if (r.notReplicated.length === 0) {
    lines.push('_Every component on the card is a fit target._')
  } else {
    lines.push('| Component | Card value | mg/L | Why |')
    lines.push('| --- | ---: | ---: | --- |')
    for (const n of r.notReplicated) {
      const mg = n.mgPerL !== undefined ? fmt(n.mgPerL, 2) : '—'
      lines.push(
        `| ${speciesLabel(n.key)} | ${n.reported} ${n.unit} | ${mg} | ${reasonText(n)} |`,
      )
    }
  }
  lines.push('')

  lines.push('## General warnings')
  lines.push('')
  if (r.sharedWarnings.length === 0) lines.push('_None._')
  for (const w of r.sharedWarnings) lines.push(`- ${w}`)
  lines.push('')
  return lines.join('\n')
}
