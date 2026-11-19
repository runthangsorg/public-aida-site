// Reads rules out of a stylesheet as text, for tests that guard what the stylesheet decides.

/**
 * The declaration blocks of every rule, inside media (or container) queries or not, whose selector list is exactly
 * `selector` (whitespace and comments ignored). With `media`, only rules inside an @media or @container whose
 * condition contains it.
 */
export function rules(css: string, selector: string, media?: string): string[] {
  const want = selector.replace(/\s+/g, " ").trim();
  const out: string[] = [];
  const scan = (text: string, inMedia: string | null): void => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open < 0) return;
      const head = text.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
      // Find the matching close brace.
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith("@media") || head.startsWith("@container")) scan(body, head);
      else if (head === want && (media === undefined || (inMedia ?? "").includes(media))) out.push(body);
      i = j;
    }
  };
  scan(css, null);
  return out;
}

/** The value of one property in a declaration block, or undefined. */
export function prop(body: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+);`).exec(body);
  return m?.[1]?.trim();
}
