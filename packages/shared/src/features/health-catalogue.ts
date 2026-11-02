/**
 * Health metric catalogue: HealthKit identifier → localized name, category, display format and
 * "which direction is good". Pure data + pure functions (no Intl, no React) so the server (tests, key metric
 * list) and the web UI share one source of truth.
 *
 * Values in the database are canonical (kg, m, m/s, kcal, °C, fractions for '%' types …); `displaySpec` says how
 * to turn them into what the user sees, honouring metric/imperial units.
 */
import { KG_PER_LB, M_PER_KM, M_PER_MI } from '../units';
import type { Units } from '../core';

export type HealthCategory =
  | 'activity'
  | 'heart'
  | 'respiratory'
  | 'vitals'
  | 'body'
  | 'sleep'
  | 'mobility'
  | 'hearing'
  | 'nutrition'
  | 'mindfulness'
  | 'cycle'
  | 'symptoms'
  | 'other';

/** Display order of the categories in the data explorer. */
export const HEALTH_CATEGORIES: { key: HealthCategory; en: string; de: string }[] = [
  { key: 'activity', en: 'Activity', de: 'Aktivität' },
  { key: 'heart', en: 'Heart', de: 'Herz' },
  { key: 'respiratory', en: 'Respiratory', de: 'Atmung' },
  { key: 'vitals', en: 'Vitals', de: 'Vitalwerte' },
  { key: 'body', en: 'Body', de: 'Körper' },
  { key: 'sleep', en: 'Sleep', de: 'Schlaf' },
  { key: 'mobility', en: 'Mobility', de: 'Mobilität' },
  { key: 'hearing', en: 'Hearing', de: 'Gehör' },
  { key: 'nutrition', en: 'Nutrition', de: 'Ernährung' },
  { key: 'mindfulness', en: 'Mindfulness', de: 'Achtsamkeit' },
  { key: 'cycle', en: 'Cycle tracking', de: 'Zyklus' },
  { key: 'symptoms', en: 'Symptoms', de: 'Symptome' },
  { key: 'other', en: 'Other', de: 'Sonstiges' },
];

/** How a canonical value is turned into a display value + unit. */
export type DisplayKind =
  | 'count' // unitless integer (steps, flights)
  | 'bpm' // beats per minute
  | 'perMin' // breaths per minute and similar rates
  | 'ms'
  | 'fraction' // canonical 0..1 → shown as %
  | 'percent' // canonical already in %
  | 'mass' // kg → kg / lb
  | 'massG' // kg → g (nutrition; grams are normalised to kg on import)
  | 'distance' // m → km / mi
  | 'length' // m → cm / in
  | 'meters' // m → m / yd (swim distance, depth)
  | 'speed' // m/s → km/h / mph
  | 'energy' // kcal
  | 'minutes' // min → duration (h:mm)
  | 'seconds' // s → duration
  | 'temp' // °C → °C / °F
  | 'decibel'
  | 'power'
  | 'vo2'
  | 'volume' // L → L / fl oz
  | 'pressure' // mmHg
  | 'decimal' // plain number with the canonical unit label
  | 'auto'; // infer from the canonical unit of the record type

/** Which direction of change is an improvement. null = neutral (depends on the person's goal). */
export type GoodDirection = 'up' | 'down' | null;

export interface MetricDef {
  identifier: string;
  en: string;
  de: string;
  category: HealthCategory;
  kind: DisplayKind;
  good: GoodDirection;
  /** Fraction digits of displayed values (default per kind). */
  digits?: number;
  /** Unit label override (e.g. 'rpm' for a cadence stored as count/min). */
  unit?: string;
}

const Q = 'HKQuantityTypeIdentifier';
const C = 'HKCategoryTypeIdentifier';

const DEFS: MetricDef[] = [];

function q(
  id: string,
  en: string,
  de: string,
  category: HealthCategory,
  kind: DisplayKind,
  good: GoodDirection = null,
  digits?: number,
  unit?: string,
): void {
  DEFS.push({ identifier: Q + id, en, de, category, kind, good, digits, unit });
}

function c(id: string, en: string, de: string, category: HealthCategory, good: GoodDirection = null): void {
  DEFS.push({ identifier: C + id, en, de, category, kind: 'minutes', good });
}

