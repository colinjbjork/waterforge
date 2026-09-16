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
import { EXTRA_SPECIES } from './species'
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
  /** HSO₄⁻ ⇌ SO₄²⁻ + H⁺ (only matters below pH ~3) */
  bisulfate: 1.99,
  /** B(OH)₃ + H₂O ⇌ B(OH)₄⁻ + H⁺ (the card's metaboric acid) */
  boric: 9.24,
} as const

/** log10 Ksp (25 °C) of calcite, CaCO₃, screened at the bath's actual pH. */
export const LOG_KSP_CALCITE = -8.48
/** log10 Ksp (25 °C) of gypsum, CaSO₄·2H₂O. */
export const LOG_KSP_GYPSUM = -4.58

/**
 * Ionic strength (mol/L) of a profile: ½ Σ c z² over the modelled ions plus
 * the dosed acid's anion at its full charge. Feeds the Davies correction.
 */
export function ionicStrength(
  profile: IonProfile,
  extras: WeakExtras = {},
): number {
  let i = 0
  for (const ion of ION_ORDER) {
    const z = IONS[ion].charge
    i += mol(profile, ion) * z * z
  }
  for (const o of extras.organic ?? []) {
    const z = o.pkas.length
    i += o.mol * z * z
  }
  return i / 2
}

/**
 * Davies equation: log10 of the activity coefficient of an ion of charge z at
 * ionic strength I (mol/L), 25 °C. Good to I ≈ 0.5, which covers any bath.
 */
