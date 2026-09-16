// Bath chemistry the least-squares fit cannot see.
//
// The solver matches ion masses. It does not know that sodium metasilicate
// dissolves to 2 Na⁺ + silicate + 2 OH⁻, that a bicarbonate spring's pH is set
// by dissolved CO₂ no salt supplies, or that citrate binds calcium. This
// module closes those gaps for a bath at BATH_TEMPERATURE_C:
//
// 1. `hydroxideReleased` — meq/L of OH⁻ the dosed salts release (from each
//    salt's declared `netCharge`).
// 2. `speciate` / `protonBalance` / `estimateBathPh` — a full proton balance
//    over carbonate, silicate, sulfate/bisulfate, borate, water and the dosed
//    acid's own anion (lactate, citrate), with calcium / magnesium / sodium
//    complexation by citrate and lactate solved as a fixed point at each pH.
// 3. `acidDoseForPh` — the dose of any acid that lands the bath on a target
//    pH, by bisection.
// 4. `precipitationWarnings` — saturation checks at that pH on the FREE ions
//    for gypsum, calcite, brucite Mg(OH)₂, portlandite Ca(OH)₂, calcium /
//    magnesium silicate hydrate, and amorphous silica, with Davies activity
//    coefficients at the bath's ionic strength.
// 5. `phAfterDegassing` — where the pH drifts once the dissolved CO₂ has
//    left an open tub (hours in still water).
//
// Equilibrium constants are literature values evaluated at the bath
// temperature (40 °C), not 25 °C: the card's pH is a meter reading, so
// matching the number needs the constants of the water it is read in. The
// pH balance uses activity = concentration; the saturation indices apply
// Davies coefficients. Treat the pH as a guide to ±0.2, the precipitation
// flags as "this will visibly happen", not as an equilibrium model.

import {
  ATOMIC_WEIGHTS,
  IONS,
  ION_ORDER,
  OH_WEIGHT,
  SALTS,
} from '../chem/constants'
import type { IonId, SaltId } from '../chem/constants'
import type { IonProfile, SaltDose } from '../solver/types'
import { EXTRA_SPECIES } from './species'
import type { NormalizedOnsen } from './types'

/** Temperature the bath chemistry is evaluated at: a hot bath. */
export const BATH_TEMPERATURE_C = 40

/**
 * Acid dissociation constants (pKa) at the bath temperature, 40 °C. The 25 °C
 * values are in the comments; the shift matters most for water itself
 * (neutral pH is 6.77 at 40 °C) and for the alkaline checks.
 */
export const PKA = {
  /** H₂CO₃ ⇌ HCO₃⁻ + H⁺ (6.35 at 25 °C; Plummer & Busenberg 1982) */
  carbonic1: 6.3,
  /** HCO₃⁻ ⇌ CO₃²⁻ + H⁺ (10.33 at 25 °C) */
  carbonic2: 10.22,
  /** H₄SiO₄ ⇌ H₃SiO₄⁻ + H⁺ (9.84 at 25 °C; Sjöberg et al. 1985) */
  silicic1: 9.6,
  /** H₃SiO₄⁻ ⇌ H₂SiO₄²⁻ + H⁺ (13.2 at 25 °C) */
  silicic2: 12.9,
  /** H₂O ⇌ H⁺ + OH⁻ (14.00 at 25 °C) */
  water: 13.53,
  /** HSO₄⁻ ⇌ SO₄²⁻ + H⁺ (1.99 at 25 °C; only matters below pH ~3) */
  bisulfate: 2.1,
  /** B(OH)₃ + H₂O ⇌ B(OH)₄⁻ + H⁺ (9.24 at 25 °C) */
  boric: 9.08,
} as const

/** log10 Ksp at 40 °C of the hydroxides screened. */
export const LOG_KSP_HYDROXIDE = {
  /** Mg(OH)₂ (−11.25 at 25 °C) */
  brucite: -11.7,
  /** Ca(OH)₂ (−5.3 at 25 °C) */
  portlandite: -5.45,
} as const