// ---- Activity ---------------------------------------------------------------------------------------------
q('StepCount', 'Steps', 'Schritte', 'activity', 'count', 'up');
q('DistanceWalkingRunning', 'Walking + running distance', 'Geh- und Laufdistanz', 'activity', 'distance', 'up');
q('DistanceCycling', 'Cycling distance', 'Raddistanz', 'activity', 'distance', 'up');
q('DistanceWheelchair', 'Wheelchair distance', 'Rollstuhldistanz', 'activity', 'distance', 'up');
q('DistanceSwimming', 'Swimming distance', 'Schwimmdistanz', 'activity', 'meters', 'up', 0);
q('DistanceDownhillSnowSports', 'Snow sports distance', 'Wintersport-Distanz', 'activity', 'distance', 'up');
q('DistanceCrossCountrySkiing', 'Cross-country skiing distance', 'Langlaufdistanz', 'activity', 'distance', 'up');
q('DistancePaddleSports', 'Paddling distance', 'Paddeldistanz', 'activity', 'distance', 'up');
q('DistanceRowing', 'Rowing distance', 'Ruderdistanz', 'activity', 'distance', 'up');
q('DistanceSkatingSports', 'Skating distance', 'Skate-Distanz', 'activity', 'distance', 'up');
q('BasalEnergyBurned', 'Resting energy', 'Ruheenergie', 'activity', 'energy', null);
q('ActiveEnergyBurned', 'Active energy', 'Aktive Energie', 'activity', 'energy', 'up');
q('FlightsClimbed', 'Flights climbed', 'Gestiegene Stockwerke', 'activity', 'count', 'up');
q('NikeFuel', 'NikeFuel', 'NikeFuel', 'activity', 'count', 'up');
q('AppleExerciseTime', 'Exercise minutes', 'Trainingsminuten', 'activity', 'minutes', 'up');
q('AppleMoveTime', 'Move minutes', 'Bewegungsminuten', 'activity', 'minutes', 'up');
q('AppleStandTime', 'Stand minutes', 'Stehminuten', 'activity', 'minutes', 'up');
c('AppleStandHour', 'Stand hours', 'Stehstunden', 'activity', 'up');
q('PushCount', 'Wheelchair pushes', 'Rollstuhl-Schübe', 'activity', 'count', 'up');
q('SwimmingStrokeCount', 'Swimming strokes', 'Schwimmzüge', 'activity', 'count', 'up');
q('VO2Max', 'Cardio fitness (VO₂ max)', 'Cardio-Fitness (VO₂max)', 'activity', 'vo2', 'up', 1);
q('CyclingSpeed', 'Cycling speed', 'Radgeschwindigkeit', 'activity', 'speed', 'up');
q('CyclingPower', 'Cycling power', 'Radleistung', 'activity', 'power', 'up');
q('CyclingCadence', 'Cycling cadence', 'Trittfrequenz', 'activity', 'perMin', null, 0, 'rpm');
q('CyclingFunctionalThresholdPower', 'Cycling FTP', 'Funktionale Schwellenleistung (Rad)', 'activity', 'power', 'up');
q('PhysicalEffort', 'Physical effort', 'Körperliche Anstrengung', 'activity', 'decimal', null, 1);
q('EstimatedWorkoutEffortScore', 'Estimated workout effort', 'Geschätzte Trainingsanstrengung', 'activity', 'decimal', null, 1);
q('WorkoutEffortScore', 'Workout effort', 'Trainingsanstrengung', 'activity', 'decimal', null, 1);
q('TimeInDaylight', 'Time in daylight', 'Zeit im Tageslicht', 'activity', 'minutes', 'up');
q('RunningSpeed', 'Running speed', 'Laufgeschwindigkeit', 'activity', 'speed', 'up');
q('RunningPower', 'Running power', 'Laufleistung', 'activity', 'power', null);
q('RunningStrideLength', 'Running stride length', 'Laufschrittlänge', 'activity', 'length', null, 0);
q('RunningVerticalOscillation', 'Vertical oscillation', 'Vertikale Oszillation', 'activity', 'length', 'down', 1);
q('RunningGroundContactTime', 'Ground contact time', 'Bodenkontaktzeit', 'activity', 'ms', 'down');
q('CrossCountrySkiingSpeed', 'Cross-country skiing speed', 'Langlaufgeschwindigkeit', 'activity', 'speed', 'up');
q('PaddleSportsSpeed', 'Paddling speed', 'Paddelgeschwindigkeit', 'activity', 'speed', 'up');
q('RowingSpeed', 'Rowing speed', 'Rudergeschwindigkeit', 'activity', 'speed', 'up');
q('UnderwaterDepth', 'Underwater depth', 'Tauchtiefe', 'activity', 'meters', null, 1);
q('WaterTemperature', 'Water temperature', 'Wassertemperatur', 'activity', 'temp', null);

