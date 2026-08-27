"use client";

import type { RevisionRun } from "@/src/revisions/revision-diff";

const TEXT_COLOR = "#171717";
const CHANGE_COLOR = "#C91F32";

export function RevisionPreview({ runs }: { runs: RevisionRun[] }) {
  return (
    <div className="revision-preview" aria-label="修改稿红黑预览">
      {runs.map((run, index) => {
        const color = run.kind === "inserted" || run.kind === "deleted"
          ? CHANGE_COLOR
          : TEXT_COLOR;
        if (run.kind === "deleted") {
          return <del key={`${index}:${run.text}`} style={{ color }}>{run.text}</del>;
        }
        return <span key={`${index}:${run.text}`} style={{ color }}>{run.text}</span>;
      })}
    </div>
  );
}
