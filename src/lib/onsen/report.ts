// Run the solver on a normalised onsen card and render the result.
//
// The fit uses `'relative'` weighting (each ion row scaled by 1/max(target, 1))
// over the FULL salt palette, so a 6 mg/L carbonate figure matters as much as
// an 820 mg/L sodium figure. After the fit, the hydroxide the salts release
// (sodium metasilicate: 2 OH⁻ per mole) is cancelled stoichiometrically with
// hydrochloric acid, the acid's chloride is credited back to the fit, and the
// bath pH / precipitation are estimated on the final profile — see
// `chemistry.ts`. Output is a plain data object (for `--json`) plus a
// Markdown renderer.

import { ACIDS, IONS, ION_ORDER, SALTS, SALT_ORDER } from '../chem/constants'
import type { IonId, SaltId } from '../chem/constants'
import { GYPSUM_CEILING_G_PER_L, solve } from '../solver/solve'
import type {
  IonProfile,
  SaltDose,
  SaturationWarning,
  SolveResult,
} from '../solver/types'
import {
  BATH_TEMPERATURE_C,
  cardAcidity,
  estimateBathPh,
  hydroxideReleased,
  precipitationWarnings,
} from './chemistry'
import type { CardAcidityBasis, PrecipitationWarning } from './chemistry'
import { speciesLabel } from './species'
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

export interface MatchLine {
  ion: IonId
  label: string
  /** mg/L the card asks for. */
  target: number
  /** mg/L the recipe (plus source water) produces. */
  result: number
  /** (result − target) / target × 100; null when target is zero. */
  diffPct: number | null
}

export interface AcidReadout {
  saltId: SaltId
  /** mmol/L of acid dosed after the fit. */
  mmolPerL: number
  /** meq/L of hydroxide the fitted salts release (what the acid cancels). */
  hydroxideReleased: number
  /** Free acidity the card reports (meq/L, negative = alkaline) and its basis. */
  cardAcidity: number
  cardAcidityBasis: CardAcidityBasis
  /** Estimated pH the bath would have had without the acid. */
  phWithoutAcid: number
}

export interface OnsenReadouts {
  tds: number
  /** meq/L, cation minus anion equivalents, of the RESULT profile. */
  chargeResidual: number
  /** meq/L charge residual of the card's fitted ions, for comparison. */
  targetChargeResidual: number
  sulfateChlorideRatio: number
  /**
   * Estimated bath pH from the full proton balance (carbonate, silicate,
   * water) of the result profile — always present.
   */
  phEstimate: number
  /** pH printed on the card, when given. */
  cardPh?: number
  gypsumCeilingHit: boolean
  saturation: SaturationWarning[]
  /** Hydroxide / silicate precipitation checks at the estimated pH. */
  precipitation: PrecipitationWarning[]
  /** Present when acid was dosed to cancel released hydroxide. */
  acid?: AcidReadout
}

export interface OnsenResult {
  name: string
  units: NormalizedOnsen['units']
  springType?: string
  temperatureC?: number
  batch: NormalizedOnsen['batch']
  litres: number
  recipe: RecipeLine[]
  match: MatchLine[]
  notReplicated: NotReplicated[]
  sourceWaterIgnored: string[]
  readouts: OnsenReadouts
  warnings: string[]
}

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

/** The acid the onsen layer neutralises released hydroxide with. */
export const NEUTRALISING_ACID: SaltId = 'hydrochloricAcid'

/** Recipe lines are printed in this order: the fitted palette, then acids. */
const RECIPE_ORDER: readonly SaltId[] = [...SALT_ORDER, ...ACIDS]

/**
 * Fit the card, then dose acid against the hydroxide the fitted salts release.
 *
 * The acid is not a fit variable: its amount is fixed by stoichiometry (OH⁻
 * released + the card's own free acidity), and only its chloride feeds back
 * into the fit, as if it were already in the source water. Sodium
 * metasilicate is the sole H2SiO3 source so its dose barely moves when the
 * chloride credit changes; the loop converges in two or three passes.
 */
