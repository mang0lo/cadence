/**
 * Sport catalogue. Apple Health reports ~80 HKWorkoutActivityType values; we map every one of them
 * to a stable, lowercase sport key that the whole app (server analytics + UI) uses.
 */

export type SportGroup = 'foot' | 'cycle' | 'water' | 'winter' | 'gym' | 'mind' | 'team' | 'racket' | 'other';

/** How speed is best presented for a sport. */
export type SpeedMode = 'pace' | 'speed' | 'pace100' | 'none';

export interface SportInfo {
  key: string;
  label: { en: string; de: string };
  group: SportGroup;
  /** Whether distance is meaningful (and usually recorded) for this sport. */
  distance: boolean;
  speedMode: SpeedMode;
  /** lucide-react icon name used by the UI. */
  icon: string;
}

const s = (
  key: string,
  en: string,
  de: string,
  group: SportGroup,
  distance: boolean,
  speedMode: SpeedMode,
  icon: string,
): SportInfo => ({ key, label: { en, de }, group, distance, speedMode, icon });

export const SPORTS: Record<string, SportInfo> = Object.fromEntries(
  [
    s('run', 'Run', 'Lauf', 'foot', true, 'pace', 'Footprints'),
    s('walk', 'Walk', 'Spaziergang', 'foot', true, 'pace', 'PersonStanding'),
    s('hike', 'Hike', 'Wanderung', 'foot', true, 'pace', 'Mountain'),
    s('wheelchair', 'Wheelchair', 'Rollstuhl', 'foot', true, 'speed', 'Accessibility'),
    s('ride', 'Ride', 'Radfahrt', 'cycle', true, 'speed', 'Bike'),
    s('handcycle', 'Handcycle', 'Handbike', 'cycle', true, 'speed', 'Bike'),
    s('swim', 'Swim', 'Schwimmen', 'water', true, 'pace100', 'Waves'),
    s('row', 'Row', 'Rudern', 'water', true, 'pace', 'Sailboat'),
    s('paddle', 'Paddle', 'Paddeln', 'water', true, 'speed', 'Sailboat'),
    s('sail', 'Sail', 'Segeln', 'water', true, 'speed', 'Sailboat'),
    s('surf', 'Surf', 'Surfen', 'water', false, 'none', 'Waves'),
    s('water_fitness', 'Water Fitness', 'Wasserfitness', 'water', false, 'none', 'Waves'),
    s('water_sports', 'Water Sports', 'Wassersport', 'water', false, 'none', 'Waves'),
    s('diving', 'Diving', 'Tauchen', 'water', false, 'none', 'Waves'),
    s('alpine_ski', 'Alpine Ski', 'Ski Alpin', 'winter', true, 'speed', 'MountainSnow'),
    s('nordic_ski', 'Nordic Ski', 'Langlauf', 'winter', true, 'speed', 'MountainSnow'),
    s('snowboard', 'Snowboard', 'Snowboard', 'winter', true, 'speed', 'MountainSnow'),
    s('snow_sports', 'Snow Sports', 'Wintersport', 'winter', false, 'none', 'Snowflake'),
    s('skate', 'Skate', 'Skaten', 'winter', true, 'speed', 'Snowflake'),
    s('elliptical', 'Elliptical', 'Crosstrainer', 'gym', false, 'none', 'Activity'),
    s('stair_climbing', 'Stair Climbing', 'Treppensteigen', 'gym', false, 'none', 'TrendingUp'),
    s('strength', 'Strength Training', 'Krafttraining', 'gym', false, 'none', 'Dumbbell'),
    s('functional_strength', 'Functional Strength', 'Funktionelles Krafttraining', 'gym', false, 'none', 'Dumbbell'),
    s('core', 'Core Training', 'Core-Training', 'gym', false, 'none', 'Dumbbell'),
    s('hiit', 'HIIT', 'HIIT', 'gym', false, 'none', 'Zap'),
    s('cross_training', 'Cross Training', 'Cross-Training', 'gym', false, 'none', 'Zap'),
    s('mixed_cardio', 'Mixed Cardio', 'Gemischtes Cardio', 'gym', false, 'none', 'HeartPulse'),
    s('jump_rope', 'Jump Rope', 'Seilspringen', 'gym', false, 'none', 'Zap'),
    s('climb', 'Climbing', 'Klettern', 'gym', false, 'none', 'Mountain'),
    s('fitness_gaming', 'Fitness Gaming', 'Fitness-Gaming', 'gym', false, 'none', 'Gamepad2'),
    s('yoga', 'Yoga', 'Yoga', 'mind', false, 'none', 'Flower2'),
    s('pilates', 'Pilates', 'Pilates', 'mind', false, 'none', 'Flower2'),
    s('barre', 'Barre', 'Barre', 'mind', false, 'none', 'Flower2'),
    s('tai_chi', 'Tai Chi', 'Tai Chi', 'mind', false, 'none', 'Flower2'),
    s('mind_body', 'Mind & Body', 'Körper & Geist', 'mind', false, 'none', 'Flower2'),
    s('flexibility', 'Flexibility', 'Beweglichkeit', 'mind', false, 'none', 'StretchHorizontal'),
    s('cooldown', 'Cooldown', 'Cooldown', 'mind', false, 'none', 'Snowflake'),
    s('recovery', 'Recovery', 'Regeneration', 'mind', false, 'none', 'BedDouble'),
    s('dance', 'Dance', 'Tanzen', 'mind', false, 'none', 'Music'),
    s('martial_arts', 'Martial Arts', 'Kampfsport', 'gym', false, 'none', 'Swords'),
    s('boxing', 'Boxing', 'Boxen', 'gym', false, 'none', 'Swords'),
    s('kickboxing', 'Kickboxing', 'Kickboxen', 'gym', false, 'none', 'Swords'),
    s('wrestling', 'Wrestling', 'Ringen', 'gym', false, 'none', 'Swords'),
    s('fencing', 'Fencing', 'Fechten', 'gym', false, 'none', 'Swords'),
    s('gymnastics', 'Gymnastics', 'Turnen', 'gym', false, 'none', 'PersonStanding'),
    s('soccer', 'Soccer', 'Fußball', 'team', false, 'none', 'Trophy'),
    s('basketball', 'Basketball', 'Basketball', 'team', false, 'none', 'Trophy'),
    s('volleyball', 'Volleyball', 'Volleyball', 'team', false, 'none', 'Trophy'),
    s('handball', 'Handball', 'Handball', 'team', false, 'none', 'Trophy'),
    s('hockey', 'Hockey', 'Hockey', 'team', false, 'none', 'Trophy'),
    s('american_football', 'American Football', 'American Football', 'team', false, 'none', 'Trophy'),
    s('australian_football', 'Australian Football', 'Australian Football', 'team', false, 'none', 'Trophy'),
    s('rugby', 'Rugby', 'Rugby', 'team', false, 'none', 'Trophy'),
    s('lacrosse', 'Lacrosse', 'Lacrosse', 'team', false, 'none', 'Trophy'),
    s('baseball', 'Baseball', 'Baseball', 'team', false, 'none', 'Trophy'),
    s('softball', 'Softball', 'Softball', 'team', false, 'none', 'Trophy'),
    s('cricket', 'Cricket', 'Cricket', 'team', false, 'none', 'Trophy'),
    s('water_polo', 'Water Polo', 'Wasserball', 'team', false, 'none', 'Trophy'),
    s('disc_sports', 'Disc Sports', 'Frisbee', 'team', false, 'none', 'Trophy'),
    s('tennis', 'Tennis', 'Tennis', 'racket', false, 'none', 'Trophy'),
    s('table_tennis', 'Table Tennis', 'Tischtennis', 'racket', false, 'none', 'Trophy'),
    s('badminton', 'Badminton', 'Badminton', 'racket', false, 'none', 'Trophy'),
    s('squash', 'Squash', 'Squash', 'racket', false, 'none', 'Trophy'),
    s('racquetball', 'Racquetball', 'Racquetball', 'racket', false, 'none', 'Trophy'),
    s('pickleball', 'Pickleball', 'Pickleball', 'racket', false, 'none', 'Trophy'),
    s('golf', 'Golf', 'Golf', 'other', true, 'none', 'Flag'),
    s('equestrian', 'Equestrian', 'Reiten', 'other', true, 'speed', 'Flag'),
    s('archery', 'Archery', 'Bogenschießen', 'other', false, 'none', 'Target'),
    s('bowling', 'Bowling', 'Bowling', 'other', false, 'none', 'Target'),
    s('curling', 'Curling', 'Curling', 'other', false, 'none', 'Target'),
    s('fishing', 'Fishing', 'Angeln', 'other', false, 'none', 'Fish'),
    s('hunting', 'Hunting', 'Jagen', 'other', false, 'none', 'Target'),
    s('play', 'Play', 'Spielen', 'other', false, 'none', 'Smile'),
    s('track_and_field', 'Track & Field', 'Leichtathletik', 'foot', false, 'none', 'Timer'),
    s('multisport', 'Multisport', 'Multisport', 'other', true, 'speed', 'Medal'),
    s('transition', 'Transition', 'Wechsel', 'other', false, 'none', 'Repeat'),
    s('other', 'Workout', 'Training', 'other', false, 'none', 'Activity'),
  ].map((x) => [x.key, x]),
);