// ---- Heart --------------------------------------------------------------------------------------------------
q('HeartRate', 'Heart rate', 'Herzfrequenz', 'heart', 'bpm', null);
q('RestingHeartRate', 'Resting heart rate', 'Ruheherzfrequenz', 'heart', 'bpm', 'down');
q('WalkingHeartRateAverage', 'Walking heart rate', 'Herzfrequenz beim Gehen', 'heart', 'bpm', 'down');
q('HeartRateVariabilitySDNN', 'Heart rate variability', 'Herzfrequenzvariabilität', 'heart', 'ms', 'up');
q('HeartRateRecoveryOneMinute', 'Heart rate recovery', 'Herzfrequenzerholung', 'heart', 'bpm', 'up');
q('AtrialFibrillationBurden', 'AFib burden', 'VHF-Anteil', 'heart', 'fraction', 'down', 1);
q('PeripheralPerfusionIndex', 'Perfusion index', 'Perfusionsindex', 'heart', 'fraction', null, 1);
c('HighHeartRateEvent', 'High heart rate notifications', 'Benachrichtigungen: hohe Herzfrequenz', 'heart', 'down');
c('LowHeartRateEvent', 'Low heart rate notifications', 'Benachrichtigungen: niedrige Herzfrequenz', 'heart', 'down');
c('IrregularHeartRhythmEvent', 'Irregular rhythm notifications', 'Benachrichtigungen: unregelmäßiger Rhythmus', 'heart', 'down');
c('LowCardioFitnessEvent', 'Low cardio fitness notifications', 'Benachrichtigungen: niedrige Cardio-Fitness', 'heart', 'down');

// ---- Respiratory --------------------------------------------------------------------------------------------
q('RespiratoryRate', 'Respiratory rate', 'Atemfrequenz', 'respiratory', 'perMin', null, 1, '/min');
q('OxygenSaturation', 'Blood oxygen', 'Blutsauerstoff', 'respiratory', 'fraction', 'up');
q('ForcedVitalCapacity', 'Forced vital capacity', 'Forcierte Vitalkapazität', 'respiratory', 'volume', 'up');
q('ForcedExpiratoryVolume1', 'FEV₁', 'Einsekundenkapazität (FEV₁)', 'respiratory', 'volume', 'up');
q('PeakExpiratoryFlowRate', 'Peak expiratory flow', 'Spitzenfluss (Peak Flow)', 'respiratory', 'decimal', 'up', 0);
q('InhalerUsage', 'Inhaler usage', 'Inhalator-Nutzung', 'respiratory', 'count', 'down');

// ---- Vitals -------------------------------------------------------------------------------------------------
q('BodyTemperature', 'Body temperature', 'Körpertemperatur', 'vitals', 'temp', null);
q('AppleSleepingWristTemperature', 'Wrist temperature (sleep)', 'Handgelenktemperatur (Schlaf)', 'vitals', 'temp', null, 2);
q('BloodPressureSystolic', 'Systolic blood pressure', 'Systolischer Blutdruck', 'vitals', 'pressure', 'down');
q('BloodPressureDiastolic', 'Diastolic blood pressure', 'Diastolischer Blutdruck', 'vitals', 'pressure', 'down');
q('BloodGlucose', 'Blood glucose', 'Blutzucker', 'vitals', 'decimal', null, 0);
q('InsulinDelivery', 'Insulin delivery', 'Insulinabgabe', 'vitals', 'decimal', null, 1);
q('BloodAlcoholContent', 'Blood alcohol', 'Blutalkohol', 'vitals', 'fraction', 'down', 2);
q('NumberOfAlcoholicBeverages', 'Alcoholic drinks', 'Alkoholische Getränke', 'vitals', 'count', 'down');
q('ElectrodermalActivity', 'Electrodermal activity', 'Elektrodermale Aktivität', 'vitals', 'decimal', null, 2);

// ---- Body ---------------------------------------------------------------------------------------------------
q('BodyMass', 'Weight', 'Gewicht', 'body', 'mass', null);
q('BodyMassIndex', 'Body mass index', 'Body-Mass-Index', 'body', 'decimal', null, 1, 'kg/m²');
q('BodyFatPercentage', 'Body fat', 'Körperfettanteil', 'body', 'fraction', 'down', 1);
q('LeanBodyMass', 'Lean body mass', 'Fettfreie Körpermasse', 'body', 'mass', 'up');
q('Height', 'Height', 'Körpergröße', 'body', 'length', null, 0);
q('WaistCircumference', 'Waist circumference', 'Taillenumfang', 'body', 'length', 'down', 1);

// ---- Sleep --------------------------------------------------------------------------------------------------
c('SleepAnalysis', 'Sleep', 'Schlaf', 'sleep', 'up');
c('SleepApneaEvent', 'Sleep apnea notifications', 'Schlafapnoe-Benachrichtigungen', 'sleep', 'down');
q('AppleSleepingBreathingDisturbances', 'Breathing disturbances', 'Atemstörungen', 'sleep', 'decimal', 'down', 1);

