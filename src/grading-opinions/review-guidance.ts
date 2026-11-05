import {
  guidanceWithStandingOpinions,
  paragraphLabelFromText,
  STANDING_GUIDANCE_HEADER,
  type StandingOpinionInput,
} from "./standing-guidance";

interface GuidanceLayers { current: string; history: string; standing: string }
interface StoredGuidanceLayers extends GuidanceLayers {
  /** Number of oldest whole sentences dropped only because the stored guidance exceeded its budget. */
  omitted: number;
  /** YYYY-MM-DD (Asia/Shanghai) of the current submission, when known. */
  currentDate: string;
  format: "v1" | "v2" | "plain";
}

const PREFIX_V1 = "review-guidance-v1:";
const PREFIX_V2 = "review-guidance-v2:";

/**
 * Soft budget for the stored guidance. It only applies to the merged essay history:
 * duplicates are removed first, then the oldest whole sentences. Sentences are never cut.
 */
export const MAX_REVIEW_GUIDANCE_CHARS = 12_000;

export const ESSAY_REQUIREMENTS_PRECEDENCE = "以下全部有效；同一事项前后矛盾时以日期较新的为准。";

export interface MergedEssayRequirement {
  text: string;
  /** YYYY-MM-DD in Asia/Shanghai, or 日期未知 for rows without a timestamp. */
  date: string;
  createdAt: number;
}

export interface MergedEssayRequirements {
  items: MergedEssayRequirement[];
  /** Sentences removed because an identical or containing newer sentence exists. */
  deduplicated: number;
  /** Older sentences superseded by a newer, programmatically comparable requirement. */
  superseded: number;
  /** Oldest whole sentences dropped to fit the budget. */
  omitted: number;
}

const SENTENCE_END = /[。！？；!?;]/u;
const SECTION_HEADER = /^\[[^\]\n]+\]$/u;
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Asia/Shanghai has no daylight saving time, so a fixed offset is exact. */
export function shanghaiDate(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return "日期未知";
  return new Date(epochMs + CHINA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Split on line breaks and sentence-final punctuation (。！？；), keeping the terminator. */
export function splitRequirementSentences(text: string): string[] {
  const sentences: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || SECTION_HEADER.test(trimmedLine)) continue;
    let buffer = "";
    for (const char of trimmedLine) {
      buffer += char;
      if (SENTENCE_END.test(char)) {
        if (normalizeRequirement(buffer)) sentences.push(buffer.trim());
        buffer = "";
      }
    }
    if (normalizeRequirement(buffer)) sentences.push(buffer.trim());
  }
  return sentences;
}

/** Full-width/half-width unified, whitespace and punctuation removed. */
export function normalizeRequirement(text: string): string {
  return text.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "").toLocaleLowerCase("zh-CN");
}

const COUNT = "([一二两三四五六七八九十]|10|[1-9])";
const PARAGRAPH_COUNT = new RegExp(
  `(?:^|[^第\\d])${COUNT}(?:段式|个(?:自然段|段落))|(?:分成|分为|改成|改为|写成|调整为|共)\\s*${COUNT}\\s*(?:个)?(?:自然)?段`,
  "u",
);
const LOWER_WORDS = /(?:至少|不少于|不低于|多于)\s*\d+\s*(?:个)?字|\d+\s*(?:个)?字以上/u;
const UPPER_WORDS = /(?:最多|不超过|不多于|少于|控制在)\s*\d+\s*(?:个)?字|\d+\s*(?:个)?字以内/u;

/**
 * Keys for requirements whose conflicts can be decided by code: the paragraph count, and the
 * lower/upper word limit of the same paragraph label (or the whole essay).
 */
function conflictKeys(sentence: string, opinion: Pick<StandingOpinionInput, "paragraphLabel">): string[] {
  const label = paragraphLabelFromText(sentence) ?? (opinion.paragraphLabel?.trim() || "全文");
  const keys: string[] = [];
  if (PARAGRAPH_COUNT.test(sentence)) keys.push("全文|结构|段数");
  if (LOWER_WORDS.test(sentence)) keys.push(`${label}|字数|下限`);
  if (UPPER_WORDS.test(sentence)) keys.push(`${label}|字数|上限`);
  return keys;
}

interface Candidate {
  text: string;
  norm: string;
  createdAt: number;
  keys: string[];
  current: boolean;
}

/**
 * Merge every essay-scoped opinion of one review, old to new. Identical sentences keep only the
 * newest copy; a sentence fully contained in a newer one is replaced by it; comparable conflicts
 * keep the newest. Sentences already present in the current submission are left to it.
 */
