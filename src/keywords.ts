/**
 * Keywords derived from a plain question, for callers that give none. The engine was evaluated with
 * keywords chosen by a coding agent (likely identifiers, file-name fragments, config keys, error strings and
 * synonyms), which beat anything derived mechanically; this is a convenience for people typing questions.
 */
import { STOPWORDS } from "./engine/code-search/text";

/** Words that describe the search itself rather than the code. */
const META_WORDS = new Set(
  (
    "where what which how why when who whom whose does did done can could should would will shall " +
    "find show tell explain list give look locate search see check know understand describe " +
    "code codebase repo repository project source file files folder directory module modules " +
    "implemented implementation implement implements defined definition define defines declared " +
    "located handled logic place places part parts happen happens happening live lives " +
    "function functions method methods class classes object objects value values data type types " +
    "name names thing things stuff variable variables call calls called get gets set sets " +
    "return returns returned make made create created run runs used uses work works please"
  ).split(" "),
);

const SUFFIXES = ["ations", "ation", "ings", "ing", "ied", "ies", "ed", "es", "s"];

/** A prefix that matches the word's other forms (classified -> classif, limits -> limit). */
function stemPrefix(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 5) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/** camelCase, snake_case, digits, dotted/kebab/path forms, or ALL CAPS: something that looks like code. */
function looksLikeIdentifier(token: string): boolean {
  return (
    /[a-z][A-Z]/.test(token) ||
    /[_$]/.test(token) ||
    /[A-Za-z][0-9]|[0-9][A-Za-z]/.test(token) ||
    /[.\-:/]/.test(token) ||
    /^\d{3,}$/.test(token) ||
    (/^[A-Z]{3,}$/.test(token) && !STOPWORDS.has(token.toLowerCase()))
  );
}

function isContentWord(word: string): boolean {
  const w = word.toLowerCase();
  return w.length >= 3 && !STOPWORDS.has(w) && !META_WORDS.has(w) && /^[a-z]+$/.test(w);
}

const QUOTED = /`([^`\n]{2,120})`|"([^"\n]{2,120})"|(?:^|\s)'([^'\n]{2,120})'(?=[\s?.!,;:]|$)/g;
const TOKEN = /[A-Za-z_$][A-Za-z0-9_$]*(?:[.\-:/][A-Za-z0-9_$]+)*|\b\d{3,}\b/g;

export interface DeriveKeywordsOptions {
  /** Most keywords returned (default 12; the engine accepts 20). */
  max?: number;
}

/**
 * Keywords for a question: quoted strings verbatim, identifier-like tokens verbatim, adjacent content-word
 * pairs as phrases (the engine searches their camelCase, snake_case and kebab-case forms), then single
 * content words, trimmed to a prefix that matches their other forms. Empty when nothing usable is left.
 */
export function deriveKeywords(question: string, options: DeriveKeywordsOptions = {}): string[] {
  const max = options.max ?? 12;
  const quoted: string[] = [];
  const rest = question.replace(QUOTED, (match, a?: string, b?: string, c?: string) => {
    const q = (a ?? b ?? c ?? "").trim();
    if (q) quoted.push(q);
    return " . ";
  });

  const identifiers: string[] = [];
  const pairs: string[] = [];
  const singles: string[] = [];
  let run: string[] = [];
  const flush = () => {
    for (let i = 0; i + 1 < run.length; i++) pairs.push(`${run[i]} ${run[i + 1]}`);
    run = [];
  };
  let last = 0;
  for (const m of rest.matchAll(TOKEN)) {
    const between = rest.slice(last, m.index);
    last = (m.index ?? 0) + m[0].length;
    // Punctuation other than spaces ends a run of words.
    if (/[^\s]/.test(between)) flush();
    const token = m[0].replace(/[.\-:/]+$/, "");
    if (looksLikeIdentifier(token)) {
      flush();
      identifiers.push(token);
      continue;
    }
    if (isContentWord(token)) {
      const w = token.toLowerCase();
      run.push(w);
      singles.push(stemPrefix(w));
    } else {
      flush();
    }
  }
  flush();

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (k: string, limit: number) => {
    const key = k.toLowerCase();
    if (out.length >= limit || seen.has(key)) return;
    seen.add(key);
    out.push(k);
  };
  for (const k of [...quoted, ...identifiers]) add(k, Math.min(max, 6));
  const beforePairs = out.length;
  for (const k of pairs) add(k, Math.min(max, beforePairs + 3));
  for (const k of singles) add(k, max);
  return out;
}