// ---- Mobility -----------------------------------------------------------------------------------------------
q('WalkingSpeed', 'Walking speed', 'Gehgeschwindigkeit', 'mobility', 'speed', 'up');
q('WalkingStepLength', 'Walking step length', 'Schrittlänge', 'mobility', 'length', 'up', 0);
q('WalkingAsymmetryPercentage', 'Walking asymmetry', 'Gehasymmetrie', 'mobility', 'fraction', 'down', 1);
q('WalkingDoubleSupportPercentage', 'Double support time', 'Doppelte Standphase', 'mobility', 'fraction', 'down', 1);
q('AppleWalkingSteadiness', 'Walking steadiness', 'Gangsicherheit', 'mobility', 'fraction', 'up');
q('SixMinuteWalkTestDistance', 'Six-minute walk distance', 'Sechs-Minuten-Gehtest', 'mobility', 'meters', 'up', 0);
q('StairAscentSpeed', 'Stair ascent speed', 'Geschwindigkeit Treppe aufwärts', 'mobility', 'speed', 'up');
q('StairDescentSpeed', 'Stair descent speed', 'Geschwindigkeit Treppe abwärts', 'mobility', 'speed', 'up');
q('NumberOfTimesFallen', 'Falls', 'Stürze', 'mobility', 'count', 'down');
c('AppleWalkingSteadinessEvent', 'Walking steadiness notifications', 'Benachrichtigungen: Gangsicherheit', 'mobility', 'down');

// ---- Hearing ------------------------------------------------------------------------------------------------
q('EnvironmentalAudioExposure', 'Environmental sound levels', 'Umgebungslautstärke', 'hearing', 'decibel', 'down');
q('HeadphoneAudioExposure', 'Headphone audio levels', 'Kopfhörerlautstärke', 'hearing', 'decibel', 'down');
q('EnvironmentalSoundReduction', 'Noise reduction', 'Geräuschreduzierung', 'hearing', 'decibel', 'up');
c('EnvironmentalAudioExposureEvent', 'Loud environment events', 'Ereignisse: laute Umgebung', 'hearing', 'down');
c('AudioExposureEvent', 'Loud headphone events', 'Ereignisse: laute Kopfhörer', 'hearing', 'down');
c('HeadphoneAudioExposureEvent', 'Loud headphone events', 'Ereignisse: laute Kopfhörer', 'hearing', 'down');

