const NAMED = new Set(["nbsp", "ensp", "emsp", "thinsp", "ZeroWidthSpace"]);

/**
 * Whether Markdown has anything to read. The editor serializes empty lines as
 * whitespace entities such as `&#x20;`, which `trim()` does not remove.
 */
export function hasVisibleText(markdown: string): boolean {
  const text = markdown
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (NAMED.has(name)) return " ";
      const code = /^#x/i.test(name)
        ? Number.parseInt(name.slice(2), 16)
        : /^#\d/.test(name)
          ? Number.parseInt(name.slice(1), 10)
          : NaN;
      return Number.isNaN(code) ? entity : String.fromCodePoint(code);
    })
    .replace(new RegExp("[\u200b-\u200d\u2060\ufeff]", "g"), "");
  return text.trim().length > 0;
}
