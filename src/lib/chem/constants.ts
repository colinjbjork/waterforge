// Chemical constants for the Waterforge engine.
//
// Everything downstream (the ion x salt matrix, conversions, saturation
// indices) is derived from the atomic weights and stoichiometry declared here,
// so the numbers stay auditable: nothing is hand-tuned. Background on the ions
// and salts modelled lives in the chemistry guides under `docs/`.

/**
 * The ions Waterforge tracks, by their conventional symbols.
 *
 * The seven drinking-water ions come first. The onsen fork adds carbonate
 * (CO3, charge -2) for alkaline hot-spring waters, and metasilicic acid
 * (H2SiO3, charge 0 — an undissociated species tracked by mass).
 */
export type IonId =
  'Ca' | 'Mg' | 'Na' | 'K' | 'HCO3' | 'SO4' | 'Cl' | 'CO3' | 'H2SiO3'

/** The food-grade salts Waterforge can dose. */
export type SaltId =
  | 'gypsum'
  | 'epsom'
  | 'tableSalt'
  | 'calciumChloride'
  | 'calciumChlorideAnhydrous'
  | 'bakingSoda'
  | 'chalk'
  | 'magnesiumChloride'
  | 'potassiumBicarbonate'
  // Onsen fork additions (see docs/onsen-input.md).
  | 'sodiumCarbonate'
  | 'sodiumCarbonateDecahydrate'
  | 'sodiumSulfateDecahydrate'
  | 'sodiumSulfate'
  | 'potassiumChloride'
  | 'sodiumMetasilicate'
  // Bath-only acid (never in SALT_ORDER; see `ACIDS`).
  | 'hydrochloricAcid'

// Atomic / elemental weights (g/mol). Standard atomic weights at the precision
// the source method uses; group weights below are summed from these.
export const ATOMIC_WEIGHTS = {
  Ca: 40.078,
  Mg: 24.305,
  Na: 22.99,
  K: 39.098,
  S: 32.06,
  O: 15.999,
  H: 1.008,
  C: 12.011,
  Cl: 35.45,
  Si: 28.085,
} as const

// Group weights derived from the atomic weights above. Summing them here (rather
// than quoting a literal) keeps the derivation visible and self-checking.
export const SO4_WEIGHT = ATOMIC_WEIGHTS.S + 4 * ATOMIC_WEIGHTS.O // 96.06
export const HCO3_WEIGHT =
  ATOMIC_WEIGHTS.H + ATOMIC_WEIGHTS.C + 3 * ATOMIC_WEIGHTS.O // 61.017
export const CO3_WEIGHT = ATOMIC_WEIGHTS.C + 3 * ATOMIC_WEIGHTS.O // 60.009
export const CACO3_WEIGHT =
  ATOMIC_WEIGHTS.Ca + ATOMIC_WEIGHTS.C + 3 * ATOMIC_WEIGHTS.O // 100.087
export const H2O_WEIGHT = 2 * ATOMIC_WEIGHTS.H + ATOMIC_WEIGHTS.O // 18.015
export const H2SIO3_WEIGHT =
  2 * ATOMIC_WEIGHTS.H + ATOMIC_WEIGHTS.Si + 3 * ATOMIC_WEIGHTS.O // 78.098
export const OH_WEIGHT = ATOMIC_WEIGHTS.O + ATOMIC_WEIGHTS.H // 17.007

// Molar masses of the onsen-fork salts, summed from the atomic weights above
// (water of hydration included) rather than quoted, so they stay auditable.
export const NA2CO3_WEIGHT = 2 * ATOMIC_WEIGHTS.Na + CO3_WEIGHT // 105.989
export const NA2CO3_10H2O_WEIGHT = NA2CO3_WEIGHT + 10 * H2O_WEIGHT // 286.139
export const NA2SO4_WEIGHT = 2 * ATOMIC_WEIGHTS.Na + SO4_WEIGHT // 142.036
export const NA2SO4_10H2O_WEIGHT = NA2SO4_WEIGHT + 10 * H2O_WEIGHT // 322.186
export const KCL_WEIGHT = ATOMIC_WEIGHTS.K + ATOMIC_WEIGHTS.Cl // 74.548
export const NA2SIO3_5H2O_WEIGHT =
  2 * ATOMIC_WEIGHTS.Na +
  ATOMIC_WEIGHTS.Si +
  3 * ATOMIC_WEIGHTS.O +
  5 * H2O_WEIGHT // 212.137
export const HCL_WEIGHT = ATOMIC_WEIGHTS.H + ATOMIC_WEIGHTS.Cl // 36.458

