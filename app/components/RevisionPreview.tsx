"use client";

import { useCallback, useEffect, useRef } from "react";

import { buildPreviewUnderlineStyles } from "@/src/revisions/advice-underlines";
import type { RevisionRun } from "@/src/revisions/revision-diff";

const TEXT_COLOR = "#171717";
const CHANGE_COLOR = "#C91F32";
const SENTENCE_CHANGE_COLOR = "#1F4E78";

function resolveDomSelectionOffset(container: HTMLElement, node: Node, nodeOffset: number): number | null {
  if (node === container) {
    const spans = Array.from(container.querySelectorAll<HTMLElement>("[data-char-start]"));
    if (nodeOffset <= 0) return 0;
    if (nodeOffset >= spans.length) return Number(spans.at(-1)?.dataset.charEnd ?? 0);
    return Number(spans[nodeOffset]?.dataset.charStart ?? 0);
  }
  const host = (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)
    ?.closest<HTMLElement>("[data-char-start]");
  if (!host || !container.contains(host)) return null;
  const start = Number(host.dataset.charStart ?? 0);
  if (node.nodeType === Node.TEXT_NODE) {
    return start + nodeOffset;
  }
  return nodeOffset <= 0 ? start : Number(host.dataset.charEnd ?? start);
}

export function RevisionPreview({
  runs,
  sentenceHighlight = false,
  onSelectRange,
}: {
  runs: RevisionRun[];
  sentenceHighlight?: boolean;
  onSelectRange?: (range: { start: number; end: number } | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onSelectRangeRef = useRef(onSelectRange);
  const hadActiveSelectionRef = useRef(false);

  useEffect(() => {
    onSelectRangeRef.current = onSelectRange;
  }, [onSelectRange]);

  const syncDomSelection = useCallback((forceNotifyCollapse: boolean) => {
    const callback = onSelectRangeRef.current;
    const container = containerRef.current;
    if (!callback || !container || typeof window === "undefined") return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      if (hadActiveSelectionRef.current || forceNotifyCollapse) {
        hadActiveSelectionRef.current = false;
        callback(null);
      }
      return;
    }
    const domRange = selection.getRangeAt(0);
    if (!container.contains(domRange.startContainer) || !container.contains(domRange.endContainer)) {
      if (hadActiveSelectionRef.current || forceNotifyCollapse) {
        hadActiveSelectionRef.current = false;
        callback(null);
      }
      return;
    }
    const from = resolveDomSelectionOffset(container, domRange.startContainer, domRange.startOffset);
    const to = resolveDomSelectionOffset(container, domRange.endContainer, domRange.endOffset);
    if (from === null || to === null || from === to) {
      if (hadActiveSelectionRef.current || forceNotifyCollapse) {
        hadActiveSelectionRef.current = false;
        callback(null);
      }
      return;
    }
    hadActiveSelectionRef.current = true;
    callback({ start: Math.min(from, to), end: Math.max(from, to) });
  }, []);

  useEffect(() => {
    if (!onSelectRange || typeof document === "undefined") return;
    const handleSelectionChange = () => {
      syncDomSelection(false);
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [onSelectRange, syncDomSelection]);

  const positionedRuns = runs.reduce<{
    cursor: number;
    items: Array<{ run: RevisionRun; charStart: number; charEnd: number }>;
  }>(
    (acc, run) => {
      if (run.kind === "deleted") {
        acc.items.push({ run, charStart: acc.cursor, charEnd: acc.cursor });
        return acc;
      }
      const charStart = acc.cursor;
      const charEnd = charStart + run.text.length;
      acc.items.push({ run, charStart, charEnd });
      acc.cursor = charEnd;
      return acc;
    },
    { cursor: 0, items: [] },
  ).items;

  return (
    <div
      ref={containerRef}
      className={`revision-preview${sentenceHighlight ? " revision-preview--sentence" : ""}`}
      aria-label={sentenceHighlight ? "改后全段整句下划线预览" : "修改稿红黑预览"}
      onMouseUp={onSelectRange ? () => syncDomSelection(true) : undefined}
      onKeyUp={onSelectRange ? () => syncDomSelection(true) : undefined}
    >
      {positionedRuns.map(({ run, charStart, charEnd }, index) => {
        const changedSentence = sentenceHighlight && run.kind === "inserted";
        const color = changedSentence
          ? SENTENCE_CHANGE_COLOR
          : run.kind === "inserted" || run.kind === "deleted"
          ? CHANGE_COLOR
          : TEXT_COLOR;
        if (run.kind === "deleted") {
          return <del key={`${index}:${run.text}`} style={{ color }}>{run.text}</del>;
        }
        const underlineStyle = changedSentence
          ? buildPreviewUnderlineStyles(run.underline ?? "single", SENTENCE_CHANGE_COLOR)
          : undefined;
        return <span
          className={changedSentence ? "revision-preview__changed-sentence" : undefined}
          data-underline={changedSentence ? run.underline ?? "single" : undefined}
          data-char-start={sentenceHighlight ? charStart : undefined}
          data-char-end={sentenceHighlight ? charEnd : undefined}
          key={`${index}:${run.text}`}
          style={{
            color,
            ...underlineStyle,
          }}
        >{run.text}</span>;
      })}
    </div>
  );
}
