/**
 * Lightweight language detection (fr / es / en) + voice matching, so the reader
 * speaks a document in its own language instead of a fixed model.
 */
import type { BrowserVoiceInfo } from './voice';

export type Lang = 'fr' | 'es' | 'en';

const STOP: Record<Lang, string[]> = {
  es: ['que', 'de', 'la', 'el', 'los', 'las', 'una', 'por', 'con', 'para', 'está', 'más', 'como', 'pero', 'del', 'su', 'al', 'lo', 'es', 'en', 'un', 'no', 'ha', 'este'],
  fr: ['le', 'la', 'les', 'des', 'une', 'est', 'et', 'dans', 'pour', 'que', 'qui', 'pas', 'sur', 'avec', 'ce', 'au', 'du', 'en', 'un', 'ne', 'se', 'plus', 'être', 'cette'],
  en: ['the', 'and', 'of', 'to', 'in', 'is', 'that', 'for', 'with', 'as', 'are', 'be', 'this', 'it', 'on', 'by', 'an', 'or', 'from', 'at', 'was', 'not', 'have', 'which'],
};

/** Detect the dominant language of a text via stopword frequency + Spanish punctuation. */
export function detectLang(text: string): Lang {
  const sample = text.slice(0, 6000).toLowerCase();
  const words = sample.replace(/[^a-záéíóúñüàâçèéêëîïôùû\s]/gi, ' ').split(/\s+/);
  const score: Record<Lang, number> = { es: 0, fr: 0, en: 0 };
  const sets: Record<Lang, Set<string>> = { es: new Set(STOP.es), fr: new Set(STOP.fr), en: new Set(STOP.en) };
  for (const w of words) {
    if (sets.es.has(w)) score.es++;
    if (sets.fr.has(w)) score.fr++;
    if (sets.en.has(w)) score.en++;
  }
  if (/[¿¡ñ]/.test(sample)) score.es += 12; // strong Spanish signal
  return (['es', 'fr', 'en'] as Lang[]).reduce((best, l) => (score[l] > score[best] ? l : best), 'en');
}

/**
 * Best voice for a language + engine among what's available.
 * - xtts: the language code itself ('fr' | 'es' | 'en')
 * - piper: an installed voice id whose locale matches (es_… / fr_… / en_…)
 * - browser: a system voice whose BCP-47 lang starts with the code
 * Returns null when nothing matches (caller keeps the current/seeded voice).
 */
export function pickVoiceForLang(
  engine: 'browser' | 'piper' | 'xtts',
  lang: Lang,
  opts: { browser: BrowserVoiceInfo[]; piper: string[] },
): string | null {
  if (engine === 'xtts') return lang;
  if (engine === 'piper') {
    const pref = lang === 'es' ? 'es_' : lang === 'en' ? 'en_' : 'fr_';
    return opts.piper.find(v => v.toLowerCase().startsWith(pref)) ?? null;
  }
  const match = opts.browser.find(v => v.lang.toLowerCase().startsWith(lang));
  return match?.id ?? null;
}
