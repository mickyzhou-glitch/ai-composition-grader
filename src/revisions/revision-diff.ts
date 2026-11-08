import { diffArrays } from "diff";

/** 改后全段下划线线型：第 1/2/3 条修改动作依次为波浪/双线/单线。 */
export type RevisionUnderline = "wave" | "double" | "single";

export type RevisionRun = {
  kind: "unchanged" | "deleted" | "inserted" | "punctuation";
  text: string;
  /** 仅改后全段整句标注使用；缺省按单下划线。 */
  underline?: RevisionUnderline;
  /** 对应第几条修改动作（0 起）；退回旧口径时没有。 */
  actionIndex?: number;
};

type WordChange = {
  kind: "unchanged" | "deleted" | "inserted";
  values: string[];
  moved: boolean[];
};

type MoveCandidate = {
  removed: WordChange;
  removedStart: number;
  added: WordChange;
  addedStart: number;
  length: number;
  values: string[];
};

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
const sentenceSegmenter = new Intl.Segmenter("zh-CN", { granularity: "sentence" });
const sentenceTerminal = /[.!?。！？…](?:["'”’」』】）》〉）])*\s*$/u;
const isNeutral = (value: string) => (
  /^(?:[\p{P}\p{Z}\s](?:[\uFE00-\uFE0F\u{E0100}-\u{E01EF}])*)+$/u.test(value)
);

function graphemes(value: string): string[] {
  return Array.from(segmenter.segment(value), ({ segment }) => segment);
}

function mergeShortSentenceFragments(units: string[]): string[] {
  const merged: string[] = [];
  let leading = "";

  for (const unit of units) {
    const text = leading + unit;
    leading = "";
    const visibleLength = graphemes(text).filter((value) => !/^\s+$/u.test(value)).length;
    if (visibleLength > 1) {
      merged.push(text);
    } else if (merged.length > 0) {
      merged[merged.length - 1] += text;
    } else {
      leading = text;
    }
  }

  if (leading.length > 0) {
    merged.push(leading);
  }
  return merged;
}

function sentences(value: string): string[] {
  const result: string[] = [];
  let pending = "";

  for (const { segment } of sentenceSegmenter.segment(value)) {
    pending += segment;
    if (sentenceTerminal.test(pending)) {
      result.push(pending);
      pending = "";
    }
  }

  if (pending.length > 0) {
    result.push(pending);
  }
  return mergeShortSentenceFragments(result);
}

function countOccurrences(haystack: string[], needle: string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) {
    return 0;
  }

  let count = 0;
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        continue outer;
      }
    }
    count += 1;
    if (count > 1) {
      return count;
    }
  }
  return count;
}

function collectMoveCandidates(
  removed: WordChange,
  added: WordChange,
): MoveCandidate[] {
  const candidates: MoveCandidate[] = [];
  let nextRow = new Array<number>(added.values.length + 1).fill(0);

  for (let removedIndex = removed.values.length - 1; removedIndex >= 0; removedIndex -= 1) {
    const row = new Array<number>(added.values.length + 1).fill(0);
    for (let addedIndex = added.values.length - 1; addedIndex >= 0; addedIndex -= 1) {
      if (removed.values[removedIndex] !== added.values[addedIndex]) {
        continue;
      }

      row[addedIndex] = nextRow[addedIndex + 1] + 1;
      const extendsToLeft = removedIndex > 0
        && addedIndex > 0
        && removed.values[removedIndex - 1] === added.values[addedIndex - 1];
      if (!extendsToLeft) {
        candidates.push({
          removed,
          removedStart: removedIndex,
          added,
          addedStart: addedIndex,
          length: row[addedIndex],
          values: removed.values.slice(removedIndex, removedIndex + row[addedIndex]),
        });
      }
    }
    nextRow = row;
  }

  return candidates;
}

function detectMoves(
  changes: WordChange[],
  sourceWords: string[],
  revisedWords: string[],
): void {
  const removedChanges = changes.filter((change) => change.kind === "deleted");
  const addedChanges = changes.filter((change) => change.kind === "inserted");
  const candidates = removedChanges.flatMap((removed) => (
    addedChanges.flatMap((added) => collectMoveCandidates(removed, added))
  ));
  const occurrenceCache = new Map<string, boolean>();

  candidates.sort((left, right) => right.length - left.length);

  for (const candidate of candidates) {
    const key = candidate.values.join("");
    let isUnique = occurrenceCache.get(key);
    if (isUnique === undefined) {
      isUnique = countOccurrences(sourceWords, candidate.values) === 1
        && countOccurrences(revisedWords, candidate.values) === 1;
      occurrenceCache.set(key, isUnique);
    }
    if (!isUnique) {
      continue;
    }

    const removedRange = candidate.removed.moved.slice(
      candidate.removedStart,
      candidate.removedStart + candidate.length,
    );
    const addedRange = candidate.added.moved.slice(
      candidate.addedStart,
      candidate.addedStart + candidate.length,
    );
    if (removedRange.some(Boolean) || addedRange.some(Boolean)) {
      continue;
    }

    candidate.removed.moved.fill(
      true,
      candidate.removedStart,
      candidate.removedStart + candidate.length,
    );
    candidate.added.moved.fill(
      true,
      candidate.addedStart,
      candidate.addedStart + candidate.length,
    );
  }
}