/** HKWorkoutActivityType suffix (without the `HKWorkoutActivityType` prefix) → sport key. */
const HK_TO_SPORT: Record<string, string> = {
  Running: 'run',
  Walking: 'walk',
  Hiking: 'hike',
  WheelchairWalkPace: 'wheelchair',
  WheelchairRunPace: 'wheelchair',
  Cycling: 'ride',
  HandCycling: 'handcycle',
  Swimming: 'swim',
  Rowing: 'row',
  PaddleSports: 'paddle',
  Sailing: 'sail',
  SurfingSports: 'surf',
  WaterFitness: 'water_fitness',
  WaterSports: 'water_sports',
  UnderwaterDiving: 'diving',
  DownhillSkiing: 'alpine_ski',
  CrossCountrySkiing: 'nordic_ski',
  Snowboarding: 'snowboard',
  SnowSports: 'snow_sports',
  SkatingSports: 'skate',
  Elliptical: 'elliptical',
  StairClimbing: 'stair_climbing',
  Stairs: 'stair_climbing',
  StepTraining: 'stair_climbing',
  TraditionalStrengthTraining: 'strength',
  FunctionalStrengthTraining: 'functional_strength',
  CoreTraining: 'core',
  HighIntensityIntervalTraining: 'hiit',
  CrossTraining: 'cross_training',
  MixedCardio: 'mixed_cardio',
  MixedMetabolicCardioTraining: 'mixed_cardio',
  JumpRope: 'jump_rope',
  Climbing: 'climb',
  FitnessGaming: 'fitness_gaming',
  Yoga: 'yoga',
  Pilates: 'pilates',
  Barre: 'barre',
  TaiChi: 'tai_chi',
  MindAndBody: 'mind_body',
  Flexibility: 'flexibility',
  Cooldown: 'cooldown',
  PreparationAndRecovery: 'recovery',
  Dance: 'dance',
  DanceInspiredTraining: 'dance',
  CardioDance: 'dance',
  SocialDance: 'dance',
  MartialArts: 'martial_arts',
  Boxing: 'boxing',
  Kickboxing: 'kickboxing',
  Wrestling: 'wrestling',
  Fencing: 'fencing',
  Gymnastics: 'gymnastics',
  Soccer: 'soccer',
  Basketball: 'basketball',
  Volleyball: 'volleyball',
  Handball: 'handball',
  Hockey: 'hockey',
  AmericanFootball: 'american_football',
  AustralianFootball: 'australian_football',
  Rugby: 'rugby',
  Lacrosse: 'lacrosse',
  Baseball: 'baseball',
  Softball: 'softball',
  Cricket: 'cricket',
  WaterPolo: 'water_polo',
  DiscSports: 'disc_sports',
  Tennis: 'tennis',
  TableTennis: 'table_tennis',
  Badminton: 'badminton',
  Squash: 'squash',
  Racquetball: 'racquetball',
  Pickleball: 'pickleball',
  Golf: 'golf',
  EquestrianSports: 'equestrian',
  Archery: 'archery',
  Bowling: 'bowling',
  Curling: 'curling',
  Fishing: 'fishing',
  Hunting: 'hunting',
  Play: 'play',
  TrackAndField: 'track_and_field',
  SwimBikeRun: 'multisport',
  Transition: 'transition',
  Other: 'other',
};

