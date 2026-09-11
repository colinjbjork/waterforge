// Bath chemistry the least-squares fit cannot see.
//
// The solver matches ion masses. It does not know that sodium metasilicate
// dissolves to 2 Na⁺ + silicate + 2 OH⁻, so a recipe that hits the card's
// metasilicic-acid figure with it lands at pH ≈ 11–12 and drops the calcium and
// magnesium out as hydroxide / silicate solids. This module closes that gap:
//
// 1. `hydroxideReleased` — meq/L of OH⁻ the dosed salts release (from each
//    salt's declared `netCharge`).
// 2. `cardAcidity` — the free acidity the card itself reports (its H⁺ / OH⁻
//    lines, else its pH), which the bath should end up at.
// 3. `estimateBathPh` — the pH of a result profile from a full proton
//    balance over the carbonate, silicate and water systems (bisection).
// 4. `precipitationWarnings` — saturation checks at that pH for brucite
//    Mg(OH)₂, portlandite Ca(OH)₂, calcium/magnesium silicate hydrate, and
//    amorphous silica.
//
// Every constant is a 25 °C literature value with activity coefficients
// ignored, except the amorphous-silica solubility, which is evaluated at bath
// temperature. Treat the pH as a rough guide, the precipitation flags as
// "this will visibly happen", not as an equilibrium model.

import {
  ATOMIC_WEIGHTS,
  IONS,
  ION_ORDER,
  OH_WEIGHT,
  SALTS,
} from '../chem/constants'
import type { IonId, SaltId } from '../chem/constants'
import type { IonProfile, SaltDose } from '../solver/types'
import type { NormalizedOnsen } from './types'

/** Acid dissociation constants (pKa, 25 °C) of the weak systems modelled. */
export const PKA = {
  /** H₂CO₃ ⇌ HCO₃⁻ + H⁺ */
  carbonic1: 6.35,
  /** HCO₃⁻ ⇌ CO₃²⁻ + H⁺ */
  carbonic2: 10.33,
  /** H₄SiO₄ (≡ H₂SiO₃·H₂O) ⇌ H₃SiO₄⁻ + H⁺ (Sjöberg et al. 1985) */
  silicic1: 9.84,
  /** H₃SiO₄⁻ ⇌ H₂SiO₄²⁻ + H⁺ (Sjöberg et al. 1985) */
  silicic2: 13.2,
  /** H₂O ⇌ H⁺ + OH⁻ */
  water: 14.0,
} as const

/** log10 Ksp (25 °C) of the hydroxides screened. */
export const LOG_KSP_HYDROXIDE = {
  /** Mg(OH)₂, Ksp 5.6 × 10⁻¹² */
  brucite: -11.25,
  /** Ca(OH)₂, Ksp 5.0 × 10⁻⁶ */
  portlandite: -5.3,
} as const

/** Temperature the silica solubility is evaluated at: a hot bath. */
export const BATH_TEMPERATURE_C = 40

/**
 * Calcium / magnesium silicate hydrates have no single Ksp (they are
 * gel-like solid solutions), but they form readily once the water is alkaline
 * enough for silicate anions to exist alongside Ca²⁺ / Mg²⁺. Above this pH
 * with both present, expect a white gel.
 */
export const SILICATE_HYDRATE_PH = 10

/**
 * log10 K for SiO₂(am) + 2 H₂O ⇌ H₄SiO₄ as a function of temperature,
 * Gunnarsson & Arnórsson (2000), valid 0–350 °C. −2.71 at 25 °C, −2.59 at
 * 40 °C. Returns the molar solubility of dissolved silica (as H₄SiO₄).
 */
export function amorphousSilicaLogK(tempC: number): number {
  const T = tempC + 273.15
  return -8.476 - 485.24 / T - 2.268e-6 * T * T + 3.068 * Math.log10(T)
}

/** mg/L → mol/L for a modelled ion. */
function mol(profile: IonProfile, ion: IonId): number {
  return (profile[ion] ?? 0) / IONS[ion].molarMass / 1000
}

/**
 * Strong-ion difference (mol/L): cation equivalents minus the equivalents of
 * the anions that stay fully ionised at any bath pH (Cl⁻, SO₄²⁻). Whatever is
 * left over must be balanced by the weak-acid anions (HCO₃⁻, CO₃²⁻, the
 * silicate anions) and water's own OH⁻ / H⁺ — which is what fixes the pH.
 */
