// Onsen (Japanese hot spring) analysis input model.
//
// A 温泉分析書 lists cations, anions and undissociated components, usually in
// mg/kg with a parallel mval column. This module accepts that structure as
// JSON, normalises it to the engine's mg/L ion profile, and keeps every
// component the engine cannot replicate on a "not replicated" list so nothing
// silently disappears. See docs/onsen-input.md for the schema.

import type { IonId } from '../chem/constants'
import type { BatchOptions, IonProfile, VolumeUnit } from '../solver/types'

/** Concentration units an analysis card may use. */
export type OnsenUnits = 'mg/kg' | 'mg/L' | 'mval'
export const ONSEN_UNITS: readonly OnsenUnits[] = ['mg/kg', 'mg/L', 'mval']

/** The three component groups on an analysis card. */
export type OnsenGroup = 'cations' | 'anions' | 'undissociated'
export const ONSEN_GROUPS: readonly OnsenGroup[] = [
  'cations',
  'anions',
  'undissociated',
]

export interface OnsenBathVolume {
  value: number
  unit: VolumeUnit
}

/** The canonical JSON the CLI accepts (validated by `validateOnsenInput`). */
export interface OnsenInput {
  name?: string
  units: OnsenUnits
  ph?: number
  temperature_c?: number
  spring_type?: string
  cations?: Record<string, number>
  anions?: Record<string, number>
  undissociated?: Record<string, number>
  bath_volume?: OnsenBathVolume
  /** Starting-water ions in mg/L (always mg/L, whatever `units` says). */
  source_water?: Record<string, number>
  /**
   * Free-text provenance / caveats to print under Warnings (e.g. the Onsen
   * Oni extraction confidence). Never interpreted, only echoed.
   */
  notes?: string[]
}

/** Why a component on the card is not fitted by the solver. */
export type NotReplicatedReason =
  /** Reduced-sulfur species: no sulfur ingredient is ever suggested. */
  | 'excluded-sulfur'
  /** Iron species: no iron ingredient is ever suggested. */
  | 'excluded-iron'
  /** Accepted and reported (hydroxide) but deliberately not a fit target. */
  | 'reference-only'
  /** No ingredient in the palette supplies it. */
  | 'no-ingredient'

export interface NotReplicated {
  key: string
  group: OnsenGroup
  /** The value exactly as given on the card. */
  reported: number
  /** Unit of `reported` (`'mg'` for undissociated components, which are always mass). */
  unit: OnsenUnits | 'mg'
  /** mg/L equivalent, when the species is known well enough to convert. */
  mgPerL?: number
  reason: NotReplicatedReason
}

/** Default bath size when the input does not say. */
export const DEFAULT_BATH: Required<BatchOptions> = { volume: 250, unit: 'L' }

/** The validated card, normalised to what the solver consumes. */
export interface NormalizedOnsen {
  name: string
  units: OnsenUnits
  ph?: number
  temperatureC?: number
  springType?: string
  /** Fit targets in mg/L — only ions the engine models. */
  target: IonProfile
  /** Starting water in mg/L (empty = distilled). */
  source: IonProfile
  /** Every card component that is not a fit target, with its value. */
  notReplicated: NotReplicated[]
  /** `source_water` keys the engine does not model (ignored, but reported). */
  sourceWaterIgnored: string[]
  batch: Required<BatchOptions>
  /** Caveats carried through from the input, echoed under Warnings. */
  notes: string[]
}

/** Ion ids the solver actually fits — a re-export for callers of this module. */
export type FittedIonId = IonId
