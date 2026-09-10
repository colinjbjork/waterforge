// Species the onsen module knows about beyond the fitted ions.
//
// Two jobs: (1) convert an mval figure to mg/L (needs molar mass and |charge|)
// for components the engine does not fit, so the "not replicated" list can
// still show mg/L; (2) classify why a component is not fitted. Molar masses of
// group species are summed from atomic weights; a few extra elements the
// engine's table does not carry are quoted here as standard atomic weights.

import { ATOMIC_WEIGHTS, ION_ORDER, OH_WEIGHT } from '../chem/constants'
import type { IonId } from '../chem/constants'
import type { NotReplicatedReason } from './types'

/** Standard atomic weights (g/mol) for elements the engine table lacks. */
const EXTRA_ATOMIC_WEIGHTS = {
  Fe: 55.845,
  B: 10.81,
  Li: 6.94,
  Sr: 87.62,
  Ba: 137.327,
  Br: 79.904,
  I: 126.904,
  F: 18.998,
  N: 14.007,
  Al: 26.982,
  Mn: 54.938,
  P: 30.974,
  Zn: 65.38,
  Cu: 63.546,
  As: 74.922,
} as const

const W = { ...ATOMIC_WEIGHTS, ...EXTRA_ATOMIC_WEIGHTS }

export interface ExtraSpecies {
  /** Molar mass, g/mol. */
  molarMass: number
  /** Signed charge; 0 for undissociated components. */
  charge: number
  label: string
  reason: NotReplicatedReason
}

/**
 * Components that may appear on a card but are never fit targets. Reduced
 * sulfur and iron are excluded by policy (no ingredient is ever suggested for
 * them); hydroxide is reference-only; everything else simply has no ingredient.
 */
export const EXTRA_SPECIES: Record<string, ExtraSpecies> = {
  OH: {
    molarMass: OH_WEIGHT,
    charge: -1,
    label: 'hydroxide (OH⁻)',
    reason: 'reference-only',
  },
  // --- excluded: reduced sulfur -------------------------------------------
  HS: {
    molarMass: W.H + W.S,
    charge: -1,
    label: 'hydrosulfide (HS⁻)',
    reason: 'excluded-sulfur',
  },
  S2O3: {
    molarMass: 2 * W.S + 3 * W.O,
    charge: -2,
    label: 'thiosulfate (S₂O₃²⁻)',
    reason: 'excluded-sulfur',
  },
  H2S: {
    molarMass: 2 * W.H + W.S,
    charge: 0,
    label: 'free hydrogen sulfide (H₂S)',
    reason: 'excluded-sulfur',
  },
  S: {
    molarMass: W.S,
    charge: 0,
    label: 'total sulfur (S)',
    reason: 'excluded-sulfur',
  },
  // --- excluded: iron --------------------------------------------------------
  Fe2: {
    molarMass: W.Fe,
    charge: +2,
    label: 'iron(II) (Fe²⁺)',
    reason: 'excluded-iron',
  },
  Fe3: {
    molarMass: W.Fe,
    charge: +3,
    label: 'iron(III) (Fe³⁺)',
    reason: 'excluded-iron',
  },
  Fe: {
    molarMass: W.Fe,
    charge: 0,
    label: 'total iron (Fe)',
    reason: 'excluded-iron',
  },
  // Onsen Oni's code for the 総鉄 (total iron) row.
  FeTotal: {
    molarMass: W.Fe,
    charge: 0,
    label: 'total iron (Fe)',
    reason: 'excluded-iron',
  },
  // --- reference only ------------------------------------------------------
  H: {
    molarMass: W.H,
    charge: +1,
    label: 'hydrogen ion (H⁺, acidity)',
    reason: 'reference-only',
  },
  // --- no ingredient in the palette -----------------------------------------
  HBO2: {
    molarMass: W.H + W.B + 2 * W.O,
    charge: 0,
    label: 'metaboric acid (HBO₂)',
    reason: 'no-ingredient',
  },
  H3BO3: {
    molarMass: 3 * W.H + W.B + 3 * W.O,
    charge: 0,
    label: 'boric acid (H₃BO₃)',
    reason: 'no-ingredient',
  },
  CO2: {
    molarMass: W.C + 2 * W.O,
    charge: 0,
    label: 'free carbon dioxide (CO₂)',
    reason: 'no-ingredient',
  },
  Li: {
    molarMass: W.Li,
    charge: +1,
    label: 'lithium (Li⁺)',
    reason: 'no-ingredient',
  },
  Sr: {
    molarMass: W.Sr,
    charge: +2,
    label: 'strontium (Sr²⁺)',
    reason: 'no-ingredient',
  },
  Ba: {
    molarMass: W.Ba,
    charge: +2,
    label: 'barium (Ba²⁺)',
    reason: 'no-ingredient',
  },
  Al: {
    molarMass: W.Al,
    charge: +3,
    label: 'aluminium (Al³⁺)',
    reason: 'no-ingredient',
  },
  Mn: {
    molarMass: W.Mn,
    charge: +2,
    label: 'manganese (Mn²⁺)',
    reason: 'no-ingredient',
  },
  Zn: {
    molarMass: W.Zn,
    charge: +2,
    label: 'zinc (Zn²⁺)',
    reason: 'no-ingredient',
  },
  Cu: {
    molarMass: W.Cu,
    charge: +2,
    label: 'copper (Cu²⁺)',
    reason: 'no-ingredient',
  },
  NH4: {
    molarMass: W.N + 4 * W.H,
    charge: +1,
    label: 'ammonium (NH₄⁺)',
    reason: 'no-ingredient',
  },
  Br: {
    molarMass: W.Br,
    charge: -1,
    label: 'bromide (Br⁻)',
    reason: 'no-ingredient',
  },
  I: {
    molarMass: W.I,
    charge: -1,
    label: 'iodide (I⁻)',
    reason: 'no-ingredient',
  },
  F: {
    molarMass: W.F,
    charge: -1,
    label: 'fluoride (F⁻)',
    reason: 'no-ingredient',
  },
  NO3: {
    molarMass: W.N + 3 * W.O,
    charge: -1,
    label: 'nitrate (NO₃⁻)',
    reason: 'no-ingredient',
  },
  NO2: {
    molarMass: W.N + 2 * W.O,
    charge: -1,
    label: 'nitrite (NO₂⁻)',
    reason: 'no-ingredient',
  },
  HPO4: {
    molarMass: W.H + W.P + 4 * W.O,
    charge: -2,
    label: 'hydrogen phosphate (HPO₄²⁻)',
    reason: 'no-ingredient',
  },
  H2PO4: {
    molarMass: 2 * W.H + W.P + 4 * W.O,
    charge: -1,
    label: 'dihydrogen phosphate (H₂PO₄⁻)',
    reason: 'no-ingredient',
  },
  HAsO2: {
    molarMass: W.H + W.As + 2 * W.O,
    charge: 0,
    label: 'metaarsenious acid (HAsO₂)',
    reason: 'no-ingredient',
  },
  HSO4: {
    molarMass: W.H + W.S + 4 * W.O,
    charge: -1,
    label: 'hydrogen sulfate (HSO₄⁻)',
    reason: 'no-ingredient',
  },
  As: {
    molarMass: W.As,
    charge: 0,
    label: 'arsenic, total (As)',
    reason: 'no-ingredient',
  },
  CuTrace: {
    molarMass: W.Cu,
    charge: +2,
    label: 'copper, trace (Cu)',
    reason: 'no-ingredient',
  },
  Cd: {
    molarMass: 112.414,
    charge: +2,
    label: 'cadmium (Cd²⁺)',
    reason: 'no-ingredient',
  },
  Hg: {
    molarMass: 200.592,
    charge: +2,
    label: 'mercury (Hg)',
    reason: 'no-ingredient',
  },
  Pb: {
    molarMass: 207.2,
    charge: +2,
    label: 'lead (Pb²⁺)',
    reason: 'no-ingredient',
  },
}