export function strongIonDifference(profile: IonProfile): number {
  let s = 0
  for (const ion of ION_ORDER) {
    if (ion === 'HCO3' || ion === 'CO3' || ion === 'H2SiO3') continue
    s += mol(profile, ion) * IONS[ion].charge
  }
  return s
}

/** Species concentrations (mol/L) of a profile at a given pH. */
export interface Speciation {
  h: number
  oh: number
  h2co3: number
  hco3: number
  co3: number
  /** Neutral dissolved silica, H₄SiO₄ (the card's H₂SiO₃). */
  h4sio4: number
  hsio3: number
  sio3: number
}

/** Fractions of a diprotic acid's three forms at [H⁺] = h. */
function diproticFractions(
  h: number,
  pka1: number,
  pka2: number,
): [number, number, number] {
  const k1 = 10 ** -pka1
  const k2 = 10 ** -pka2
  const d = h * h + k1 * h + k1 * k2
  return [(h * h) / d, (k1 * h) / d, (k1 * k2) / d]
}

/**
 * Distribute the profile's total carbonate and total silica over their acid /
 * base forms at the given pH (activity = concentration).
 */
export function speciate(profile: IonProfile, ph: number): Speciation {
  const h = 10 ** -ph
  const oh = 10 ** (ph - PKA.water)
  const cT = mol(profile, 'HCO3') + mol(profile, 'CO3')
  const siT = mol(profile, 'H2SiO3')
  const [c0, c1, c2] = diproticFractions(h, PKA.carbonic1, PKA.carbonic2)
  const [s0, s1, s2] = diproticFractions(h, PKA.silicic1, PKA.silicic2)
  return {
    h,
    oh,
    h2co3: cT * c0,
    hco3: cT * c1,
    co3: cT * c2,
    h4sio4: siT * s0,
    hsio3: siT * s1,
    sio3: siT * s2,
  }
}

/**
 * Proton-balance residual at a trial pH: (weak-acid anion equivalents + OH⁻
 * − H⁺) − strong-ion difference. Zero at the true pH; increases with pH.
 */
export function protonBalance(profile: IonProfile, ph: number): number {
  const s = speciate(profile, ph)
  return (
    s.hco3 +
    2 * s.co3 +
    s.hsio3 +
    2 * s.sio3 +
    s.oh -
    s.h -
    strongIonDifference(profile)
  )
}

/**
 * Estimate the pH of a result profile by bisection on the proton balance.
 * Pure water (or any balanced strong-electrolyte solution) returns 7.0.
 * Clamped to 0–14.
 */