export function mergeEssayRequirements(
  history: readonly StandingOpinionInput[],
  current?: string | null,
  options: { maxChars?: number } = {},
): MergedEssayRequirements {
  const ordered = history
    .map((item, index) => ({ item, index }))
    // Rows arrive newest first; for equal timestamps keep the reverse of that order (oldest first).
    .sort((left, right) => left.item.createdAt - right.item.createdAt || right.index - left.index)
    .map(({ item }) => item);
  const candidates: Candidate[] = [];
  for (const opinion of ordered) {
    for (const text of splitRequirementSentences(opinion.text)) {
      candidates.push({ text, norm: normalizeRequirement(text), createdAt: opinion.createdAt, keys: conflictKeys(text, opinion), current: false });
    }
  }
  for (const text of splitRequirementSentences(current ?? "")) {
    candidates.push({ text, norm: normalizeRequirement(text), createdAt: Number.POSITIVE_INFINITY, keys: conflictKeys(text, {}), current: true });
  }

  let deduplicated = 0;
  let superseded = 0;
  const kept: Candidate[] = [];
  candidates.forEach((candidate, index) => {
    if (candidate.current) return;
    const later = candidates.slice(index + 1);
    const covered = later.some((next) => next.norm === candidate.norm
      || (candidate.norm.length >= 2 && next.norm.includes(candidate.norm)));
    if (covered) {
      deduplicated += 1;
      return;
    }
    const laterKeys = new Set(later.flatMap((next) => next.keys));
    if (candidate.keys.length > 0 && candidate.keys.every((key) => laterKeys.has(key))) {
      superseded += 1;
      return;
    }
    kept.push(candidate);
  });

  const items = kept.map(({ text, createdAt }) => ({ text, createdAt, date: shanghaiDate(createdAt) }));
  let omitted = 0;
  const maxChars = options.maxChars ?? Number.POSITIVE_INFINITY;
  while (items.length > 0 && formatEssayRequirements(items).length > maxChars) {
    items.shift();
    omitted += 1;
  }
  return { items, deduplicated, superseded, omitted };
}

export function formatEssayRequirements(items: readonly MergedEssayRequirement[]): string {
  return items.map((item) => `[${item.date}] ${item.text}`).join("\n");
}

/**
 * Store the current submission, the merged essay history (all effective, dated) and the
 * standing rules for the same title as one structured guidance string.
 */
export function composeReviewGuidance(
  current: string | null | undefined,
  standing: readonly StandingOpinionInput[],
  history: readonly StandingOpinionInput[],
  options: { now?: number; maxChars?: number } = {},
): string | null {
  const currentText = current?.trim() ?? "";
  const standingText = guidanceWithStandingOpinions(null, standing) ?? "";
  const maxChars = options.maxChars ?? MAX_REVIEW_GUIDANCE_CHARS;
  const base = (history: string, omitted: number) => PREFIX_V2 + JSON.stringify({
    current: currentText,
    history,
    standing: standingText,
    omitted,
    currentDate: currentText ? shanghaiDate(options.now ?? Date.now()) : "",
  });
  const fixedLength = base("", 0).length;
  const merged = mergeEssayRequirements(history, currentText, { maxChars: Math.max(0, maxChars - fixedLength - 16) });
  const historyText = formatEssayRequirements(merged.items);
  if (!currentText && !historyText && !standingText) return null;
  return base(historyText, merged.omitted);
}

function parseLayers(raw: string): StoredGuidanceLayers | null {
  const format = raw.startsWith(PREFIX_V2) ? "v2" : raw.startsWith(PREFIX_V1) ? "v1" : null;
  if (!format) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(format === "v2" ? PREFIX_V2.length : PREFIX_V1.length));
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value.current !== "string" || typeof value.history !== "string" || typeof value.standing !== "string") return null;
    return {
      current: value.current,
      history: value.history,
      standing: value.standing,
      omitted: typeof value.omitted === "number" && Number.isInteger(value.omitted) && value.omitted > 0 ? value.omitted : 0,
      currentDate: typeof value.currentDate === "string" ? value.currentDate : "",
      format,
    };
  } catch {
    return null; // A teacher's literal text need not be JSON.
  }
}

export function readReviewGuidance(raw?: string | null): GuidanceLayers & { constraints: string; omitted: number; currentDate: string; format: StoredGuidanceLayers["format"] } {
  // Treat malformed/ordinary text as a direct submission, even if it starts with our marker.
  const index = raw?.indexOf(STANDING_GUIDANCE_HEADER) ?? -1;
  const layers: StoredGuidanceLayers = (raw ? parseLayers(raw) : null) ?? {
    current: (index >= 0 ? raw!.slice(0, index) : raw ?? "").trim(),
    history: "",
    standing: index >= 0 ? raw!.slice(index) : "",
    omitted: 0,
    currentDate: "",
    format: "plain",
  };
  // Hard paragraph-count/word-limit validators only read this round; merged history reaches the model as prompt text.
  return { ...layers, constraints: layers.current };
}

export function guidanceForPrompt(raw?: string | null): string {
  const { current, history, standing, omitted, currentDate, format } = readReviewGuidance(raw);
  const omittedNote = omitted > 0 ? `\n（因长度限制，已省略最早的 ${omitted} 条本篇要求；重复或被新要求完整包含的旧句已先行合并。）` : "";
  const historyBlock = !history ? "" : format === "v1"
    ? `[本篇历史要求（旧格式，无日期）；全部有效，与本轮要求冲突时以本轮为准]\n${history}`
    : `[本篇有效要求（按日期从旧到新，与本轮要求同等有效）]\n${history}${omittedNote}`;
  const currentLabel = currentDate ? `[本轮要求（${currentDate}，最新）]` : "[本轮要求（最新）]";
  const essayBlocks = [historyBlock, current ? `${currentLabel}\n${current}` : ""].filter(Boolean);
  return [
    standing ? `[本题长期规则；仅作上下文，与本篇要求或当前框架冲突时已被替代]\n${standing}` : "",
    essayBlocks.length > 0 ? ESSAY_REQUIREMENTS_PRECEDENCE : "",
    ...essayBlocks,
  ].filter(Boolean).join("\n\n");
}