/**
 * Why a non-fitted key is not replicated. Known species answer from the
 * table; any unknown key that starts with `Fe` is still iron and any that
 * starts with `S` followed by a digit or lower-case letter is a sulfur
 * species — both excluded, so a new alias on a card can never slip an iron
 * or sulfur ingredient past the policy.
 */
export function reasonFor(key: string): NotReplicatedReason {
  const known = EXTRA_SPECIES[key]
  if (known) return known.reason
  if (/^Fe/i.test(key)) return 'excluded-iron'
  if (
    /^(HS|H2S|S2O3|S)(?![a-z])/i.test(key) &&
    !/^(SO4|Sr|Si|Sb|Se|Sn)/.test(key)
  ) {
    return 'excluded-sulfur'
  }
  return 'no-ingredient'
}

/** Keys the solver fits (the engine's ion ids). */
export const FITTED_KEYS = new Set<string>(ION_ORDER)

export function isFittedKey(key: string): key is IonId {
  return FITTED_KEYS.has(key)
}

/** Keys excluded by policy: never fitted, never an ingredient. */
export const EXCLUDED_KEYS: readonly string[] = Object.entries(EXTRA_SPECIES)
  .filter(
    ([, s]) => s.reason === 'excluded-sulfur' || s.reason === 'excluded-iron',
  )
  .map(([k]) => k)

/** Human label for any key the module knows; falls back to the key itself. */
export function speciesLabel(key: string): string {
  const extra = EXTRA_SPECIES[key]
  if (extra) return extra.label
  const ION_LABELS: Record<IonId, string> = {
    Ca: 'calcium (Ca²⁺)',
    Mg: 'magnesium (Mg²⁺)',
    Na: 'sodium (Na⁺)',
    K: 'potassium (K⁺)',
    HCO3: 'bicarbonate (HCO₃⁻)',
    SO4: 'sulfate (SO₄²⁻)',
    Cl: 'chloride (Cl⁻)',
    CO3: 'carbonate (CO₃²⁻)',
    H2SiO3: 'metasilicic acid (H₂SiO₃)',
  }
  return isFittedKey(key) ? ION_LABELS[key] : key
}