function fitWithAcid(norm: NormalizedOnsen): {
  result: SolveResult
  acidMmolPerL: number
  hydroxide: number
} {
  const clPerMmol = IONS.Cl.molarMass // mg/L of Cl⁻ per mmol/L of HCl
  const want = cardAcidity(norm).meqPerL
  let acid = 0
  let solvedFor = -1
  let result!: SolveResult
  let hydroxide = 0
  for (let i = 0; i < 10 && solvedFor !== acid; i++) {
    const source: IonProfile =
      acid > 0
        ? { ...norm.source, Cl: (norm.source.Cl ?? 0) + acid * clPerMmol }
        : norm.source
    result = solve(norm.target, source, SALT_ORDER, norm.batch, {
      weighting: 'relative',
    })
    solvedFor = acid
    hydroxide = hydroxideReleased(result.dosePerLitre)
    const next = Math.max(0, hydroxide + want)
    if (Math.abs(next - acid) > 1e-9) acid = next
  }
  return { result, acidMmolPerL: solvedFor, hydroxide }
}

/** Solve a normalised card with relative weighting over the full palette. */
export function runOnsen(norm: NormalizedOnsen): OnsenResult {
  const { result, acidMmolPerL, hydroxide } = fitWithAcid(norm)
  const acidity = cardAcidity(norm)

  const litres =
    norm.batch.unit === 'gal'
      ? norm.batch.volume * LITRES_PER_US_GALLON
      : norm.batch.volume

  // Doses: the fitted salts plus the acid (grams of the retail solution).
  const dosePerLitre: SaltDose = { ...result.dosePerLitre }
  if (acidMmolPerL > 0) {
    dosePerLitre[NEUTRALISING_ACID] =
      (acidMmolPerL / 1000) * SALTS[NEUTRALISING_ACID].molarMass
  }

  const recipe: RecipeLine[] = RECIPE_ORDER.filter(
    (id) => (dosePerLitre[id] ?? 0) >= MIN_DOSE_G_PER_L,
  ).map((id) => {
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

  // The result profile already carries the acid's chloride (credited to the
  // source water during the fit).
  const profile = result.resultProfile

  const match: MatchLine[] = ION_ORDER.filter(
    (ion) =>
      (norm.target[ion] ?? 0) !== 0 ||
      (profile[ion] ?? 0) >= MIN_VISIBLE_MG_PER_L,
  ).map((ion) => {
    const target = norm.target[ion] ?? 0
    const res = profile[ion] ?? 0
    return {
      ion,
      label: speciesLabel(ion),
      target,
      result: res,
      diffPct: target > 0 ? ((res - target) / target) * 100 : null,
    }
  })

  const gypsumCeilingHit =
    (result.dosePerLitre.gypsum ?? 0) >= GYPSUM_CEILING_G_PER_L

  const phEstimate = estimateBathPh(profile)
  const precipitation = precipitationWarnings(profile, phEstimate)

  const readouts: OnsenReadouts = {
    tds: result.readouts.tds,
    chargeResidual: result.readouts.chargeResidual,
    targetChargeResidual: chargeResidualOf(norm.target),
    sulfateChlorideRatio: result.readouts.sulfateChlorideRatio,
    phEstimate,
    gypsumCeilingHit,
    saturation: result.warnings,
    precipitation,
  }
  if (norm.ph !== undefined) readouts.cardPh = norm.ph
  if (acidMmolPerL > 0) {
    const withoutAcid: IonProfile = {
      ...profile,
      Cl: (profile.Cl ?? 0) - acidMmolPerL * IONS.Cl.molarMass,
    }
    readouts.acid = {
      saltId: NEUTRALISING_ACID,
      mmolPerL: acidMmolPerL,
      hydroxideReleased: hydroxide,
      cardAcidity: acidity.meqPerL,
      cardAcidityBasis: acidity.basis,
      phWithoutAcid: estimateBathPh(withoutAcid),
    }
  }

  const warnings: string[] = []
  for (const w of result.warnings) {
    warnings.push(`${w.message} (SI ${w.saturationIndex.toFixed(2)})`)
  }
  if (gypsumCeilingHit) {
    warnings.push(
      `Gypsum dose clamped at its ${GYPSUM_CEILING_G_PER_L} g/L solubility ceiling; calcium/sulfate will fall short of the card.`,
    )
  }
  for (const m of match) {
    if (m.target > 0 && m.diffPct !== null && Math.abs(m.diffPct) > 10) {
      warnings.push(
        `${m.label}: recipe gives ${m.result.toFixed(1)} mg/L vs ${m.target.toFixed(1)} mg/L on the card (${m.diffPct >= 0 ? '+' : ''}${m.diffPct.toFixed(0)}%).`,
      )
    }
    if (m.target === 0 && m.result >= MIN_VISIBLE_MG_PER_L) {
      warnings.push(
        `${m.label}: ${m.result.toFixed(1)} mg/L added as a by-product of another salt (not on the card).`,
      )
    }
  }
  for (const ion of ION_ORDER) {
    const s = norm.source[ion] ?? 0
    const t = norm.target[ion] ?? 0
    if (s > t) {
      warnings.push(
        `${speciesLabel(ion)}: the source water already has ${s.toFixed(1)} mg/L, above the card's ${t.toFixed(1)} mg/L; salts cannot remove it.`,
      )
    }
  }
  if (readouts.acid) {
    const a = readouts.acid
    const acidClMg = a.mmolPerL * IONS.Cl.molarMass
    if (acidClMg > (norm.target.Cl ?? 0)) {
      warnings.push(
        `The acid's chloride alone (${acidClMg.toFixed(0)} mg/L) exceeds the card's ${(norm.target.Cl ?? 0).toFixed(0)} mg/L; a different acid would be needed to avoid overshooting chloride.`,
      )
    }
    const cardPart =
      a.cardAcidity !== 0
        ? ` and sets the card's ${Math.abs(a.cardAcidity).toFixed(2)} meq/L free ${a.cardAcidity > 0 ? 'acidity' : 'alkalinity'} (${a.cardAcidityBasis})`
        : ''
    warnings.push(
      `Hydroxide: sodium metasilicate releases ${a.hydroxideReleased.toFixed(2)} meq/L OH⁻ (2 per Na₂SiO₃); ${a.mmolPerL.toFixed(2)} mmol/L HCl cancels it${cardPart}. Without the acid the bath would sit near pH ${a.phWithoutAcid.toFixed(1)}.`,
    )
  }
  warnings.push(
    `Charge residual of the result: ${readouts.chargeResidual.toFixed(2)} meq/L (card's fitted ions: ${readouts.targetChargeResidual.toFixed(2)} meq/L).`,
  )
  {
    const card =
      readouts.cardPh !== undefined ? ` Card pH: ${readouts.cardPh}.` : ''
    warnings.push(
      `Approximate pH ≈ ${phEstimate.toFixed(1)} from the proton balance of the result (carbonate pKa 6.35/10.33, silicic acid pKa 9.84/13.2, 25 °C, no activity correction — rough guide only).${card}`,
    )
    if (
      readouts.cardPh !== undefined &&
      Math.abs(phEstimate - readouts.cardPh) > 0.5
    ) {
      warnings.push(
        `Estimated pH is ${Math.abs(phEstimate - readouts.cardPh).toFixed(1)} units from the card's: the recipe only cancels hydroxide the salts release and sets the card's free acidity, it does not fit pH (unfitted buffers such as free CO₂ set the rest).`,
      )
    }
  }
  for (const p of precipitation) warnings.push(p.message)
  if (readouts.acid) {
    const line = recipe.find((r) => r.saltId === NEUTRALISING_ACID)
    if (line?.millilitres !== undefined) {
      warnings.push(
        `Muriatic acid: ${line.grams.toFixed(0)} g ≈ ${line.millilitres.toFixed(0)} mL of 31.45% HCl (20° Baumé hardware-store grade, 1.16 g/mL). A 20% jug needs 1.57× the volume. Gloves and eye protection; add the acid to the bath water, never water to acid; never mix it with the metasilicate concentrate.`,
      )
    }
    warnings.push(
      `Order of addition: fill the tub, stir in the acid, dissolve the other salts, then dissolve the sodium metasilicate in a bucket of warm water and pour it in slowly while stirring. Silica gels fastest around pH 7–9 and slowest near pH 3–4, so the bath must already be acidic when the silicate goes in. Bath assumed at ${BATH_TEMPERATURE_C} °C for the silica check.`,
    )
  }
  const excluded = norm.notReplicated.filter(
    (n) => n.reason === 'excluded-sulfur' || n.reason === 'excluded-iron',
  )
  if (excluded.length > 0) {
    warnings.push(
      `Sulfur and iron species on the card (${excluded.map((n) => n.key).join(', ')}) are intentionally not replicated — no sulfur or iron ingredient is suggested.`,
    )
  }
  if (norm.sourceWaterIgnored.length > 0) {
    warnings.push(
      `source_water keys not modelled and ignored: ${norm.sourceWaterIgnored.join(', ')}.`,
    )
  }
  for (const n of norm.notes) warnings.push(n)

  const out: OnsenResult = {
    name: norm.name,
    units: norm.units,
    batch: norm.batch,
    litres,
    recipe,
    match,
    notReplicated: norm.notReplicated,
    sourceWaterIgnored: norm.sourceWaterIgnored,
    readouts,
    warnings,
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
export function liquidLines(r: OnsenResult): string[] {
  return r.recipe
    .filter((x) => x.millilitres !== undefined)
    .map(
      (x) =>
        `Liquid: ${x.purchaseName}: ${fmt(x.grams, 1)} g ≈ ${fmt(x.millilitres!, 0)} mL (${SALTS[x.saltId].densityGPerMl} g/mL).`,
    )
}

/** Render an `OnsenResult` as the Markdown report the CLI prints. */
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

  lines.push('## Recipe')
  lines.push('')
  if (r.recipe.length === 0) {
    lines.push(
      '_No salt needed — the source water already meets or exceeds every fitted ion._',
    )
  } else {
    lines.push('| Ingredient | Formula | Grams for bath | g/L |')
    lines.push('| --- | --- | ---: | ---: |')
    for (const line of r.recipe) {
      lines.push(
        `| ${line.purchaseName} | ${line.formula} | ${fmt(line.grams, 1)} | ${fmt(line.gramsPerLitre, 3)} |`,
      )
    }
    const liquids = liquidLines(r)
    if (liquids.length) {
      lines.push('')
      for (const l of liquids) lines.push(l)
    }
  }
  lines.push('')

  lines.push('## Match')
  lines.push('')
  lines.push('| Ion | Target mg/L | Result mg/L | Difference |')
  lines.push('| --- | ---: | ---: | ---: |')
  for (const m of r.match) {
    const diff =
      m.diffPct === null
        ? 'n/a (not on card)'
        : `${m.diffPct >= 0 ? '+' : ''}${fmt(m.diffPct, 1)}%`
    lines.push(
      `| ${m.label} | ${fmt(m.target, 1)} | ${fmt(m.result, 1)} | ${diff} |`,
    )
  }
  lines.push('')
  lines.push(
    `TDS of result: ${fmt(r.readouts.tds, 0)} mg/L. Sulfate:chloride ${isFinite(r.readouts.sulfateChlorideRatio) ? fmt(r.readouts.sulfateChlorideRatio, 2) : '∞'}. Estimated pH ${fmt(r.readouts.phEstimate, 1)}${r.readouts.cardPh !== undefined ? ` (card ${r.readouts.cardPh})` : ''}.`,
  )
  lines.push('')

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

  lines.push('## Warnings')
  lines.push('')
  for (const w of r.warnings) lines.push(`- ${w}`)
  lines.push('')
  return lines.join('\n')
}