// ---- Nutrition ----------------------------------------------------------------------------------------------
q('DietaryEnergyConsumed', 'Dietary energy', 'Aufgenommene Energie', 'nutrition', 'energy', null);
q('DietaryProtein', 'Protein', 'Eiweiß', 'nutrition', 'massG', null);
q('DietaryCarbohydrates', 'Carbohydrates', 'Kohlenhydrate', 'nutrition', 'massG', null);
q('DietarySugar', 'Sugar', 'Zucker', 'nutrition', 'massG', 'down');
q('DietaryFiber', 'Fiber', 'Ballaststoffe', 'nutrition', 'massG', 'up');
q('DietaryFatTotal', 'Total fat', 'Fett gesamt', 'nutrition', 'massG', null);
q('DietaryFatSaturated', 'Saturated fat', 'Gesättigte Fette', 'nutrition', 'massG', 'down');
q('DietaryFatMonounsaturated', 'Monounsaturated fat', 'Einfach ungesättigte Fette', 'nutrition', 'massG', null);
q('DietaryFatPolyunsaturated', 'Polyunsaturated fat', 'Mehrfach ungesättigte Fette', 'nutrition', 'massG', null);
q('DietaryCholesterol', 'Cholesterol', 'Cholesterin', 'nutrition', 'auto', 'down');
q('DietarySodium', 'Sodium', 'Natrium', 'nutrition', 'auto', 'down');
q('DietaryPotassium', 'Potassium', 'Kalium', 'nutrition', 'auto', null);
q('DietaryCalcium', 'Calcium', 'Kalzium', 'nutrition', 'auto', null);
q('DietaryIron', 'Iron', 'Eisen', 'nutrition', 'auto', null);
q('DietaryMagnesium', 'Magnesium', 'Magnesium', 'nutrition', 'auto', null);
q('DietaryPhosphorus', 'Phosphorus', 'Phosphor', 'nutrition', 'auto', null);
q('DietaryZinc', 'Zinc', 'Zink', 'nutrition', 'auto', null);
q('DietaryCopper', 'Copper', 'Kupfer', 'nutrition', 'auto', null);
q('DietaryManganese', 'Manganese', 'Mangan', 'nutrition', 'auto', null);
q('DietaryChloride', 'Chloride', 'Chlorid', 'nutrition', 'auto', null);
q('DietarySelenium', 'Selenium', 'Selen', 'nutrition', 'auto', null);
q('DietaryIodine', 'Iodine', 'Jod', 'nutrition', 'auto', null);
q('DietaryChromium', 'Chromium', 'Chrom', 'nutrition', 'auto', null);
q('DietaryMolybdenum', 'Molybdenum', 'Molybdän', 'nutrition', 'auto', null);
q('DietaryVitaminA', 'Vitamin A', 'Vitamin A', 'nutrition', 'auto', null);
q('DietaryVitaminB6', 'Vitamin B6', 'Vitamin B6', 'nutrition', 'auto', null);
q('DietaryVitaminB12', 'Vitamin B12', 'Vitamin B12', 'nutrition', 'auto', null);
q('DietaryVitaminC', 'Vitamin C', 'Vitamin C', 'nutrition', 'auto', null);
q('DietaryVitaminD', 'Vitamin D', 'Vitamin D', 'nutrition', 'auto', null);
q('DietaryVitaminE', 'Vitamin E', 'Vitamin E', 'nutrition', 'auto', null);
q('DietaryVitaminK', 'Vitamin K', 'Vitamin K', 'nutrition', 'auto', null);
q('DietaryThiamin', 'Thiamin (B1)', 'Thiamin (B1)', 'nutrition', 'auto', null);
q('DietaryRiboflavin', 'Riboflavin (B2)', 'Riboflavin (B2)', 'nutrition', 'auto', null);
q('DietaryNiacin', 'Niacin (B3)', 'Niacin (B3)', 'nutrition', 'auto', null);
q('DietaryPantothenicAcid', 'Pantothenic acid (B5)', 'Pantothensäure (B5)', 'nutrition', 'auto', null);
q('DietaryBiotin', 'Biotin (B7)', 'Biotin (B7)', 'nutrition', 'auto', null);
q('DietaryFolate', 'Folate (B9)', 'Folsäure (B9)', 'nutrition', 'auto', null);
q('DietaryCaffeine', 'Caffeine', 'Koffein', 'nutrition', 'auto', null);
q('DietaryWater', 'Water', 'Wasser', 'nutrition', 'volume', 'up');

// ---- Mindfulness --------------------------------------------------------------------------------------------
c('MindfulSession', 'Mindful minutes', 'Achtsamkeitsminuten', 'mindfulness', 'up');

// ---- Cycle tracking -----------------------------------------------------------------------------------------
c('MenstrualFlow', 'Menstrual flow', 'Menstruationsblutung', 'cycle');
c('IntermenstrualBleeding', 'Spotting', 'Zwischenblutung', 'cycle');
c('CervicalMucusQuality', 'Cervical mucus quality', 'Zervixschleim', 'cycle');
c('OvulationTestResult', 'Ovulation test', 'Ovulationstest', 'cycle');
c('PregnancyTestResult', 'Pregnancy test', 'Schwangerschaftstest', 'cycle');
c('ProgesteroneTestResult', 'Progesterone test', 'Progesterontest', 'cycle');
c('SexualActivity', 'Sexual activity', 'Sexuelle Aktivität', 'cycle');
c('Contraceptive', 'Contraceptive', 'Verhütung', 'cycle');
c('Pregnancy', 'Pregnancy', 'Schwangerschaft', 'cycle');
c('Lactation', 'Lactation', 'Stillzeit', 'cycle');
c('InfrequentMenstrualCycles', 'Infrequent cycles', 'Seltene Zyklen', 'cycle');
c('IrregularMenstrualCycles', 'Irregular cycles', 'Unregelmäßige Zyklen', 'cycle');
c('PersistentIntermenstrualBleeding', 'Persistent spotting', 'Anhaltende Zwischenblutung', 'cycle');
c('ProlongedMenstrualPeriods', 'Prolonged periods', 'Verlängerte Menstruation', 'cycle');
c('BleedingAfterPregnancy', 'Bleeding after pregnancy', 'Blutung nach der Schwangerschaft', 'cycle');
c('BleedingDuringPregnancy', 'Bleeding during pregnancy', 'Blutung während der Schwangerschaft', 'cycle');
q('BasalBodyTemperature', 'Basal body temperature', 'Basaltemperatur', 'cycle', 'temp', null, 2);

