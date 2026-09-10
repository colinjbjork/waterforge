// Production solver: target profile + source water + salt palette -> recipe.
//
// We solve A x = (target - source) for salt doses x >= 0, where A is the ion x
// salt matrix (mg ion per g salt per L) and the right-hand side is the per-ion
// deficit the salts must supply. Non-negativity is enforced with NNLS. A single
// gypsum solubility-ceiling clamp caps calcium sulfate at roughly its saturation
// limit, since beyond that gypsum simply will not dissolve. We then report the
// resulting ion profile plus derived readouts and saturation warnings. See the
// solver notes under `docs/`.

import {
  CO3_WEIGHT,
  HCO3_WEIGHT,
  IONS,
  ION_ORDER,
  SALT_ORDER,
  type IonId,
  type SaltId,
} from '../chem'
import { litresToUsGallons } from '../chem/conversions'
import { buildMatrix, contribution, forward } from './matrix'
import { nnls } from './nnls'
import { saturationWarnings } from './saturation'
import type {
  BatchOptions,
  IonProfile,
  Readouts,
  SaltDose,
  SolveOptions,
  SolveResult,
  Weighting,
} from './types'

// Gypsum dissolves to roughly 2.0-2.5 g/L before saturating; we clamp at the
// lower, conservative end so doses we emit are physically achievable.
export const GYPSUM_CEILING_G_PER_L = 2.0

/**
 * Recipe-selection policy (ADR 0009).
 *
 * When several salts can source the same ion (gypsum and Epsom both supply SO₄;
 * NaCl and CaCl₂ both supply Cl), many non-negative recipes hit the same target,
 * and plain NNLS returns the minimum-L2-norm one — which splits a dose across
 * redundant salts and, worse, depends on the column order of the palette. The
 * surfaced recipe must instead be deterministic and intuitive.
 *
 * We resolve the freedom with a deterministic, priority-ordered greedy support
 * selection layered on top of NNLS (a lexicographic objective):
 *
 *   1. Best fit FIRST. NNLS over the whole palette gives the optimal residual
 *      r*. We never accept a recipe worse than r*, so when the target is
 *      achievable (r* ≈ 0) the result is still exact — the golden invariant
 *      (ADR 0007) is untouched.
 *   2. Priority/sparsity SECOND. Among the salts that reach r*, we pick the
 *      highest-priority minimal set by walking SALT_ORDER and adding salts only
 *      until r* is met, then pruning any salt whose removal does not raise the
 *      residual above r*. Salt order is canonicalised to SALT_ORDER, so the
 *      output is independent of the caller's palette ordering.
 *
 * The slack below is exactness-safe: it scales with the target magnitude but
 * stays far below any meaningful dose, so it only ever collapses genuine ties
 * (degenerate, equal-residual solutions) — never a salt the fit actually needs.
 */
const SUPPORT_SLACK_REL = 1e-9

/**
 * Second dissociation constant of carbonic acid (HCO3- <-> H+ + CO3 2-) as a
 * pKa at 25 C. Used only for the approximate pH readout.
 */
export const CARBONATE_PKA2 = 10.33

/**
 * Per-ion row weights for the least-squares fit (see `Weighting`).
 *
 * `'relative'` scales each row by 1 / max(target, 1 mg/L): the 1 mg/L floor
 * keeps zero and trace targets from blowing up the weight, and means an ion the
 * target does not mention is still penalised (at absolute scale) if a salt
 * drags it in.
 */
function rowWeights(target: IonProfile, weighting: Weighting): number[] {
  return ION_ORDER.map((ion) =>
    weighting === 'relative' ? 1 / Math.max(target[ion] ?? 0, 1) : 1,
  )
}

/** Scale row i of A and b by w[i]; the NNLS optimum is then the weighted fit. */
function applyWeights(
  A: number[][],
  b: number[],
  w: number[],
): { A: number[][]; b: number[] } {
  return {
    A: A.map((row, i) => row.map((v) => v * w[i])),
    b: b.map((v, i) => v * w[i]),
  }
}

/**
 * Residual 2-norm and the NNLS solution restricted to `salts` (in order), in
 * the weighted space (`w` = 1 everywhere for `'absolute'` weighting).
 */
function fitOn(
  salts: readonly SaltId[],
  b: number[],
  w: number[],
): { x: number[]; r: number } {
  if (salts.length === 0) {
    let sq = 0
    for (let i = 0; i < b.length; i++) sq += (b[i] * w[i]) ** 2
    return { x: [], r: Math.sqrt(sq) }
  }
  const weighted = applyWeights(buildMatrix(salts), b, w)
  const { x, residualNorm } = nnls(weighted.A, weighted.b)
  return { x, r: residualNorm }
}

/**
 * Choose the deterministic, priority-minimal salt support that attains the
 * optimal residual, then return the NNLS doses on that support (aligned to the
 * returned `salts`). See the policy note above and ADR 0009.
 */
function selectRecipe(
  palette: readonly SaltId[],
  b: number[],
  w: number[],
): { salts: SaltId[]; x: number[] } {
  // Canonicalise to the fixed priority order so the result does not depend on
  // the caller's palette ordering.
  const ordered = SALT_ORDER.filter((s) => palette.includes(s))

  // Optimal residual over the whole palette — the bar we must not fall below.
  const rStar = fitOn(ordered, b, w).r
  let bSq = 0
  for (let i = 0; i < b.length; i++) bSq += (b[i] * w[i]) ** 2
  const threshold = rStar + SUPPORT_SLACK_REL * (1 + Math.sqrt(bSq))

  // Forward selection: add salts in priority order until r* is reached.
  const chosen: SaltId[] = []
  for (const salt of ordered) {
    chosen.push(salt)
    if (fitOn(chosen, b, w).r <= threshold) break
  }

  // Pruning: drop any salt (lowest priority first) whose removal still attains
  // r*. This strips redundant, equal-residual contributors.
  for (let i = chosen.length - 1; i >= 0; i--) {
    const trial = chosen.filter((_, idx) => idx !== i)
    if (fitOn(trial, b, w).r <= threshold) chosen.splice(i, 1)
  }

  return { salts: chosen, x: fitOn(chosen, b, w).x }
}

