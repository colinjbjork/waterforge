// Deterministic sequential reference algorithm ("golden oracle").
//
// This is the auditable, spreadsheet-style assignment that the source method
// (Lersch / Khymos) uses: walk the salts in a fixed priority order, and for each
// salt dose exactly enough to close the remaining deficit on its DRIVER ion,
// then subtract everything that salt contributes from the running deficits.
// It is pure and fully deterministic — given the same inputs it always returns
// the same doses — which makes it a trustworthy oracle to check the production
// NNLS solver against. See the solver notes under `docs/`.
//
// Each salt's driver ion is the ion it is primarily chosen to supply. For a
// fully-determined palette (each driver ion supplied by exactly one salt, in an
// order where each salt's driver is not already over-satisfied by earlier
// salts), the greedy assignment reproduces the target exactly.

import { ION_ORDER, type IonId, type SaltId } from '../chem'
import { contribution } from './matrix'
import type { IonProfile, SaltDose } from './types'

/** The ion each salt is primarily dosed to hit, in priority order. */
const DRIVER_ION: Record<SaltId, IonId> = {
  // Gypsum and epsom drive the divalent cations via the sulfate pathway.
  gypsum: 'Ca',
  epsom: 'Mg',
  // Chloride salts drive their cation; chloride comes along as the counter-ion.
  calciumChloride: 'Ca',
  calciumChlorideAnhydrous: 'Ca',
  magnesiumChloride: 'Mg',
  // Monovalent salts drive sodium / potassium.
  tableSalt: 'Na',
  bakingSoda: 'HCO3',
  chalk: 'HCO3',
  potassiumBicarbonate: 'K',
  // Onsen fork salts: each drives the ion it uniquely (or primarily) supplies.
  sodiumCarbonate: 'CO3',
  sodiumCarbonateDecahydrate: 'CO3',
  sodiumSulfateDecahydrate: 'SO4',
  sodiumSulfate: 'SO4',
  potassiumChloride: 'K',
  sodiumMetasilicate: 'H2SiO3',
  // Bath-only acid (not in SALT_ORDER); listed so the record stays total.
  hydrochloricAcid: 'Cl',
}

/**
 * Solve for salt doses (g/L) using the fixed-priority greedy reference method.
 *
 * @param target  desired ion profile (mg/L).
 * @param source  ion profile already present in the source water (mg/L).
 * @param salts   palette to dose from, processed in this priority order.
 */
export function sequentialOracle(
  target: IonProfile,
  source: IonProfile,
  salts: readonly SaltId[],
): SaltDose {
  // Remaining deficit per ion: how much more (mg/L) we still need to add.
  const deficit: Record<IonId, number> = {} as Record<IonId, number>
  for (const ion of ION_ORDER) {
    deficit[ion] = (target[ion] ?? 0) - (source[ion] ?? 0)
  }

  const dose: SaltDose = {}
  for (const saltId of salts) {
    const driver = DRIVER_ION[saltId]
    const perGram = contribution(saltId, driver)
    if (perGram <= 0) continue

    // Dose to close the driver-ion deficit, never going negative.
    const grams = Math.max(0, deficit[driver] / perGram)
    if (grams === 0) continue
    dose[saltId] = grams

    // Subtract this salt's full contribution from every ion's deficit.
    for (const ion of ION_ORDER) {
      const c = contribution(saltId, ion)
      if (c !== 0) deficit[ion] -= c * grams
    }
  }

  return dose
}