/** Map a raw `HKWorkoutActivityType…` value to a sport key (unknown types become `other`). */
export function sportFromActivityType(activityType: string): string {
  const suffix = activityType.replace(/^HKWorkoutActivityType/, '');
  return HK_TO_SPORT[suffix] ?? 'other';
}

export function sportInfo(key: string): SportInfo {
  return SPORTS[key] ?? SPORTS.other!;
}

/** Sports for which GPS best efforts (fastest 1k, 5k, …) are computed. */
export const BEST_EFFORT_SPORTS = ['run', 'ride', 'walk', 'hike', 'swim', 'row', 'nordic_ski'] as const;

export interface EffortDefinition {
  key: string;
  distanceM: number;
  label: { en: string; de: string };
}

/** Distance-based best efforts per sport. */
export const BEST_EFFORTS: Record<string, EffortDefinition[]> = {
  run: [
    { key: '400m', distanceM: 400, label: { en: '400 m', de: '400 m' } },
    { key: '1/2mi', distanceM: 804.672, label: { en: '½ mile', de: '½ Meile' } },
    { key: '1k', distanceM: 1000, label: { en: '1K', de: '1 km' } },
    { key: '1mi', distanceM: 1609.344, label: { en: '1 mile', de: '1 Meile' } },
    { key: '2mi', distanceM: 3218.688, label: { en: '2 mile', de: '2 Meilen' } },
    { key: '5k', distanceM: 5000, label: { en: '5K', de: '5 km' } },
    { key: '10k', distanceM: 10000, label: { en: '10K', de: '10 km' } },
    { key: '15k', distanceM: 15000, label: { en: '15K', de: '15 km' } },
    { key: '10mi', distanceM: 16093.44, label: { en: '10 mile', de: '10 Meilen' } },
    { key: '20k', distanceM: 20000, label: { en: '20K', de: '20 km' } },
    { key: 'half', distanceM: 21097.5, label: { en: 'Half Marathon', de: 'Halbmarathon' } },
    { key: '30k', distanceM: 30000, label: { en: '30K', de: '30 km' } },
    { key: 'marathon', distanceM: 42195, label: { en: 'Marathon', de: 'Marathon' } },
    { key: '50k', distanceM: 50000, label: { en: '50K', de: '50 km' } },
  ],
  ride: [
    { key: '5k', distanceM: 5000, label: { en: '5K', de: '5 km' } },
    { key: '10k', distanceM: 10000, label: { en: '10K', de: '10 km' } },
    { key: '20k', distanceM: 20000, label: { en: '20K', de: '20 km' } },
    { key: '40k', distanceM: 40000, label: { en: '40K', de: '40 km' } },
    { key: '50k', distanceM: 50000, label: { en: '50K', de: '50 km' } },
    { key: '80k', distanceM: 80000, label: { en: '80K', de: '80 km' } },
    { key: '100k', distanceM: 100000, label: { en: '100K', de: '100 km' } },
    { key: '160k', distanceM: 160934.4, label: { en: '100 mile', de: '100 Meilen' } },
  ],
  walk: [
    { key: '1k', distanceM: 1000, label: { en: '1K', de: '1 km' } },
    { key: '5k', distanceM: 5000, label: { en: '5K', de: '5 km' } },
    { key: '10k', distanceM: 10000, label: { en: '10K', de: '10 km' } },
  ],
  hike: [
    { key: '1k', distanceM: 1000, label: { en: '1K', de: '1 km' } },
    { key: '5k', distanceM: 5000, label: { en: '5K', de: '5 km' } },
    { key: '10k', distanceM: 10000, label: { en: '10K', de: '10 km' } },
    { key: '20k', distanceM: 20000, label: { en: '20K', de: '20 km' } },
  ],
  swim: [
    { key: '100m', distanceM: 100, label: { en: '100 m', de: '100 m' } },
    { key: '400m', distanceM: 400, label: { en: '400 m', de: '400 m' } },
    { key: '1k', distanceM: 1000, label: { en: '1K', de: '1 km' } },
    { key: '1500m', distanceM: 1500, label: { en: '1500 m', de: '1500 m' } },
  ],
  row: [
    { key: '500m', distanceM: 500, label: { en: '500 m', de: '500 m' } },
    { key: '2k', distanceM: 2000, label: { en: '2K', de: '2 km' } },
    { key: '5k', distanceM: 5000, label: { en: '5K', de: '5 km' } },
  ],
  nordic_ski: [
    { key: '5k', distanceM: 5000, label: { en: '5K', de: '5 km' } },
    { key: '10k', distanceM: 10000, label: { en: '10K', de: '10 km' } },
  ],
};