// The muriatic acid on hand is a 14.5 % w/w HCl solution (the "safer" /
// half-strength retail grade; density ≈ 1.07 g/mL at 20 °C, interpolated
// from the 14 % → 1.069 and 16 % → 1.079 HCl density tables). The acid
// "salt" below is defined as that product, so its dose comes out in grams
// of the jug's contents — the same device as counting water of hydration in
// a hydrate's molar mass. Full-strength 31.45 % (20° Baumé) jugs need 0.43×
// the volume; change these two constants if the jug changes.
export const MURIATIC_ACID_MASS_FRACTION = 0.145
export const MURIATIC_ACID_DENSITY_G_PER_ML = 1.07
/** Grams of 14.5 % muriatic acid that carry one mole of HCl. */
export const MURIATIC_ACID_WEIGHT = HCL_WEIGHT / MURIATIC_ACID_MASS_FRACTION // 251.4

/** Molar mass of CaCO3, the reference compound for alkalinity expressed as-CaCO3. */
export const CACO3_MOLAR_MASS = CACO3_WEIGHT

// CaCO3 carries two equivalents of charge per mole, so its equivalent weight is
// half its molar mass. Used to convert alkalinity between as-CaCO3 and as-HCO3.
export const CACO3_EQUIVALENT_WEIGHT = CACO3_WEIGHT / 2 // 50.0435

export interface Ion {
  readonly id: IonId
  /** Ionic charge (valence with sign). */
  readonly charge: number
  /** Molar mass in g/mol. */
  readonly molarMass: number
}

export const IONS: Record<IonId, Ion> = {
  Ca: { id: 'Ca', charge: +2, molarMass: ATOMIC_WEIGHTS.Ca },
  Mg: { id: 'Mg', charge: +2, molarMass: ATOMIC_WEIGHTS.Mg },
  Na: { id: 'Na', charge: +1, molarMass: ATOMIC_WEIGHTS.Na },
  K: { id: 'K', charge: +1, molarMass: ATOMIC_WEIGHTS.K },
  HCO3: { id: 'HCO3', charge: -1, molarMass: HCO3_WEIGHT },
  SO4: { id: 'SO4', charge: -2, molarMass: SO4_WEIGHT },
  Cl: { id: 'Cl', charge: -1, molarMass: ATOMIC_WEIGHTS.Cl },
  CO3: { id: 'CO3', charge: -2, molarMass: CO3_WEIGHT },
  // Metasilicic acid is undissociated at bath pH: no charge, tracked by mass.
  H2SiO3: { id: 'H2SiO3', charge: 0, molarMass: H2SIO3_WEIGHT },
}

/** Stable iteration order for ions (cations then anions). */
export const ION_ORDER: readonly IonId[] = [
  'Ca',
  'Mg',
  'Na',
  'K',
  'HCO3',
  'SO4',
  'Cl',
  'CO3',
  'H2SiO3',
]

export interface Salt {
  readonly id: SaltId
  /** Human-readable name. */
  readonly name: string
  /**
   * Plain product name a person would look for in a store (e.g. "Epsom salt",
   * "pickling/canning salt"). Used by the onsen CLI's recipe table.
   */
  readonly purchaseName: string
  /** Chemical formula, including any water of hydration. */
  readonly formula: string
  /** Molar mass in g/mol, INCLUDING water of hydration. */
  readonly molarMass: number
  // Moles of each ion released per mole of salt dissolved. Chalk (CaCO3)
  // dissolves to Ca plus carbonate; in carbonate water chemistry that carbonate
  // is accounted as bicarbonate alkalinity (HCO3), matching the source method.
  readonly stoichiometry: Partial<Record<IonId, number>>
  /**
   * Net charge (per mole of salt) of the ions the model tracks, when the salt
   * is deliberately NOT charge-balanced in the model. Omitted (zero) for every
   * ordinary salt. The counter-charge is water's own ion: a positive value is
   * the number of hydroxide ions (OH⁻) the salt releases per mole, a negative
   * value the number of hydrogen ions (H⁺). Sodium metasilicate is +2 (2 Na⁺
   * plus neutral H2SiO3 plus 2 OH⁻); hydrochloric acid is −1 (Cl⁻ plus H⁺).
   * The onsen layer (`src/lib/onsen/chemistry.ts`) reads this to dose acid
   * against released hydroxide and to estimate the bath pH; the solver itself
   * leaves it visible in the charge-residual readout.
   */
  readonly netCharge?: number
  /**
   * Density in g/mL for an ingredient sold as a liquid, so the report can
   * print a volume next to the gram dose. Omitted for solids.
   */
  readonly densityGPerMl?: number
}

