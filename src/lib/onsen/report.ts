// Run the solver on a normalised onsen card and render the result.
//
// The fit uses `'relative'` weighting (each ion row scaled by 1/max(target, 1))
// over the FULL salt palette, so a 6 mg/L carbonate figure matters as much as
// an 820 mg/L sodium figure. Output is a plain data object (for `--json`) plus
// a Markdown renderer.

import { IONS, ION_ORDER, SALTS, SALT_ORDER } from '../chem/constants'
import type { IonId, SaltId } from '../chem/constants'
import { GYPSUM_CEILING_G_PER_L, solve } from '../solver/solve'
import type { SaturationWarning, SolveResult } from '../solver/types'
import { speciesLabel } from './species'
import type { NormalizedOnsen, NotReplicated } from './types'

export interface RecipeLine {
  saltId: SaltId
  purchaseName: string
  name: string
  formula: string
  /** Grams for the whole bath. */
  grams: number
  gramsPerLitre: number
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

export interface OnsenReadouts {
  tds: number
  /** meq/L, cation minus anion equivalents, of the RESULT profile. */
  chargeResidual: number
  /** meq/L charge residual of the card's fitted ions, for comparison. */
  targetChargeResidual: number
  sulfateChlorideRatio: number
  /** Approximate pH from CO3/HCO3, when both are present in the result. */
  phEstimate?: number
  /** pH printed on the card, when given. */
  cardPh?: number
  gypsumCeilingHit: boolean
  saturation: SaturationWarning[]
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

/** Solve a normalised card with relative weighting over the full palette. */
export function runOnsen(norm: NormalizedOnsen): OnsenResult {
  const result: SolveResult = solve(
    norm.target,
    norm.source,
    SALT_ORDER,
    norm.batch,
    { weighting: 'relative' },
  )

  const litres =
    norm.batch.unit === 'gal'
      ? norm.batch.volume * LITRES_PER_US_GALLON
      : norm.batch.volume

  const recipe: RecipeLine[] = SALT_ORDER.filter(
    (id) => (result.recipe[id] ?? 0) > 0,
  ).map((id) => ({
    saltId: id,
    purchaseName: SALTS[id].purchaseName,
    name: SALTS[id].name,
    formula: SALTS[id].formula,
    grams: result.recipe[id] ?? 0,
    gramsPerLitre: result.dosePerLitre[id] ?? 0,
  }))

  const match: MatchLine[] = ION_ORDER.filter(
    (ion) =>
      (norm.target[ion] ?? 0) !== 0 || (result.resultProfile[ion] ?? 0) !== 0,
  ).map((ion) => {
    const target = norm.target[ion] ?? 0
    const res = result.resultProfile[ion] ?? 0
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

  const readouts: OnsenReadouts = {
    tds: result.readouts.tds,
    chargeResidual: result.readouts.chargeResidual,
    targetChargeResidual: chargeResidualOf(norm.target),
    sulfateChlorideRatio: result.readouts.sulfateChlorideRatio,
    gypsumCeilingHit,
    saturation: result.warnings,
  }
  if (result.readouts.phEstimate !== undefined) {
    readouts.phEstimate = result.readouts.phEstimate
  }
  if (norm.ph !== undefined) readouts.cardPh = norm.ph

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
    if (m.target === 0 && m.result > 0) {
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
  warnings.push(
    `Charge residual of the result: ${readouts.chargeResidual.toFixed(2)} meq/L (card's fitted ions: ${readouts.targetChargeResidual.toFixed(2)} meq/L).` +
      (recipe.some((r) => r.saltId === 'sodiumMetasilicate')
        ? ' Sodium metasilicate contributes hydroxide, which is not modelled, so a positive residual here is expected.'
        : ''),
  )
  if (readouts.phEstimate !== undefined) {
    const card =
      readouts.cardPh !== undefined ? ` Card pH: ${readouts.cardPh}.` : ''
    warnings.push(
      `Approximate pH ≈ ${readouts.phEstimate.toFixed(1)} from the CO₃²⁻/HCO₃⁻ ratio (pKa₂ 10.33, no activity correction — rough guide only).${card}`,
    )
  } else if (readouts.cardPh !== undefined) {
    warnings.push(
      `Card pH: ${readouts.cardPh}. No pH estimate — it needs both HCO₃⁻ and CO₃²⁻ in the result.`,
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
    `TDS of result: ${fmt(r.readouts.tds, 0)} mg/L. Sulfate:chloride ${isFinite(r.readouts.sulfateChlorideRatio) ? fmt(r.readouts.sulfateChlorideRatio, 2) : '∞'}.`,
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
