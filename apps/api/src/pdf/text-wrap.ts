/**
 * Splits text into lines that fit within maxCharsPerLine.
 * Preserves explicit newline characters as hard line breaks.
 * Words longer than maxCharsPerLine are placed on their own line without truncation.
 */
export function wrapText(text: string, maxCharsPerLine: number): string[] {
  if (maxCharsPerLine < 1) return [text];

  const result: string[] = [];

  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);

    if (words.length === 0) {
      result.push('');
      continue;
    }

    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= maxCharsPerLine) {
        current = candidate;
      } else {
        if (current) result.push(current);
        current = word;
      }
    }
    if (current) result.push(current);
  }

  return result;
}