export const SALTS: Record<SaltId, Salt> = {
  gypsum: {
    id: 'gypsum',
    purchaseName: 'gypsum brewing salt',
    name: 'Gypsum',
    formula: 'CaSO4·2H2O',
    molarMass: 172.17,
    stoichiometry: { Ca: 1, SO4: 1 },
  },
  epsom: {
    id: 'epsom',
    purchaseName: 'Epsom salt',
    name: 'Epsom salt',
    formula: 'MgSO4·7H2O',
    molarMass: 246.47,
    stoichiometry: { Mg: 1, SO4: 1 },
  },
  tableSalt: {
    id: 'tableSalt',
    purchaseName: 'pickling/canning salt (plain, non-iodised NaCl)',
    name: 'Table salt',
    formula: 'NaCl',
    molarMass: 58.44,
    stoichiometry: { Na: 1, Cl: 1 },
  },
  calciumChloride: {
    id: 'calciumChloride',
    purchaseName: 'calcium chloride brewing salt (dihydrate)',
    name: 'Calcium Chloride (Dihydrate)',
    formula: 'CaCl2·2H2O',
    molarMass: 147.01,
    stoichiometry: { Ca: 1, Cl: 2 },
  },
  calciumChlorideAnhydrous: {
    id: 'calciumChlorideAnhydrous',
    purchaseName: 'calcium chloride brewing salt (anhydrous pellets)',
    name: 'Calcium Chloride (Anhydrous)',
    // Same ions as the dihydrate; only the molar mass (no water of hydration)
    // differs, so the gram dose per unit of Ca/Cl is lower. Common in brewing
    // supply as pellets/prills (e.g. LD Carlson "Briners Choice").
    formula: 'CaCl2',
    molarMass: 110.98,
    stoichiometry: { Ca: 1, Cl: 2 },
  },
  bakingSoda: {
    id: 'bakingSoda',
    purchaseName: 'baking soda',
    name: 'Baking soda',
    formula: 'NaHCO3',
    molarMass: 84.007,
    stoichiometry: { Na: 1, HCO3: 1 },
  },
  chalk: {
    id: 'chalk',
    purchaseName: 'calcium carbonate / chalk brewing salt',
    name: 'Calcium Carbonate (Chalk)',
    formula: 'CaCO3',
    molarMass: 100.087,
    // Dissolves (in CO2-charged water) to calcium plus carbonate alkalinity:
    // CaCO3 + CO2 + H2O -> Ca(2+) + 2 HCO3(-). Tracked as 2 HCO3, which keeps
    // the salt charge-balanced and matches standard alkalinity accounting.
    stoichiometry: { Ca: 1, HCO3: 2 },
  },
  magnesiumChloride: {
    id: 'magnesiumChloride',
    purchaseName: 'magnesium chloride flakes',
    name: 'Magnesium chloride hexahydrate',
    formula: 'MgCl2·6H2O',
    molarMass: 203.3,
    stoichiometry: { Mg: 1, Cl: 2 },
  },
  potassiumBicarbonate: {
    id: 'potassiumBicarbonate',
    purchaseName: 'potassium bicarbonate',
    name: 'Potassium bicarbonate',
    formula: 'KHCO3',
    molarMass: 100.115,
    stoichiometry: { K: 1, HCO3: 1 },
  },

  // --- Onsen fork additions ---------------------------------------------
  // Sit at the END of SALT_ORDER so the drinking-water recipe policy (ADR 0009)
  // never reaches for them unless they lower the residual.
  sodiumCarbonate: {
    id: 'sodiumCarbonate',
    purchaseName: 'soda ash / pool pH increaser',
    name: 'Sodium carbonate (anhydrous)',
    formula: 'Na2CO3',
    molarMass: NA2CO3_WEIGHT,
    stoichiometry: { Na: 2, CO3: 1 },
  },
  sodiumCarbonateDecahydrate: {
    id: 'sodiumCarbonateDecahydrate',
    purchaseName: 'washing soda (sodium carbonate decahydrate)',
    name: 'Sodium carbonate decahydrate',
    formula: 'Na2CO3·10H2O',
    molarMass: NA2CO3_10H2O_WEIGHT,
    stoichiometry: { Na: 2, CO3: 1 },
  },
  sodiumSulfateDecahydrate: {
    id: 'sodiumSulfateDecahydrate',
    purchaseName: "Glauber's salt (sodium sulfate decahydrate)",
    name: 'Sodium sulfate decahydrate',
    formula: 'Na2SO4·10H2O',
    molarMass: NA2SO4_10H2O_WEIGHT,
    stoichiometry: { Na: 2, SO4: 1 },
  },
  sodiumSulfate: {
    id: 'sodiumSulfate',
    purchaseName: 'sodium sulfate (anhydrous)',
    name: 'Sodium sulfate (anhydrous)',
    formula: 'Na2SO4',
    molarMass: NA2SO4_WEIGHT,
    stoichiometry: { Na: 2, SO4: 1 },
  },
  potassiumChloride: {
    id: 'potassiumChloride',
    purchaseName:
      'potassium chloride (NoSalt salt substitute / KCl softener pellets)',
    name: 'Potassium chloride',
    formula: 'KCl',
    molarMass: KCL_WEIGHT,
    stoichiometry: { K: 1, Cl: 1 },
  },
  sodiumMetasilicate: {
    id: 'sodiumMetasilicate',
    purchaseName: 'sodium metasilicate pentahydrate',
    name: 'Sodium metasilicate pentahydrate',
    formula: 'Na2SiO3·5H2O',
    molarMass: NA2SIO3_5H2O_WEIGHT,
    // Dissolves to 2 Na+ and silicate, which at bath pH is carried as
    // metasilicic acid (H2SiO3, neutral) plus 2 OH-. Hydroxide is not a
    // modelled ion, so the +2 is declared here and shows up in the
    // charge-residual readout rather than being hidden.
    stoichiometry: { Na: 2, H2SiO3: 1 },
    netCharge: +2,
  },

  // --- Bath-only acid ------------------------------------------------------
  // NOT in SALT_ORDER: the least-squares fit never reaches for it and the
  // drinking-water app never lists it. The onsen layer doses it after the fit,
  // stoichiometrically, to cancel the hydroxide sodium metasilicate releases
  // (see src/lib/onsen/chemistry.ts). Defined as the retail 14.5 % solution
  // so the gram dose is grams of muriatic acid as poured.
  hydrochloricAcid: {
    id: 'hydrochloricAcid',
    purchaseName: 'muriatic acid (14.5% hydrochloric acid, hardware store)',
    name: 'Hydrochloric acid, 14.5% solution',
    formula: 'HCl (14.5% aq)',
    molarMass: MURIATIC_ACID_WEIGHT,
    // Cl⁻ plus one H⁺ per mole; the H⁺ is water's ion, declared as −1.
    stoichiometry: { Cl: 1 },
    netCharge: -1,
    densityGPerMl: MURIATIC_ACID_DENSITY_G_PER_ML,
  },
}

