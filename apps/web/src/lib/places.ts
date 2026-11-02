import type { WorkoutSummary } from '@cadence/shared';
import type { Lang } from './i18n';

/**
 * German names of places that GeoNames lists under their English name (most places already carry their local
 * name: Köln, Hannover, Zürich …).
 */
const DE_NAMES: Record<string, string> = {
  Vienna: 'Wien',
  Munich: 'München',
  Nuremberg: 'Nürnberg',
  Cologne: 'Köln',
  Prague: 'Prag',
  Warsaw: 'Warschau',
  Rome: 'Rom',
  Milan: 'Mailand',
  Venice: 'Venedig',
  Naples: 'Neapel',
  Florence: 'Florenz',
  Turin: 'Turin',
  Copenhagen: 'Kopenhagen',
  Brussels: 'Brüssel',
  Lisbon: 'Lissabon',
  Moscow: 'Moskau',
  Athens: 'Athen',
  Bucharest: 'Bukarest',
  Belgrade: 'Belgrad',
  Kyiv: 'Kiew',
  Luxembourg: 'Luxemburg',
  'The Hague': 'Den Haag',
  Antwerp: 'Antwerpen',
  Gothenburg: 'Göteborg',
  Geneva: 'Genf',
  Nice: 'Nizza',
  Strasbourg: 'Straßburg',
  Seville: 'Sevilla',
  Krakow: 'Krakau',
  Gdansk: 'Danzig',
  Bruges: 'Brügge',
  Ghent: 'Gent',
  Mexico: 'Mexiko-Stadt',
};

/** A place name in the UI language. */
export const placeName = (name: string, lang: Lang): string => (lang === 'de' ? (DE_NAMES[name] ?? name) : name);

/** Where an activity took place: "Warnemünde", or "Rostock → Berlin" for a one-way activity; null without GPS. */
export function activityPlace(w: Pick<WorkoutSummary, 'place' | 'placeEnd'>, lang: Lang): string | null {
  if (!w.place) return null;
  const from = placeName(w.place, lang);
  return w.placeEnd ? `${from} → ${placeName(w.placeEnd, lang)}` : from;
}
