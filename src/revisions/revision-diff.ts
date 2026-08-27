import { diffArrays } from "diff";

export type RevisionRun = {
  kind: "unchanged" | "deleted" | "inserted" | "punctuation";
  text: string;
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
const isNeutral = (value: string) => /^[\p{P}\p{Z}\s]+$/u.test(value);

function graphemes(value: string): string[] {
  return Array.from(segmenter.segment(value), ({ segment }) => segment);
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
  let revisedIndex = 0;
  const appendBoundary = () => {
    appendRun(runs, "punctuation", boundaries[revisedIndex]?.join("") ?? "");
  };

  for (const change of changes) {
    if (change.kind === "deleted") {
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