// ---- Symptoms -----------------------------------------------------------------------------------------------
const SYMPTOMS: [string, string, string][] = [
  ['AbdominalCramps', 'Abdominal cramps', 'Bauchkrämpfe'],
  ['Acne', 'Acne', 'Akne'],
  ['AppetiteChanges', 'Appetite changes', 'Appetitveränderungen'],
  ['BladderIncontinence', 'Bladder incontinence', 'Blasenschwäche'],
  ['Bloating', 'Bloating', 'Blähungen'],
  ['BreastPain', 'Breast pain', 'Brustschmerzen'],
  ['ChestTightnessOrPain', 'Chest tightness or pain', 'Engegefühl oder Schmerzen in der Brust'],
  ['Chills', 'Chills', 'Schüttelfrost'],
  ['Constipation', 'Constipation', 'Verstopfung'],
  ['Coughing', 'Coughing', 'Husten'],
  ['Diarrhea', 'Diarrhea', 'Durchfall'],
  ['Dizziness', 'Dizziness', 'Schwindel'],
  ['Fainting', 'Fainting', 'Ohnmacht'],
  ['Fatigue', 'Fatigue', 'Müdigkeit'],
  ['Fever', 'Fever', 'Fieber'],
  ['GeneralizedBodyAche', 'Body ache', 'Gliederschmerzen'],
  ['Headache', 'Headache', 'Kopfschmerzen'],
  ['Heartburn', 'Heartburn', 'Sodbrennen'],
  ['HotFlashes', 'Hot flashes', 'Hitzewallungen'],
  ['LossOfSmell', 'Loss of smell', 'Geruchsverlust'],
  ['LossOfTaste', 'Loss of taste', 'Geschmacksverlust'],
  ['LowerBackPain', 'Lower back pain', 'Schmerzen im unteren Rücken'],
  ['MemoryLapse', 'Memory lapse', 'Gedächtnislücken'],
  ['MoodChanges', 'Mood changes', 'Stimmungsschwankungen'],
  ['Nausea', 'Nausea', 'Übelkeit'],
  ['NightSweats', 'Night sweats', 'Nachtschweiß'],
  ['PelvicPain', 'Pelvic pain', 'Beckenschmerzen'],
  ['RapidPoundingOrFlutteringHeartbeat', 'Rapid or fluttering heartbeat', 'Herzrasen oder Herzflattern'],
  ['RunnyNose', 'Runny nose', 'Laufende Nase'],
  ['ShortnessOfBreath', 'Shortness of breath', 'Kurzatmigkeit'],
  ['SinusCongestion', 'Sinus congestion', 'Verstopfte Nase'],
  ['SkippedHeartbeat', 'Skipped heartbeat', 'Herzstolpern'],
  ['SleepChanges', 'Sleep changes', 'Schlafveränderungen'],
  ['SoreThroat', 'Sore throat', 'Halsschmerzen'],
  ['VaginalDryness', 'Vaginal dryness', 'Vaginale Trockenheit'],
  ['Vomiting', 'Vomiting', 'Erbrechen'],
  ['Wheezing', 'Wheezing', 'Pfeifende Atmung'],
];
for (const [id, en, de] of SYMPTOMS) c(id, en, de, 'symptoms');

// ---- Other --------------------------------------------------------------------------------------------------
q('UVExposure', 'UV exposure', 'UV-Belastung', 'other', 'decimal', 'down', 1);
c('ToothbrushingEvent', 'Toothbrushing', 'Zähneputzen', 'other', 'up');
c('HandwashingEvent', 'Handwashing', 'Händewaschen', 'other', 'up');

const BY_ID = new Map<string, MetricDef>(DEFS.map((d) => [d.identifier, d]));

/** Every identifier the catalogue knows (for tests and the explorer's "known types"). */
export const METRIC_DEFS: readonly MetricDef[] = DEFS;

/** Splits `<identifier>:<value>` (category metrics of daily_metrics) into its parts. */
export function splitMetric(metric: string): { identifier: string; value: string | null } {
  const i = metric.indexOf(':');
  return i < 0 ? { identifier: metric, value: null } : { identifier: metric.slice(0, i), value: metric.slice(i + 1) };
}

export function metricDef(identifier: string): MetricDef | undefined {
  return BY_ID.get(splitMetric(identifier).identifier);
}

/** `HKQuantityTypeIdentifierWalkingAsymmetryPercentage` → `Walking Asymmetry Percentage`. */
export function prettifyIdentifier(identifier: string): string {
  const base = identifier
    .replace(/^HK(Quantity|Category|Correlation|Data|Characteristic)TypeIdentifier/, '')
    .replace(/^HK(Quantity|Category|Correlation|Data|Characteristic)Type/, '')
    .replace(/^HK/, '');
  const spaced = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
  return spaced || identifier;
}