/**
 * Acids the onsen layer may dose after the fit. Deliberately NOT part of
 * SALT_ORDER, so neither the solver's recipe policy (ADR 0009) nor the
 * drinking-water UI ever sees them.
 */
export const ACIDS: readonly SaltId[] = ['hydrochloricAcid']

/** Stable iteration order for salts (the source method's dosing priority). */
export const SALT_ORDER: readonly SaltId[] = [
  'gypsum',
  'epsom',
  'tableSalt',
  'calciumChloride',
  'calciumChlorideAnhydrous',
  'bakingSoda',
  'chalk',
  'magnesiumChloride',
  'potassiumBicarbonate',
  // Onsen fork additions, lowest priority.
  'sodiumCarbonate',
  'sodiumCarbonateDecahydrate',
  'sodiumSulfateDecahydrate',
  'sodiumSulfate',
  'potassiumChloride',
  'sodiumMetasilicate',
]

/**
 * The salts actually on the shelf for onsen baths — the onsen layer fits
 * over THIS list, not SALT_ORDER, so a recipe never calls for a jar that
 * isn't there. Inventory as stated 2026-09-15: calcium sulfate (gypsum),
 * Epsom salt, table salt, calcium chloride (dihydrate), sodium bicarbonate,
 * calcium carbonate, magnesium chloride, potassium bicarbonate, washing soda
 * (sodium carbonate decahydrate), Glauber's salt (sodium sulfate
 * decahydrate), potassium chloride, sodium metasilicate, plus muriatic acid
 * (14.5 %, in `ACIDS`). Deliberately absent: anhydrous calcium chloride,
 * anhydrous soda ash and anhydrous sodium sulfate. Order = fit priority,
 * same convention as SALT_ORDER.
 */
export const ONSEN_PALETTE: readonly SaltId[] = [
  'gypsum',
  'epsom',
  'tableSalt',
  'calciumChloride',
  'bakingSoda',
  'chalk',
  'magnesiumChloride',
  'potassiumBicarbonate',
  'sodiumCarbonateDecahydrate',
  'sodiumSulfateDecahydrate',
  'potassiumChloride',
  'sodiumMetasilicate',
]