export function daviesLogGamma(z: number, ionicStrengthMolar: number): number {
  const sq = Math.sqrt(ionicStrengthMolar)
  return -0.51 * z * z * (sq / (1 + sq) - 0.3 * ionicStrengthMolar)
}

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
 * the anion that stays fully ionised at any bath pH (Cl⁻). Whatever is left
 * over must be balanced by the weak-acid anions (HCO₃⁻, CO₃²⁻, the silicate
 * anions, sulfate / bisulfate, the dosed acid's anion, borate) and water's
 * own OH⁻ / H⁺ — which is what fixes the pH.
 */
export function strongIonDifference(profile: IonProfile): number {
  let s = 0
  for (const ion of ION_ORDER) {
    if (
      ion === 'HCO3' ||
      ion === 'CO3' ||
      ion === 'H2SiO3' ||
      ion === 'SO4'
    )
      continue
    s += mol(profile, ion) * IONS[ion].charge
  }
  return s
}

/**
 * Weak systems in the bath that are not modelled ions: the dosed acid's own
 * anion (lactate, citrate) and the card's boron. All amounts in mol/L.
 */
export interface WeakExtras {
  organic?: readonly { mol: number; pkas: readonly number[] }[]
  boronMol?: number
}

/**
 * Fractions of the n+1 forms of an n-protic acid at [H⁺] = h, from the fully
 * protonated form (index 0) to the fully deprotonated anion (index n).
 */
export function polyproticFractions(
  h: number,
  pkas: readonly number[],
): number[] {
  const n = pkas.length
  const terms: number[] = []
  let kprod = 1
  for (let i = 0; i <= n; i++) {
    if (i > 0) kprod *= 10 ** -pkas[i - 1]
    terms.push(h ** (n - i) * kprod)
  }
  const d = terms.reduce((a, b) => a + b, 0)
  return terms.map((t) => t / d)
}

/** Mean negative charge per mole of an n-protic acid's anion pool at [H⁺] = h. */
export function anionEquivalents(h: number, pkas: readonly number[]): number {
  return polyproticFractions(h, pkas).reduce((acc, f, i) => acc + i * f, 0)
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
  hso4: number
  so4: number
  /** Charge equivalents (mol/L) carried by the dosed acid's anion. */
  organicEq: number
  /** Borate B(OH)₄⁻ from the card's boron. */
  borate: number
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
export function speciate(
  profile: IonProfile,
  ph: number,
  extras: WeakExtras = {},
): Speciation {
  const h = 10 ** -ph
  const oh = 10 ** (ph - PKA.water)
  const cT = mol(profile, 'HCO3') + mol(profile, 'CO3')
  const siT = mol(profile, 'H2SiO3')
  const sT = mol(profile, 'SO4')
  const [c0, c1, c2] = diproticFractions(h, PKA.carbonic1, PKA.carbonic2)
  const [s0, s1, s2] = diproticFractions(h, PKA.silicic1, PKA.silicic2)
  const [b0, b1] = polyproticFractions(h, [PKA.bisulfate])
  let organicEq = 0
  for (const o of extras.organic ?? []) {
    organicEq += o.mol * anionEquivalents(h, o.pkas)
  }
  const borate =
    (extras.boronMol ?? 0) * polyproticFractions(h, [PKA.boric])[1]
  return {
    h,
    oh,
    h2co3: cT * c0,
    hco3: cT * c1,
    co3: cT * c2,
    h4sio4: siT * s0,
    hsio3: siT * s1,
    sio3: siT * s2,
    hso4: sT * b0,
    so4: sT * b1,
    organicEq,
    borate,
  }
}

/**
 * Proton-balance residual at a trial pH: (weak-acid anion equivalents + OH⁻
 * − H⁺) − strong-ion difference. Zero at the true pH; increases with pH.
 */
export function protonBalance(
  profile: IonProfile,
  ph: number,
  extras: WeakExtras = {},
): number {
  const s = speciate(profile, ph, extras)
  return (
    s.hco3 +
    2 * s.co3 +
    s.hsio3 +
    2 * s.sio3 +
    s.hso4 +
    2 * s.so4 +
    s.organicEq +
    s.borate +
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
export function estimateBathPh(
  profile: IonProfile,
  extras: WeakExtras = {},
): number {
  let lo = 0
  let hi = 14
  if (protonBalance(profile, lo, extras) >= 0) return lo
  if (protonBalance(profile, hi, extras) <= 0) return hi
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (protonBalance(profile, mid, extras) < 0) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Boron on the card (metaboric / boric acid lines), mol/L, for the proton balance. */
export function cardBoronMol(norm: NormalizedOnsen): number {
  let b = 0
  for (const n of norm.notReplicated) {
    if ((n.key === 'HBO2' || n.key === 'H3BO3') && n.mgPerL !== undefined) {
      b += n.mgPerL / EXTRA_SPECIES[n.key].molarMass / 1000
    }
  }
  return b
}

/** What a dose of an acid adds to the bath: modelled ions (mg/L) and extras. */
export interface AcidAddition {
  profile: IonProfile
  extras: WeakExtras
}

/** The bath with `mmolPerL` of the acid added to `profile` + `extras`. */
export function withAcid(
  profile: IonProfile,
  extras: WeakExtras,
  acidId: SaltId,
  mmolPerL: number,
): AcidAddition {
  const salt = SALTS[acidId]
  const out: IonProfile = { ...profile }
  for (const [ion, moles] of Object.entries(salt.stoichiometry) as [
    IonId,
    number,
  ][]) {
    out[ion] = (out[ion] ?? 0) + mmolPerL * moles * IONS[ion].molarMass
  }
  const organic = [...(extras.organic ?? [])]
  if (salt.acidAnion && mmolPerL > 0) {
    organic.push({ mol: mmolPerL / 1000, pkas: salt.acidAnion.pkas })
  }
  const merged: WeakExtras = { organic }
  if (extras.boronMol !== undefined) merged.boronMol = extras.boronMol
  return { profile: out, extras: merged }
}

/** Upper bound on any acid dose (mmol/L); hitting it means the card pH is unreachable. */
export const ACID_DOSE_CAP_MMOL_PER_L = 500

/**
 * The dose (mmol/L) of `acidId` that brings the bath to `targetPh`, by
 * bisection on the proton balance (pH falls monotonically with acid). Zero
 * when the bath is already at or below the target without acid; the cap when
 * even the cap cannot reach it.
 */
export function acidDoseForPh(
  profile: IonProfile,
  extras: WeakExtras,
  acidId: SaltId,
  targetPh: number,
): { mmolPerL: number; capped: boolean } {
  const phAt = (a: number): number => {
    const w = withAcid(profile, extras, acidId, a)
    return estimateBathPh(w.profile, w.extras)
  }
  if (phAt(0) <= targetPh) return { mmolPerL: 0, capped: false }
  let lo = 0
  let hi = ACID_DOSE_CAP_MMOL_PER_L
  if (phAt(hi) > targetPh) return { mmolPerL: hi, capped: true }
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (phAt(mid) > targetPh) lo = mid
    else hi = mid
  }
  return { mmolPerL: (lo + hi) / 2, capped: false }
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
  | 'gypsum'
  | 'calcite'
  | 'brucite'
  | 'portlandite'
  | 'silicate-hydrate'
  | 'amorphous-silica'

export interface PrecipitationWarning {
  mineral: PrecipitateMineral
  /** log10(IAP / Ksp) where a Ksp exists; omitted for the gel-forming check. */
  saturationIndex?: number
  message: string
}

const sign = (n: number): string => (n >= 0 ? '+' : '')

/**
 * What falls out of a result profile at its estimated pH: gypsum, calcite
 * (carbonate speciated at that pH), brucite, portlandite, calcium/magnesium
 * silicate hydrate and amorphous silica. Ionic saturation indices use Davies
 * activity coefficients at the bath's ionic strength, so a hard, salty bath
 * is not flagged just for being concentrated; the pH itself is still
 * estimated with activity = concentration.
 */
export function precipitationWarnings(
  profile: IonProfile,
  ph: number,
  bathTempC: number = BATH_TEMPERATURE_C,
  extras: WeakExtras = {},
): PrecipitationWarning[] {
  const out: PrecipitationWarning[] = []
  const s = speciate(profile, ph, extras)
  const mg = mol(profile, 'Mg')
  const ca = mol(profile, 'Ca')
  const so4 = mol(profile, 'SO4')
  const siT = mol(profile, 'H2SiO3')
  const I = ionicStrength(profile, extras)
  const lg1 = daviesLogGamma(1, I)
  const lg2 = daviesLogGamma(2, I)

  if (ca > 0 && so4 > 0) {
    const si = Math.log10(ca * so4) + 2 * lg2 - LOG_KSP_GYPSUM
    if (si >= 0) {
      out.push({
        mineral: 'gypsum',
        saturationIndex: si,
        message: `Gypsum CaSO₄ is at or above saturation (SI ${sign(si)}${si.toFixed(1)}, Davies-corrected at I = ${I.toFixed(3)} M): some calcium sulfate may not dissolve.`,
      })
    }
  }
  if (ca > 0 && s.co3 > 0) {
    const si = Math.log10(ca * s.co3) + 2 * lg2 - LOG_KSP_CALCITE
    if (si >= 0) {
      out.push({
        mineral: 'calcite',
        saturationIndex: si,
        message: `Calcite CaCO₃ is supersaturated at the estimated pH ${ph.toFixed(1)} (SI ${sign(si)}${si.toFixed(1)}, carbonate speciated at that pH, Davies-corrected at I = ${I.toFixed(3)} M): expect calcium carbonate haze or scale; a lower pH holds more of the carbonate as bicarbonate and keeps it dissolved.`,
      })
    }
  }
  if (mg > 0) {
    const si =
      Math.log10(mg * s.oh * s.oh) + lg2 + 2 * lg1 - LOG_KSP_HYDROXIDE.brucite
    if (si >= 0) {
      out.push({
        mineral: 'brucite',
        saturationIndex: si,
        message: `Brucite Mg(OH)₂ is supersaturated at the estimated pH ${ph.toFixed(1)} (SI ${sign(si)}${si.toFixed(1)}): the magnesium will drop out as a white cloud instead of staying dissolved.`,
      })
    }
  }
  if (ca > 0) {
    const si =
      Math.log10(ca * s.oh * s.oh) +
      lg2 +
      2 * lg1 -
      LOG_KSP_HYDROXIDE.portlandite
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