function revisedNeutralBoundaries(revised: string): string[][] {
  const boundaries: string[][] = [[]];
  let wordIndex = 0;

  for (const value of graphemes(revised)) {
    if (isNeutral(value)) {
      boundaries[wordIndex].push(value);
      continue;
    }
    wordIndex += 1;
    boundaries[wordIndex] = [];
  }

  return boundaries;
}

function appendRun(runs: RevisionRun[], kind: RevisionRun["kind"], text: string): void {
  if (text.length === 0) {
    return;
  }
  const previous = runs.at(-1);
  if (previous?.kind === kind) {
    previous.text += text;
    return;
  }
  runs.push({ kind, text });
}

export function buildRevisionRuns(source: string, revised: string): RevisionRun[] {
  const sourceWords = graphemes(source).filter((value) => !isNeutral(value));
  const revisedWords = graphemes(revised).filter((value) => !isNeutral(value));
  const changes: WordChange[] = diffArrays(sourceWords, revisedWords).map((change) => ({
    kind: change.removed ? "deleted" : change.added ? "inserted" : "unchanged",
    values: change.value,
    moved: new Array<boolean>(change.value.length).fill(false),
  }));

  detectMoves(changes, sourceWords, revisedWords);

  const boundaries = revisedNeutralBoundaries(revised);
  const runs: RevisionRun[] = [];
  const consumedBoundaries = new Set<number>();
  let revisedIndex = 0;
  const appendBoundary = () => {
    if (consumedBoundaries.has(revisedIndex)) {
      return;
    }
    consumedBoundaries.add(revisedIndex);
    appendRun(runs, "punctuation", boundaries[revisedIndex]?.join("") ?? "");
  };

  for (const change of changes) {
    if (change.kind === "deleted") {
      if (revisedIndex < revisedWords.length) {
        appendBoundary();
      }
      change.values.forEach((value, index) => {
        if (!change.moved[index]) {
          appendRun(runs, "deleted", value);
        }
      });
      continue;
    }

    change.values.forEach((value, index) => {
      appendBoundary();
      const kind = change.kind === "inserted" && !change.moved[index]
        ? "inserted"
        : "unchanged";
      appendRun(runs, kind, value);
      revisedIndex += 1;
    });
  }

  appendBoundary();
  return runs;
}

/** 两句去掉标点空白后逐字比对，相同字数占较长一句的比例。 */
export function sentenceSimilarity(left: string, right: string): number {
  const a = graphemes(left).filter((value) => !isNeutral(value));
  const b = graphemes(right).filter((value) => !isNeutral(value));
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  const common = diffArrays(a, b)
    .filter((change) => !change.added && !change.removed)
    .reduce((sum, change) => sum + change.value.length, 0);
  return common / longest;
}

/** 达到这个相似度的改后句视为只做了错字、语病、标点或用词微调，不算实质修改。 */
export const MINOR_EDIT_SIMILARITY = 0.8;

/**
 * 与 buildSentenceRevisionRuns 相同按整句比对，但与原文某句（或紧挨着被替换的那几句合起来）
 * 基本一致的改后句记为未改动：基础修改不划线。
 */
export function buildSubstantiveSentenceRuns(source: string, revised: string): RevisionRun[] {
  const sourceSentences = sentences(source);
  const runs: RevisionRun[] = [];
  let replaced = "";

  for (const change of diffArrays(sourceSentences, sentences(revised))) {
    if (change.removed) {
      replaced = change.value.join("");
      continue;
    }
    if (!change.added) {
      replaced = "";
      appendRun(runs, "unchanged", change.value.join(""));
      continue;
    }
    for (const sentence of change.value) {
      const minor = isNeutral(sentence)
        || [replaced, ...sourceSentences].some((candidate) => (
          candidate.length > 0 && sentenceSimilarity(candidate, sentence) >= MINOR_EDIT_SIMILARITY
        ));
      appendRun(runs, minor ? "unchanged" : "inserted", sentence);
    }
    replaced = "";
  }

  return runs;
}

export function buildSentenceRevisionRuns(source: string, revised: string): RevisionRun[] {
  const runs: RevisionRun[] = [];

  for (const change of diffArrays(sentences(source), sentences(revised))) {
    if (change.removed) {
      continue;
    }
    appendRun(
      runs,
      change.added ? "inserted" : "unchanged",
      change.value.join(""),
    );
  }

  return runs;
}