export function metricName(identifier: string, lang: 'en' | 'de'): string {
  const def = metricDef(identifier);
  return def ? def[lang] : prettifyIdentifier(splitMetric(identifier).identifier);
}

export function metricCategory(identifier: string): HealthCategory {
  const def = metricDef(identifier);
  if (def) return def.category;
  const id = splitMetric(identifier).identifier;
  if (id.includes('Dietary')) return 'nutrition';
  if (id.includes('Audio') || id.includes('Sound')) return 'hearing';
  if (id.includes('Sleep')) return 'sleep';
  if (id.includes('Walking') || id.includes('Stair')) return 'mobility';
  if (id.includes('Heart')) return 'heart';
  if (id.includes('Menstrual') || id.includes('Ovulation') || id.includes('Pregnan')) return 'cycle';
  if (id.includes('Distance') || id.includes('Energy') || id.includes('Running') || id.includes('Cycling')) return 'activity';
  return 'other';
}

/** Which direction of change is an improvement (null = neutral / depends on the person). */
export function metricGood(identifier: string): GoodDirection {
  return metricDef(identifier)?.good ?? null;
}

const CATEGORY_VALUE_LABELS: Record<string, { en: string; de: string }> = {
  InBed: { en: 'In bed', de: 'Im Bett' },
  Asleep: { en: 'Asleep', de: 'Schlafend' },
  AsleepUnspecified: { en: 'Asleep', de: 'Schlafend' },
  AsleepCore: { en: 'Core', de: 'Kernschlaf' },
  AsleepDeep: { en: 'Deep', de: 'Tiefschlaf' },
  AsleepREM: { en: 'REM', de: 'REM' },
  Awake: { en: 'Awake', de: 'Wach' },
  Stood: { en: 'Stood', de: 'Gestanden' },
  Idle: { en: 'Idle', de: 'Inaktiv' },
  NotApplicable: { en: 'Sessions', de: 'Einheiten' },
  Unspecified: { en: 'Unspecified', de: 'Nicht angegeben' },
  None: { en: 'None', de: 'Keine' },
  Light: { en: 'Light', de: 'Leicht' },
  Medium: { en: 'Medium', de: 'Mittel' },
  Heavy: { en: 'Heavy', de: 'Stark' },
  Positive: { en: 'Positive', de: 'Positiv' },
  Negative: { en: 'Negative', de: 'Negativ' },
  Indeterminate: { en: 'Indeterminate', de: 'Unbestimmt' },
  Present: { en: 'Present', de: 'Vorhanden' },
  NotPresent: { en: 'Not present', de: 'Nicht vorhanden' },
  SeverityMild: { en: 'Mild', de: 'Leicht' },
  SeverityModerate: { en: 'Moderate', de: 'Mäßig' },
  SeveritySevere: { en: 'Severe', de: 'Stark' },
  Dry: { en: 'Dry', de: 'Trocken' },
  Sticky: { en: 'Sticky', de: 'Klebrig' },
  Creamy: { en: 'Creamy', de: 'Cremig' },
  Watery: { en: 'Watery', de: 'Wässrig' },
  EggWhite: { en: 'Egg white', de: 'Eiweißartig' },
};

