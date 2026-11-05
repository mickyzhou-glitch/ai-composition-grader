"use client";

import { PREVIEW_UNDERLINE_STYLE } from "@/src/revisions/advice-underlines";
import type { RevisionRun } from "@/src/revisions/revision-diff";

const TEXT_COLOR = "#171717";
const CHANGE_COLOR = "#C91F32";
const SENTENCE_CHANGE_COLOR = "#1F4E78";


export function RevisionPreview({
  runs,
  sentenceHighlight = false,
}: {
  runs: RevisionRun[];
  sentenceHighlight?: boolean;
}) {
  return (
    <div
      className={`revision-preview${sentenceHighlight ? " revision-preview--sentence" : ""}`}
      aria-label={sentenceHighlight ? "改后全段整句下划线预览" : "修改稿红黑预览"}
    >
      {runs.map((run, index) => {
        const changedSentence = sentenceHighlight && run.kind === "inserted";
        const color = changedSentence
          ? SENTENCE_CHANGE_COLOR
          : run.kind === "inserted" || run.kind === "deleted"
          ? CHANGE_COLOR
          : TEXT_COLOR;
        if (run.kind === "deleted") {
          return <del key={`${index}:${run.text}`} style={{ color }}>{run.text}</del>;
        }
        return <span
          className={changedSentence ? "revision-preview__changed-sentence" : undefined}
          data-underline={changedSentence ? run.underline ?? "single" : undefined}
          key={`${index}:${run.text}`}
          style={{
            color,
            textDecoration: changedSentence ? "underline" : undefined,
            textDecorationStyle: changedSentence ? PREVIEW_UNDERLINE_STYLE[run.underline ?? "single"] : undefined,
            textUnderlineOffset: changedSentence ? "3px" : undefined,
          }}
        >{run.text}</span>;
      })}
    </div>
  );
}
