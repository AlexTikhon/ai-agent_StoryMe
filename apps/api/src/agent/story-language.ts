/** Conservative prose classifier, not a fluency/translation judge. Short or ambiguous
 * Latin-script samples return unknown. Names and borrowed words are tolerated. */
export function detectStoryLanguage(text: string): 'en' | 'ru' | 'pl' | 'unknown' {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 80) return 'unknown';
  const cyrillic = letters.filter((letter) => /\p{Script=Cyrillic}/u.test(letter)).length;
  if (cyrillic / letters.length > 0.55) return 'ru';
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const en = new Set([
    'the',
    'and',
    'was',
    'with',
    'her',
    'his',
    'they',
    'she',
    'he',
    'their',
    'that',
    'this',
    'but',
  ]);
  const pl = new Set([
    'się',
    'nie',
    'jest',
    'był',
    'była',
    'ale',
    'jego',
    'jej',
    'przez',
    'który',
    'razem',
    'gdy',
    'już',
    'więc',
  ]);
  const english = words.filter((word) => en.has(word)).length;
  const polish = words.filter((word) => pl.has(word)).length;
  if (english >= 8 && english > polish * 3) return 'en';
  if (polish >= 8 && polish > english * 3) return 'pl';
  return 'unknown';
}

const LESSONS = {
  sharing: [
    'Sharing is caring',
    'Делиться — значит заботиться',
    'Dzielenie się jest wyrazem troski',
  ],
  mistakes: ['It is okay to make mistakes', 'Ошибаться — это нормально', 'Można popełniać błędy'],
  patience: ['Patience', 'Терпение', 'Cierpliwość'],
} as const;
const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
export function resolveLesson(text: string) {
  for (const [id, translations] of Object.entries(LESSONS)) {
    if (
      text === `lesson:${id}` ||
      translations.some((value) => normalize(value) === normalize(text))
    ) {
      return { kind: 'predefined' as const, id, translations };
    }
  }
  return { kind: 'free_text' as const, text };
}

export function localizeLesson(text: string, language: string): string {
  const lesson = resolveLesson(text);
  if (lesson.kind === 'free_text') return text;
  return lesson.translations[language === 'ru' ? 1 : language === 'pl' ? 2 : 0];
}
