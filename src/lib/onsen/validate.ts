// Validation for onsen analysis input, in the same style as
// `profiles/validate.ts`: pure TypeScript, no runtime dependency, every
// problem collected into a typed error list rather than thrown.

import { IONS } from '../chem/constants'
import { EXTRA_SPECIES, isFittedKey } from './species'
import { ONSEN_GROUPS, ONSEN_UNITS } from './types'
import type { OnsenInput } from './types'

export interface OnsenValidationError {
  /** Dot-separated path to the offending field (e.g. `'cations.Na'`). */
  path: string
  message: string
}

export interface OnsenValidationOk {
  ok: true
  value: OnsenInput
}

export interface OnsenValidationFail {
  ok: false
  errors: OnsenValidationError[]
}

export type OnsenValidationResult = OnsenValidationOk | OnsenValidationFail

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function addError(
  errors: OnsenValidationError[],
  path: string,
  message: string,
): void {
  errors.push({ path, message })
}

const UNIT_VALUES = new Set<string>(ONSEN_UNITS)

/** Signed charge of a key the module knows, or undefined for unknown keys. */
function chargeOf(key: string): number | undefined {
  if (isFittedKey(key)) return IONS[key].charge
  return EXTRA_SPECIES[key]?.charge
}

/**
 * Validate a component group: a plain object whose values are finite,
 * non-negative numbers. In `mval` mode a charge-neutral species cannot be
 * expressed in equivalents, so it must live under `undissociated` (always mg).
 */
function validateGroup(
  candidate: unknown,
  path: string,
  units: string | undefined,
  errors: OnsenValidationError[],
  seen: Map<string, string>,
): void {
  if (candidate === undefined) return
  if (!isPlainObject(candidate)) {
    addError(errors, path, 'must be a plain object of { key: number }')
    return
  }
  for (const [key, v] of Object.entries(candidate)) {
    const p = `${path}.${key}`
    if (typeof v !== 'number' || !isFinite(v)) {
      addError(errors, p, 'must be a finite number')
      continue
    }
    if (v < 0) {
      addError(errors, p, 'must be >= 0 (concentrations are non-negative)')
    }
    if (path !== 'source_water') {
      const prior = seen.get(key)
      if (prior !== undefined) {
        addError(
          errors,
          p,
          `duplicate component — already given under ${prior}`,
        )
      } else {
        seen.set(key, path)
      }
      if (units === 'mval' && path !== 'undissociated' && chargeOf(key) === 0) {
        addError(
          errors,
          p,
          'is charge-neutral and cannot be given in mval — list it under "undissociated" (always mg)',
        )
      }
    }
  }
}

/**
 * Validate an `unknown` value as onsen analysis input.
 *
 * Rejects negative values, unknown `units`, non-numeric concentrations, a
 * non-positive or wrongly-united `bath_volume`, and a card with no components
 * at all. Unknown component KEYS are accepted (they are reported as "not
 * replicated"); unknown top-level fields are rejected so typos surface.
 */
export function validateOnsenInput(raw: unknown): OnsenValidationResult {
  const errors: OnsenValidationError[] = []

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [{ path: '', message: 'Onsen input must be a plain object' }],
    }
  }

  const KNOWN_FIELDS = new Set([
    'name',
    'units',
    'ph',
    'temperature_c',
    'spring_type',
    'cations',
    'anions',
    'undissociated',
    'bath_volume',
    'source_water',
    'notes',
  ])
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) addError(errors, key, `unknown field '${key}'`)
  }

  // --- units (required) ---
  const units = raw['units']
  if (typeof units !== 'string' || !UNIT_VALUES.has(units)) {
    addError(errors, 'units', `must be one of: ${ONSEN_UNITS.join(', ')}`)
  }

  // --- optional reference fields ---
  for (const field of ['name', 'spring_type'] as const) {
    const v = raw[field]
    if (v !== undefined && typeof v !== 'string') {
      addError(errors, field, 'must be a string when present')
    }
  }
  const ph = raw['ph']
  if (ph !== undefined) {
    if (typeof ph !== 'number' || !isFinite(ph)) {
      addError(errors, 'ph', 'must be a finite number when present')
    } else if (ph < 0 || ph > 14) {
      addError(errors, 'ph', 'must be between 0 and 14 when present')
    }
  }
  const temp = raw['temperature_c']
  if (temp !== undefined && (typeof temp !== 'number' || !isFinite(temp))) {
    addError(errors, 'temperature_c', 'must be a finite number when present')
  }

  // --- component groups ---
  const seen = new Map<string, string>()
  const unitStr = typeof units === 'string' ? units : undefined
  for (const group of ONSEN_GROUPS) {
    validateGroup(raw[group], group, unitStr, errors, seen)
  }
  if (seen.size === 0) {
    addError(
      errors,
      'cations',
      'the card has no components — give at least one of cations / anions / undissociated',
    )
  }

  // --- source water (always mg/L) ---
  validateGroup(raw['source_water'], 'source_water', 'mg/L', errors, new Map())

  // --- notes (free text, echoed only) ---
  const notes = raw['notes']
  if (notes !== undefined) {
    if (!Array.isArray(notes) || notes.some((n) => typeof n !== 'string')) {
      addError(errors, 'notes', 'must be an array of strings when present')
    }
  }

  // --- bath volume ---
  const bath = raw['bath_volume']
  if (bath !== undefined) {
    if (!isPlainObject(bath)) {
      addError(errors, 'bath_volume', 'must be { value, unit } when present')
    } else {
      const value = bath['value']
      if (typeof value !== 'number' || !isFinite(value) || value <= 0) {
        addError(
          errors,
          'bath_volume.value',
          'must be a positive finite number',
        )
      }
      const unit = bath['unit']
      if (unit !== 'L' && unit !== 'gal') {
        addError(errors, 'bath_volume.unit', 'must be "L" or "gal"')
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: raw as unknown as OnsenInput }
}