/** log10 Ksp at 40 °C of calcite, CaCO₃ (−8.48 at 25 °C; Plummer & Busenberg). */
export const LOG_KSP_CALCITE = -8.58
/** log10 Ksp at 40 °C of gypsum, CaSO₄·2H₂O (−4.58 at 25 °C). */
export const LOG_KSP_GYPSUM = -4.61

/**
 * Metal–ligand stability constants, log10 K, at I ≈ 0.1 M (NIST 46 / Martell
 * & Smith). Citrate holds calcium and magnesium strongly; lactate weakly.
 * Temperature dependence over 25–40 °C is within the I-correction noise.
 */
export const LOG_K_COMPLEX = {
  /** Ca²⁺ + Cit³⁻ ⇌ CaCit⁻ */
  CaCit: 3.5,
  /** Mg²⁺ + Cit³⁻ ⇌ MgCit⁻ */
  MgCit: 3.4,
  /** Na⁺ + Cit³⁻ ⇌ NaCit²⁻ */
  NaCit: 0.8,
  /** Ca²⁺ + HCit²⁻ ⇌ CaHCit */
  CaHCit: 2.1,
  /** Mg²⁺ + HCit²⁻ ⇌ MgHCit */
  MgHCit: 1.8,
  /** Ca²⁺ + Lac⁻ ⇌ CaLac⁺ */
  CaLac: 1.1,
  /** Mg²⁺ + Lac⁻ ⇌ MgLac⁺ */
  MgLac: 0.9,
} as const

/**
 * Calcium / magnesium silicate hydrates have no single Ksp (they are
 * gel-like solid solutions), but they form readily once the water is alkaline
 * enough for silicate anions to exist alongside Ca²⁺ / Mg²⁺. Above this pH
 * with both present, expect a white gel.
 */
export const SILICATE_HYDRATE_PH = 10

/** Debye–Hückel A parameter for the Davies equation at 40 °C (0.51 at 25 °C). */
export const DAVIES_A = 0.524

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
 * own OH⁻ / H⁺ — which is what fixes the pH. Calcium and magnesium count at
 * their full charge here whether free or complexed; a complexed ligand is
 * counted on the anion side at the charge it carries inside the complex.
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

export type Ligand = 'citrate' | 'lactate' | 'other'

export interface OrganicLigand {
  /** Total mol/L of the ligand (all protonation states and complexes). */
  mol: number
  pkas: readonly number[]
  ligand: Ligand
}

/**
 * Weak systems in the bath that are not modelled ions: the dosed acid's own
 * anion (lactate, citrate) and the card's boron. All amounts in mol/L.
 */
