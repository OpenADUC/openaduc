// SPDX-License-Identifier: BUSL-1.1

/** Words in a sentence: "a", "a and b", "a, b and c". */
export function andList(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}