/** Sum a profile's ion concentrations (mg/L) -> total dissolved solids. */
function totalDissolvedSolids(profile: IonProfile): number {
  let tds = 0
  for (const ion of ION_ORDER) tds += profile[ion] ?? 0
  return tds
}

/**
 * Charge-balance residual (meq/L): cation equivalents minus anion equivalents.
 * Each ion contributes (mg/L / molarMass) * |charge| equivalents, signed by the
 * charge. A balanced profile sits near zero.
 */
function chargeResidual(profile: IonProfile): number {
  let meq = 0
  for (const ion of ION_ORDER) {
    const mg = profile[ion] ?? 0
    if (mg === 0) continue
    const { molarMass, charge } = IONS[ion]
    meq += (mg / molarMass) * charge
  }
  return meq
}

/**
 * Approximate pH from the carbonate / bicarbonate ratio (Henderson-Hasselbalch
 * on the second carbonic-acid dissociation). Undefined unless both species are
 * present. Activity coefficients are ignored, so this is a rough guide only.
 */
export function estimatePh(profile: IonProfile): number | undefined {
  const hco3 = profile.HCO3 ?? 0
  const co3 = profile.CO3 ?? 0
  if (hco3 <= 0 || co3 <= 0) return undefined
  return CARBONATE_PKA2 + Math.log10(co3 / CO3_WEIGHT / (hco3 / HCO3_WEIGHT))
}

/** Compute the UI readouts for a result profile. */
function computeReadouts(profile: IonProfile): Readouts {
  const so4 = profile.SO4 ?? 0
  const cl = profile.Cl ?? 0
  const readouts: Readouts = {
    sulfateChlorideRatio: cl > 0 ? so4 / cl : Infinity,
    tds: totalDissolvedSolids(profile),
    chargeResidual: chargeResidual(profile),
  }
  const ph = estimatePh(profile)
  if (ph !== undefined) readouts.phEstimate = ph
  return readouts
}

/** Add two ion profiles (mg/L), keeping only non-zero ions. */
function addProfiles(a: IonProfile, b: IonProfile): IonProfile {
  const out: IonProfile = {}
  for (const ion of ION_ORDER) {
    const v = (a[ion] ?? 0) + (b[ion] ?? 0)
    if (v !== 0) out[ion] = v
  }
  return out
}

/**
 * Solve for the salt recipe that turns `source` water into `target`.
 *
 * @param target  desired finished ion profile (mg/L).
 * @param source  ions already present in the starting water (mg/L); omit for distilled.
 * @param salts   available salt palette; defaults to the full set in priority order.
 * @param batch   batch size + unit to scale the per-litre dose to.
 * @param options residual weighting (`'absolute'` default, or `'relative'`).
 */
export function solve(
  target: IonProfile,
  source: IonProfile = {},
  salts: readonly SaltId[] = SALT_ORDER,
  batch: BatchOptions = { volume: 1, unit: 'L' },
  options: SolveOptions = {},
): SolveResult {
  // Right-hand side: per-ion deficit (mg/L) the salts must supply. Negative
  // deficits (source already richer than target) cannot be fixed by adding
  // salts, so NNLS just fits them as closely as non-negativity allows.
  const b = ION_ORDER.map((ion) => (target[ion] ?? 0) - (source[ion] ?? 0))

  // Row weights: all ones for the default absolute fit (byte-identical to the
  // original behaviour); 1/max(target,1) for the relative fit.
  const w = rowWeights(target, options.weighting ?? 'absolute')

  // Deterministic, priority-minimal recipe selection (ADR 0009): NNLS finds the
  // best fit, then we collapse the underdetermined freedom toward a sparse,
  // SALT_ORDER-preferred support without giving up the optimal residual.
  const { salts: chosen, x } = selectRecipe(salts, b, w)

  // Per-litre dose, with the single gypsum solubility-ceiling clamp applied.
  const dosePerLitre: SaltDose = {}
  chosen.forEach((saltId, col) => {
    let grams = x[col]
    if (grams <= 0) return
    if (saltId === 'gypsum' && grams > GYPSUM_CEILING_G_PER_L) {
      grams = GYPSUM_CEILING_G_PER_L
    }
    dosePerLitre[saltId] = grams
  })

  // Resulting profile = source water + everything the doses add.
  const added = forward(dosePerLitre)
  const resultProfile = addProfiles(source, added)

  // Scale to the requested batch volume.
  const litres =
    (batch.unit ?? 'L') === 'gal'
      ? batch.volume / litresToUsGallons(1)
      : batch.volume
  const recipe: SaltDose = {}
  for (const saltId of Object.keys(dosePerLitre) as SaltId[]) {
    recipe[saltId] = (dosePerLitre[saltId] ?? 0) * litres
  }

  return {
    recipe,
    dosePerLitre,
    resultProfile,
    readouts: computeReadouts(resultProfile),
    warnings: saturationWarnings(resultProfile),
  }
}

// Re-exported so callers can introspect a single salt's contribution if needed.
export { contribution }
export type { IonId, SaltId }