export interface WeakExtras {
  organic?: readonly OrganicLigand[]
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
  /** Charge equivalents (mol/L) carried by the dosed acid's anion, free or complexed. */
  organicEq: number
  /** Borate B(OH)₄⁻ from the card's boron. */
  borate: number
  /** Calcium / magnesium not bound by the acid's anion (= total when no organic acid). */
  caFree: number
  mgFree: number
  caBound: number
  mgBound: number
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

const K = {
  CaCit: 10 ** LOG_K_COMPLEX.CaCit,
  MgCit: 10 ** LOG_K_COMPLEX.MgCit,
  NaCit: 10 ** LOG_K_COMPLEX.NaCit,
  CaHCit: 10 ** LOG_K_COMPLEX.CaHCit,
  MgHCit: 10 ** LOG_K_COMPLEX.MgHCit,
  CaLac: 10 ** LOG_K_COMPLEX.CaLac,
  MgLac: 10 ** LOG_K_COMPLEX.MgLac,
}

/**
 * Distribute the profile's total carbonate, silica, sulfate, boron and the
 * dosed acid's anion over their acid / base forms at the given pH, and solve
 * the calcium / magnesium / sodium complexation by citrate and lactate as a
 * fixed point (activity = concentration).
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
  const borate =
    (extras.boronMol ?? 0) * polyproticFractions(h, [PKA.boric])[1]

  const caT = mol(profile, 'Ca')
  const mgT = mol(profile, 'Mg')
  const na = mol(profile, 'Na')
  let caF = caT
  let mgF = mgT
  let organicEq = 0

  let citT = 0
  let citPkas: readonly number[] = []
  let lacT = 0
  let lacPkas: readonly number[] = []
  for (const o of extras.organic ?? []) {
    if (o.ligand === 'citrate') {
      citT += o.mol
      citPkas = o.pkas
    } else if (o.ligand === 'lactate') {
      lacT += o.mol
      lacPkas = o.pkas
    } else organicEq += o.mol * anionEquivalents(h, o.pkas)
  }

  if (citT > 0 || lacT > 0) {
    const fc = citT > 0 ? polyproticFractions(h, citPkas) : [1, 0, 0, 0]
    const fl = lacT > 0 ? polyproticFractions(h, lacPkas) : [1, 0]
    let cit3 = 0
    let hcit = 0
    let lacF = 0
    for (let i = 0; i < 200; i++) {
      if (citT > 0) {
        const d =
          1 / fc[3] +
          K.CaCit * caF +
          K.MgCit * mgF +
          K.NaCit * na +
          (K.CaHCit * caF + K.MgHCit * mgF) * (fc[2] / fc[3])
        cit3 = citT / d
        hcit = (cit3 * fc[2]) / fc[3]
      }
      if (lacT > 0) {
        lacF = lacT / (1 / fl[1] + K.CaLac * caF + K.MgLac * mgF)
      }
      const caNew = caT / (1 + K.CaCit * cit3 + K.CaHCit * hcit + K.CaLac * lacF)
      const mgNew = mgT / (1 + K.MgCit * cit3 + K.MgHCit * hcit + K.MgLac * lacF)
      const done =
        Math.abs(caNew - caF) < 1e-13 && Math.abs(mgNew - mgF) < 1e-13
      caF = caNew
      mgF = mgNew
      if (done) break
    }
    const caCit = K.CaCit * caF * cit3
    const mgCit = K.MgCit * mgF * cit3
    const naCit = K.NaCit * na * cit3
    const caHCit = K.CaHCit * caF * hcit
    const mgHCit = K.MgHCit * mgF * hcit
    const caLac = K.CaLac * caF * lacF
    const mgLac = K.MgLac * mgF * lacF
    if (citT > 0) {
      const citU = cit3 / fc[3] // uncomplexed citrate, all protonation states
      organicEq +=
        citU * (fc[1] + 2 * fc[2] + 3 * fc[3]) +
        3 * (caCit + mgCit + naCit) +
        2 * (caHCit + mgHCit)
    }
    if (lacT > 0) {
      const lacU = lacF / fl[1]
      organicEq += lacU * fl[1] + caLac + mgLac
    }
  }

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
    caFree: caF,
    mgFree: mgF,
    caBound: caT - caF,
    mgBound: mgT - mgF,
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
 * Pure water returns the neutral point at the bath temperature (6.77 at
 * 40 °C). Clamped to 0–14.
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

/**
 * Where the pH drifts once the dissolved CO₂ has left an open tub: strip the
 * carbonic acid, re-balance, repeat until nothing volatile is left. In a
 * still bath this takes hours (gas-transfer velocity ~2 cm/h over ~25 cm of
 * water); jets or stirring make it much faster.
 */
export function phAfterDegassing(
  profile: IonProfile,
  extras: WeakExtras = {},
): number {
  let p: IonProfile = { ...profile }
  let ph = estimateBathPh(p, extras)
  for (let i = 0; i < 8; i++) {
    const s = speciate(p, ph, extras)
    if (s.h2co3 < 1e-9) break
    const dic = s.hco3 + s.co3
    p = { ...p, HCO3: dic * 1000 * IONS.HCO3.molarMass, CO3: 0 }
    ph = estimateBathPh(p, extras)
  }
  return ph
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

function ligandOf(key: string): Ligand {
  return key === 'citrate' || key === 'lactate' ? key : 'other'
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
    organic.push({
      mol: mmolPerL / 1000,
      pkas: salt.acidAnion.pkas,
      ligand: ligandOf(salt.acidAnion.key),
    })
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
 * The free acidity the card reports, for reference. Analysis sheets print
 * the hydrogen-ion (H⁺) and hydroxide (OH⁻) rows explicitly; those win.
 * Failing that the card pH gives it (10⁻ᵖᴴ − 10ᵖᴴ⁻ᵖᴷʷ, only material outside
 * pH 5–9). With neither, zero.
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
 * ionic strength I (mol/L), at the bath temperature. Good to I ≈ 0.5, which
 * covers any bath.
 */
export function daviesLogGamma(z: number, ionicStrengthMolar: number): number {
  const sq = Math.sqrt(ionicStrengthMolar)
  return -DAVIES_A * z * z * (sq / (1 + sq) - 0.3 * ionicStrengthMolar)
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
 * silicate hydrate and amorphous silica. Ionic saturation indices use the
 * FREE calcium and magnesium (what citrate or lactate has not bound) and
 * Davies activity coefficients at the bath's ionic strength, so a hard,
 * salty bath is not flagged just for being concentrated; the pH itself is
 * still estimated with activity = concentration.
 */
export function precipitationWarnings(
  profile: IonProfile,
  ph: number,
  bathTempC: number = BATH_TEMPERATURE_C,
  extras: WeakExtras = {},
): PrecipitationWarning[] {
  const out: PrecipitationWarning[] = []
  const s = speciate(profile, ph, extras)
  const mg = s.mgFree
  const ca = s.caFree
  const so4 = s.so4
  const siT = mol(profile, 'H2SiO3')
  const I = ionicStrength(profile, extras)
  const lg1 = daviesLogGamma(1, I)
  const lg2 = daviesLogGamma(2, I)
  const bound =
    s.caBound > 0
      ? `, free Ca after ${((s.caBound / (s.caBound + s.caFree)) * 100).toFixed(0)}% is bound by the acid's anion`
      : ''

  if (ca > 0 && so4 > 0) {
    const si = Math.log10(ca * so4) + 2 * lg2 - LOG_KSP_GYPSUM
    if (si >= 0) {
      out.push({
        mineral: 'gypsum',
        saturationIndex: si,
        message: `Gypsum CaSO₄ is at or above saturation (SI ${sign(si)}${si.toFixed(1)}, Davies-corrected at I = ${I.toFixed(3)} M${bound}): some calcium sulfate may not dissolve.`,
      })
    }
  }
  if (ca > 0 && s.co3 > 0) {
    const si = Math.log10(ca * s.co3) + 2 * lg2 - LOG_KSP_CALCITE
    if (si >= 0) {
      const mild = si < 0.3
      out.push({
        mineral: 'calcite',
        saturationIndex: si,
        message: mild
          ? `Calcite CaCO₃ is right at saturation at the estimated pH ${ph.toFixed(1)} (SI ${sign(si)}${si.toFixed(1)}, carbonate speciated at that pH, Davies-corrected at I = ${I.toFixed(3)} M${bound}): stable while the dissolved CO₂ stays in; a faint film or scale forms as the CO₂ leaves and the pH climbs — the same travertine the spring itself lays down.`
          : `Calcite CaCO₃ is supersaturated at the estimated pH ${ph.toFixed(1)} (SI ${sign(si)}${si.toFixed(1)}, carbonate speciated at that pH, Davies-corrected at I = ${I.toFixed(3)} M${bound}): expect calcium carbonate haze or scale; a lower pH holds more of the carbonate as bicarbonate and keeps it dissolved.`,
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