export function categoryValueLabel(value: string, lang: 'en' | 'de'): string {
  const known = CATEGORY_VALUE_LABELS[value];
  if (known) return known[lang];
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

// ---------------------------------------------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------------------------------------------

export interface DisplaySpec {
  /** Unit label next to the value ('' = none). Empty for durations (formatted as h:mm by the UI). */
  unit: string;
  /** canonical value → display value */
  convert: (v: number) => number;
  /** Fraction digits; undefined = choose by magnitude. */
  digits: number | undefined;
  /** Format as a duration (canonical value is in minutes / seconds) instead of number + unit. */
  duration?: 'minutes' | 'seconds';
}

const id = (v: number) => v;

/** Infer the display kind of an unknown identifier from its canonical record unit. */
export function inferKind(identifier: string, unit: string | null | undefined, maxAbs?: number): DisplayKind {
  switch (unit) {
    case 'count':
      return 'count';
    case 'count/min':
      return identifier.includes('HeartRate') ? 'bpm' : 'perMin';
    case 'ms':
      return 'ms';
    case '%':
      return maxAbs !== undefined && maxAbs > 1.5 ? 'percent' : 'fraction';
    case 'kg':
      return identifier.includes('Dietary') ? 'massG' : 'mass';
    case 'm':
      return identifier.includes('Distance') ? 'distance' : 'length';
    case 'kcal':
      return 'energy';
    case 'min':
      return 'minutes';
    case 's':
      return 'seconds';
    case 'degC':
      return 'temp';
    case 'm/s':
      return 'speed';
    case 'L':
      return 'volume';
    case 'W':
      return 'power';
    case 'dBASPL':
      return 'decibel';
    case 'mmHg':
      return 'pressure';
    case 'mL/min·kg':
      return 'vo2';
    default:
      return 'decimal';
  }
}

/**
 * How to display values of a metric. `canonicalUnit` is the unit of the record type in the database
 * (used for kind 'auto', 'decimal' and unknown identifiers); `maxAbs` helps to tell fractions from percents.
 */
export function displaySpec(
  identifier: string,
  canonicalUnit: string | null | undefined,
  units: Units,
  maxAbs?: number,
): DisplaySpec {
  const spec = baseSpec(identifier, canonicalUnit, units, maxAbs);
  const override = metricDef(identifier)?.unit;
  return override ? { ...spec, unit: override } : spec;
}

function baseSpec(
  identifier: string,
  canonicalUnit: string | null | undefined,
  units: Units,
  maxAbs?: number,
): DisplaySpec {
  const def = metricDef(identifier);
  let kind: DisplayKind = def?.kind ?? 'auto';
  if (kind === 'auto') kind = inferKind(splitMetric(identifier).identifier, canonicalUnit, maxAbs);
  const digits = def?.digits;
  const imperial = units === 'imperial';
  switch (kind) {
    case 'count':
      return { unit: '', convert: id, digits: digits ?? 0 };
    case 'bpm':
      return { unit: 'bpm', convert: id, digits: digits ?? 0 };
    case 'perMin':
      return { unit: '/min', convert: id, digits: digits ?? 1 };
    case 'ms':
      return { unit: 'ms', convert: id, digits: digits ?? 0 };
    case 'fraction':
      return { unit: '%', convert: (v) => v * 100, digits: digits ?? 0 };
    case 'percent':
      return { unit: '%', convert: id, digits: digits ?? 1 };
    case 'mass':
      return imperial
        ? { unit: 'lb', convert: (v) => v / KG_PER_LB, digits: digits ?? 1 }
        : { unit: 'kg', convert: id, digits: digits ?? 1 };
    case 'massG':
      return { unit: 'g', convert: (v) => v * 1000, digits };
    case 'distance':
      return imperial
        ? { unit: 'mi', convert: (v) => v / M_PER_MI, digits: digits ?? 2 }
        : { unit: 'km', convert: (v) => v / M_PER_KM, digits: digits ?? 2 };
    case 'length':
      return imperial
        ? { unit: 'in', convert: (v) => v / 0.0254, digits: digits ?? 1 }
        : { unit: 'cm', convert: (v) => v * 100, digits: digits ?? 1 };
    case 'speed':
      return imperial
        ? { unit: 'mph', convert: (v) => v / (M_PER_MI / 3600), digits: digits ?? 1 }
        : { unit: 'km/h', convert: (v) => v * 3.6, digits: digits ?? 1 };
    case 'meters':
      return imperial
        ? { unit: 'yd', convert: (v) => v / 0.9144, digits: digits ?? 0 }
        : { unit: 'm', convert: id, digits: digits ?? 0 };
    case 'energy':
      return { unit: 'kcal', convert: id, digits: digits ?? 0 };
    case 'minutes':
      return { unit: '', convert: id, digits: 0, duration: 'minutes' };
    case 'seconds':
      return { unit: '', convert: id, digits: 0, duration: 'seconds' };
    case 'temp':
      return imperial
        ? { unit: '°F', convert: (v) => (v * 9) / 5 + 32, digits: digits ?? 1 }
        : { unit: '°C', convert: id, digits: digits ?? 1 };
    case 'decibel':
      return { unit: 'dB', convert: id, digits: digits ?? 0 };
    case 'power':
      return { unit: 'W', convert: id, digits: digits ?? 0 };
    case 'vo2':
      return { unit: 'ml/(kg·min)', convert: id, digits: digits ?? 1 };
    case 'volume':
      return imperial
        ? { unit: 'fl oz', convert: (v) => v * 33.814, digits: digits ?? 1 }
        : { unit: 'L', convert: id, digits: digits ?? 2 };
    case 'pressure':
      return { unit: 'mmHg', convert: id, digits: digits ?? 0 };
    default:
      return { unit: canonicalUnit && canonicalUnit !== 'count' ? canonicalUnit : '', convert: id, digits };
  }
}

/** A sensible number of fraction digits for a displayed magnitude when the spec does not fix one. */
export function autoDigits(v: number): number {
  const a = Math.abs(v);
  if (a >= 100) return 0;
  if (a >= 10) return 1;
  return 2;
}