export function estimateBathPh(profile: IonProfile): number {
  let lo = 0
  let hi = 14
  if (protonBalance(profile, lo) >= 0) return lo
  if (protonBalance(profile, hi) <= 0) return hi
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (protonBalance(profile, mid) < 0) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** mmol/L of a salt at a dose in g/L. */
function mmolPerL(saltId: SaltId, gramsPerLitre: number): number {
  return (gramsPerLitre / SALTS[saltId].molarMass) * 1000
}

/**
 * Hydroxide (meq/L) released by a dose set: each salt's mmol/L times its
 * declared positive `netCharge`.
 */
export function hydroxideReleased(dose: SaltDose): number {
  let meq = 0
  for (const saltId of Object.keys(dose) as SaltId[]) {
    const z = SALTS[saltId].netCharge ?? 0
    if (z > 0) meq += mmolPerL(saltId, dose[saltId] ?? 0) * z
  }
  return meq
}

/**
 * Hydrogen ion (meq/L) released by a dose set: each salt's mmol/L times its
 * declared negative `netCharge`.
 */
export function acidReleased(dose: SaltDose): number {
  let meq = 0
  for (const saltId of Object.keys(dose) as SaltId[]) {
    const z = SALTS[saltId].netCharge ?? 0
    if (z < 0) meq += mmolPerL(saltId, dose[saltId] ?? 0) * -z
  }
  return meq
}

export type CardAcidityBasis = 'card H⁺/OH⁻ lines' | 'card pH' | 'none'

export interface CardAcidity {
  /** Free acidity the card reports: H⁺ − OH⁻ in meq/L (negative = alkaline). */
  meqPerL: number
  basis: CardAcidityBasis
}

/**
 * The free acidity the bath should end up with. Analysis sheets print the
 * hydrogen-ion (H⁺) and hydroxide (OH⁻) rows explicitly; those win. Failing
 * that the card pH gives it (10⁻ᵖᴴ − 10ᵖᴴ⁻¹⁴, only material outside pH 5–9).
 * With neither, zero: cancel exactly what the salts release.
 */
export function cardAcidity(norm: NormalizedOnsen): CardAcidity {
  const h = norm.notReplicated.find((n) => n.key === 'H')?.mgPerL
  const oh = norm.notReplicated.find((n) => n.key === 'OH')?.mgPerL
  if (h !== undefined || oh !== undefined) {
    return {
      meqPerL: (h ?? 0) / ATOMIC_WEIGHTS.H - (oh ?? 0) / OH_WEIGHT,
      basis: 'card H⁺/OH⁻ lines',
    }
  }
  if (norm.ph !== undefined) {
    return {
      meqPerL: 1000 * (10 ** -norm.ph - 10 ** (norm.ph - PKA.water)),
      basis: 'card pH',
    }
  }
  return { meqPerL: 0, basis: 'none' }
}

export type PrecipitateMineral =
  'brucite' | 'portlandite' | 'silicate-hydrate' | 'amorphous-silica'

export interface PrecipitationWarning {
  mineral: PrecipitateMineral
  /** log10(IAP / Ksp) where a Ksp exists; omitted for the gel-forming check. */
  saturationIndex?: number
  message: string
}

const sign = (n: number): string => (n >= 0 ? '+' : '')

/**
 * What falls out of a result profile at its estimated pH. Gypsum and calcite
 * are screened by the solver already; this covers what the hydroxide /
 * silicate chemistry adds.
 */
export function precipitationWarnings(
  profile: IonProfile,
  ph: number,
  bathTempC: number = BATH_TEMPERATURE_C,
): PrecipitationWarning[] {
  const out: PrecipitationWarning[] = []
  const s = speciate(profile, ph)
  const mg = mol(profile, 'Mg')
  const ca = mol(profile, 'Ca')
  const siT = mol(profile, 'H2SiO3')

  if (mg > 0) {
    const si = Math.log10(mg * s.oh * s.oh) - LOG_KSP_HYDROXIDE.brucite
    if (si >= 0) {
      out.push({
        mineral: 'brucite',
        saturationIndex: si,
        message: `Brucite Mg(OH)₂ is supersaturated at the estimated pH ${ph.toFixed(1)} (SI ${sign(si)}${si.toFixed(1)}): the magnesium will drop out as a white cloud instead of staying dissolved.`,
      })
    }
  }
  if (ca > 0) {
    const si = Math.log10(ca * s.oh * s.oh) - LOG_KSP_HYDROXIDE.portlandite
    if (si >= 0) {
      out.push({
        mineral: 'portlandite',
        saturationIndex: si,
        message: `Portlandite Ca(OH)₂ is supersaturated at the estimated pH ${ph.toFixed(1)} (SI ${sign(si)}${si.toFixed(1)}): calcium hydroxide will precipitate.`,
      })
    }
  }
  if (siT > 0 && (ca > 0 || mg > 0) && ph >= SILICATE_HYDRATE_PH) {
    const who = [ca > 0 ? 'calcium' : '', mg > 0 ? 'magnesium' : '']
      .filter(Boolean)
      .join(' and ')
    out.push({
      mineral: 'silicate-hydrate',
      message: `Above about pH ${SILICATE_HYDRATE_PH} the ${who} and the dissolved silica combine into insoluble silicate hydrate (a white, gelatinous solid); at the estimated pH ${ph.toFixed(1)} the ${who} would not stay in solution.`,
    })
  }
  if (siT > 0) {
    const logK = amorphousSilicaLogK(bathTempC)
    const si = Math.log10(s.h4sio4) - logK
    if (si >= 0) {
      const solubleMg = 10 ** logK * 1000 * IONS.H2SiO3.molarMass
      const presentMg = s.h4sio4 * 1000 * IONS.H2SiO3.molarMass
      out.push({
        mineral: 'amorphous-silica',
        saturationIndex: si,
        message: `Amorphous silica is supersaturated at ${bathTempC} °C (SI ${sign(si)}${si.toFixed(2)}: ${presentMg.toFixed(0)} mg/L dissolved as H₂SiO₃ against ~${solubleMg.toFixed(0)} mg/L soluble). The water is metastable — the spring is in the same state once it cools — and silica polymerises slowest near pH 3–4, fastest at pH 7–9, so a bath at the card's acidity stays clear for its duration but will haze over hours.`,
      })
    }
  }
  return out
}
