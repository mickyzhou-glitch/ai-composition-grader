/**
 * Tolerant extraction of the one JSON object a model was asked for.
 *
 * Content models regularly wrap the object in prose or markdown fences, and
 * they break strings with raw newlines, unescaped double quotes, full-width
 * punctuation or trailing commas — most often inside the long Chinese
 * `advice` and `revisedText` values the review prompts ask for. Every repair
 * here runs only after strict parsing has already failed, so valid JSON is
 * returned untouched.
 *
 * This module has no imports on purpose: both AI adapters depend on it.
 */

/** Strip a markdown fence, including the unclosed one models emit when they run long. */
function stripJsonWrapper(content: string): string {
  const text = content.replace(/^\uFEFF/u, "").trim();
  const fenced = text.match(/```[a-zA-Z]*\s*([\s\S]*?)\s*```/u);
  if (fenced?.[1]?.includes("{")) return fenced[1].trim();
  return text.replace(/^```[a-zA-Z]*\s*/u, "").replace(/\s*```$/u, "").trim();
}

/**
 * Take the first brace-balanced object, ignoring braces inside strings, so
 * prose before and after the object is dropped.
 */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && (depth -= 1) === 0) return text.slice(start, index + 1);
  }
  return null;
}

/** Fallback span for an object whose braces never balance, such as a truncated answer. */
function widestObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const end = text.lastIndexOf("}");
  return end > start ? text.slice(start, end + 1) : text.slice(start);
}

/** Strip markdown fences and any prose around the outermost JSON object. */
export function cleanJsonResponse(content: string): string {
  const text = stripJsonWrapper(content);
  return firstBalancedObject(text) ?? widestObject(text) ?? text;
}

const JSON_ESCAPES = new Set(["\"", "\\", "/", "b", "f", "n", "r", "t"]);
const CONTROL_ESCAPES: Record<string, string> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\f": "\\f",
  "\b": "\\b",
};
// Models type these out of habit where JSON needs the ASCII form.
const FULL_WIDTH_STRUCTURE: Record<string, string> = { "，": ",", "：": ":" };
const OPENING_QUOTES: Record<string, string> = { "\"": "\"", "“": "”", "”": "”" };

/** A closing quote is only real when a separator, not more prose, follows it. */
function closesString(text: string, index: number): boolean {
  let next = index + 1;
  while (next < text.length && /\s/u.test(text[next]!)) next += 1;
  if (next >= text.length) return true;
  const char = text[next]!;
  if (char === "}" || char === "]" || char === ":" || char === "：") return true;
  if (char !== "," && char !== "，") return false;
  let after = next + 1;
  while (after < text.length && /\s/u.test(text[after]!)) after += 1;
  if (after >= text.length) return true;
  // A separator only ends the string when a fresh key or value follows it;
  // otherwise the quote sits inside the sentence, as in 他说"好",我笑了.
  return /^(?:["“}\]{[\d-]|true|false|null)/u.test(text.slice(after));
}

/**
 * Re-emit a model answer as strict JSON: escape raw control characters, stray
 * double quotes and invalid escapes inside strings, and normalise comments,
 * trailing commas, full-width separators and full-width string delimiters.
 */
function repairJsonText(text: string): string {
  let output = "";
  let delimiter: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (delimiter === null) {
      const opening = OPENING_QUOTES[char];
      if (opening) {
        delimiter = opening;
        output += "\"";
      } else if (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
        const close = text[index + 1] === "/" ? "\n" : "*/";
        const end = text.indexOf(close, index + 2);
        index = end < 0 ? text.length : end + close.length - 1;
      } else if (char === "," || char === "，") {
        let next = index + 1;
        while (next < text.length && /\s/u.test(text[next]!)) next += 1;
        if (text[next] !== "}" && text[next] !== "]") output += ",";
      } else {
        output += FULL_WIDTH_STRUCTURE[char] ?? char;
      }
      continue;
    }
    if (char === "\\") {
      const next = text[index + 1];
      const unicode = next === "u" && /^[0-9a-fA-F]{4}/u.test(text.slice(index + 2, index + 6));
      if (next !== undefined && (JSON_ESCAPES.has(next) || unicode)) {
        output += char + next;
        index += 1;
      } else {
        output += "\\\\";
      }
      continue;
    }
    if (char === delimiter) {
      if (closesString(text, index)) {
        delimiter = null;
        output += "\"";
      } else {
        // A full-width quote that does not end the string is prose; keep it as written.
        output += char === "\"" ? "\\\"" : char;
      }
      continue;
    }
    // A plain quote inside a full-width delimited string still needs escaping.
    if (char === "\"") {
      output += "\\\"";
      continue;
    }
    const control = CONTROL_ESCAPES[char];
    if (control) output += control;
    else if (char >= " ") output += char;
  }
  return output;
}

function jsonCandidates(content: string): string[] {
  const stripped = stripJsonWrapper(content);
  const candidates = [content.trim(), stripped, firstBalancedObject(stripped), widestObject(stripped)];
  return [...new Set(candidates.filter((value): value is string => Boolean(value)))];
}

export type JsonParseAttempt =
  | { ok: true; value: unknown }
  | { ok: false; error: SyntaxError };

/**
 * Parse a model answer without throwing. Every candidate extraction is tried
 * as written first, then after the repair pass.
 */
export function tryParseJsonResponse(content: string): JsonParseAttempt {
  let lastError = new SyntaxError("model response contains no JSON object");
  for (const candidate of jsonCandidates(content)) {
    for (const text of new Set([candidate, repairJsonText(candidate)])) {
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        lastError = error;
      }
    }
  }
  return { ok: false, error: lastError };
}

export function parseJsonResponse(content: string): unknown {
  const attempt = tryParseJsonResponse(content);
  if (attempt.ok) return attempt.value;
  throw attempt.error;
}

/** Reminder appended to the one automatic re-ask after an unparseable answer. */
export const JSON_RETRY_INSTRUCTION = [
  "上一次回答无法解析为 JSON。请重新回答同一个任务，只输出一个完整的 JSON 对象。",
  "不要 Markdown 围栏，不要任何解释文字，对象前后不得有多余内容。",
  "字符串内的换行必须写成 \\n；字符串内的双引号必须写成 \\\"；不得用中文引号代替 JSON 的引号；不得出现注释或结尾逗号。",
].join("\n");
