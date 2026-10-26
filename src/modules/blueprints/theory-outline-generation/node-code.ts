export function codeFor(values: Map<string, string>, key: string) {
  const existing = values.get(key);
  if (existing) return existing;

  // Use spreadsheet-style uppercase codes: A..Z, AA..AZ, BA...
  // Character-code increments produce punctuation and case-insensitive clashes.
  let ordinal = values.size + 1;
  let code = "";
  while (ordinal > 0) {
    ordinal -= 1;
    code = String.fromCharCode(65 + ordinal % 26) + code;
    ordinal = Math.floor(ordinal / 26);
  }
  values.set(key, code);
  return code;
}
