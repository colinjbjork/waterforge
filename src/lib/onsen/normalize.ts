// Normalise validated onsen input to what the solver consumes.
//
// - mg/kg is treated as mg/L (dilute-solution approximation: density ≈ 1).
// - mval converts per ion: mg = mval × molarMass ÷ |charge|. Undissociated
//   components are always mass (mg), whatever the card's unit column says.
// - Fitted ions (the engine's ion ids) become the target profile; everything
//   else — excluded sulfur/iron species, hydroxide, and any component with no
//   ingredient — is carried on the "not replicated" list with its value.
// - `bath_volume` defaults to 250 L; `source_water` defaults to distilled.

import { IONS, ION_ORDER } from '../chem/constants'
import type { IonProfile } from '../solver/types'
import { EXTRA_SPECIES, isFittedKey, reasonFor } from './species'
import { DEFAULT_BATH, ONSEN_GROUPS } from './types'
import type {
  NormalizedOnsen,
  NotReplicated,
  OnsenGroup,
  OnsenInput,
  OnsenUnits,
} from './types'

/** mg = mval × M ÷ |z|. Throws for charge-neutral species (validation catches these first). */
export function mvalToMg(
  mval: number,
  molarMass: number,
  charge: number,
): number {
  const z = Math.abs(charge)
  if (z === 0) {
    throw new Error('mval conversion needs a charged species')
  }
  return (mval * molarMass) / z
}

/**
 * Convert one card figure to mg/L. Returns `undefined` when the figure is in
 * mval and the species is unknown (no molar mass to convert with).
 */
export function toMgPerL(
  key: string,
  value: number,
  units: OnsenUnits,
  group: OnsenGroup,
): number | undefined {
  // Undissociated components are always reported by mass.
  if (units !== 'mval' || group === 'undissociated') return value
  if (isFittedKey(key)) {
    const ion = IONS[key]
    return ion.charge === 0 ? value : mvalToMg(value, ion.molarMass, ion.charge)
  }
  const extra = EXTRA_SPECIES[key]
  if (!extra) return undefined
  return extra.charge === 0
    ? value
    : mvalToMg(value, extra.molarMass, extra.charge)
}

/** Normalise a validated card. */
export function normalizeOnsen(input: OnsenInput): NormalizedOnsen {
  const target: IonProfile = {}
  const notReplicated: NotReplicated[] = []

  for (const group of ONSEN_GROUPS) {
    const entries = input[group] ?? {}
    for (const [key, value] of Object.entries(entries)) {
      const mgPerL = toMgPerL(key, value, input.units, group)
      const isMassOnly = group === 'undissociated'
      const unit = isMassOnly ? 'mg' : input.units

      // Hydroxide is a fitted-looking key but deliberately reference-only.
      if (isFittedKey(key)) {
        if (mgPerL !== undefined && mgPerL > 0) {
          target[key] = (target[key] ?? 0) + mgPerL
        }
        continue
      }

      const extra = EXTRA_SPECIES[key]
      const entry: NotReplicated = {
        key,
        group,
        reported: value,
        unit,
        reason: reasonFor(key),
      }
      if (mgPerL !== undefined) entry.mgPerL = mgPerL
      notReplicated.push(entry)
    }
  }

  // Source water: mg/L, fitted ions only; anything else is ignored but named.
  const source: IonProfile = {}
  const sourceWaterIgnored: string[] = []
  for (const [key, value] of Object.entries(input.source_water ?? {})) {
    if (isFittedKey(key)) {
      if (value > 0) source[key] = value
    } else {
      sourceWaterIgnored.push(key)
    }
  }

  const batch = input.bath_volume
    ? { volume: input.bath_volume.value, unit: input.bath_volume.unit }
    : { ...DEFAULT_BATH }

  const out: NormalizedOnsen = {
    name: input.name?.trim() || 'Untitled onsen analysis',
    units: input.units,
    target,
    source,
    notReplicated,
    sourceWaterIgnored,
    batch,
    notes: [...(input.notes ?? [])],
  }
  if (input.ph !== undefined) out.ph = input.ph
  if (input.temperature_c !== undefined) out.temperatureC = input.temperature_c
  if (input.spring_type !== undefined) out.springType = input.spring_type
  return out
}

/** Fitted ion ids present (non-zero) in a profile, in canonical order. */
export function presentIons(profile: IonProfile) {
  return ION_ORDER.filter((ion) => (profile[ion] ?? 0) !== 0)
}
