"use client";

import { useRef, useState } from "react";

import type { ParagraphEvaluationReport, ParagraphReview, PersistedQuoteRange } from "@/src/domain/contracts";
import {
  migrateEssayDraft,
  deriveEssayFromParagraphReviews,
  essayDiffersFromParagraphReviews,
} from "@/src/domain/essay-paragraph-sync";
import { collapseParagraphSuggestions, mergedParagraphAction, UNCHANGED_PARAGRAPH_ACTION } from "@/src/domain/paragraph-actions";
import { paragraphReviewUsesGroups, resolveReviewGroups } from "@/src/domain/paragraph-review-groups";
import { countTextCharactersIncludingPunctuation } from "@/src/domain/sample-writing-requirements";
import type { PublicOcrView } from "@/src/ocr/contracts";
import {
  adviceActionUnderlines,
  adviceUnderlineStyle,
  buildAdviceRevisionRuns,
  buildPreviewUnderlineStyles,
  effectiveQuoteRanges,
  MAX_ACTIONS_WITH_QUOTES,
  paintQuoteRange,
  paragraphActions,
  rangesToPersistedRanges,
  rangesToRevisedQuotes,
  reconcileQuotesOnAdviceChange,
  reconcileQuotesOnRevisedTextChange,
  snapRangeToCodePointBounds,
  splitParagraphActionSlices,
  splitRevisedSentences,
  UNDERLINE_STYLE_LABELS,
  validateQuoteRangesCapacity,
  type QuoteRange,
  type TextEditHint,
} from "@/src/revisions/advice-underlines";
import type { ReviewImageView } from "../lib/types";
import { ParagraphCropPreview } from "./ParagraphCropPreview";
import { RevisionPreview } from "./RevisionPreview";

function withUpdatedUnderlineData(
  suggestions: ParagraphReview["suggestions"],
  options: {
    advice?: string;
    revisedQuotes?: Array<string | string[]>;
    revisedRanges?: PersistedQuoteRange[];
    clearExplicit?: boolean;
  },
): ParagraphReview["suggestions"] {
  const collapsed = collapseParagraphSuggestions(suggestions)[0];
  const advice = options.advice ?? mergedParagraphAction(suggestions);
  const base = collapsed
    ? (({ revisedQuotes: _q, revisedRanges: _r, ...rest }) => {
        void _q;
        void _r;
        return rest;
      })(collapsed)
    : {};
  if (options.clearExplicit) {
    return [{ ...base, advice }];
  }
  return [{
    ...base,
    advice,
    ...(options.revisedQuotes !== undefined ? { revisedQuotes: options.revisedQuotes } : {}),
    ...(options.revisedRanges !== undefined ? { revisedRanges: options.revisedRanges } : {}),
  }];
}

function truncateSnippet(value: string, maxChars = 14): string {
  const clean = value.replace(/\s+/gu, " ").trim();
  const codePoints = Array.from(clean);
  return codePoints.length > maxChars ? `${codePoints.slice(0, maxChars - 1).join("")}…` : clean;
}

/** 连续剥离末尾空行与尚未填写正文的空编号行；仅当首条 `1. ` 是由「+ 加一条动作」自动补入时才在回退单条时还原。 */
function stripTrailingEmptyNumberedLines(raw: string, syntheticFirstPrefix = false): string {
  const lines = raw.split(/\r\n?|\n/u);
  let poppedEmptyNumbered = false;
  while (lines.length > 1) {
    const tail = lines.at(-1) ?? "";
    if (/^\s*$/u.test(tail)) {
      lines.pop();
      continue;
    }
    if (/^\s*\d{1,3}(?:\s*[、)）]\s*|\s*[.．](?!\d)\s*)$/u.test(tail)) {
      lines.pop();
      poppedEmptyNumbered = true;
      continue;
    }
    break;
  }
  if (poppedEmptyNumbered && lines.length === 1 && syntheticFirstPrefix) {
    lines[0] = lines[0]!.replace(/^\s*1(?:\s*[、)）]\s*|\s*[.．](?!\d)\s*)/u, "");
  }
  const joined = lines.join("\n").trim();
  if (/^\d{1,3}(?:\s*[、)）]\s*|\s*[.．](?!\d)\s*)$/u.test(joined)) return "";
  return joined;
}

function scopedParagraphKey(reviewId: string, paragraphId: string): string {
  return `${reviewId}:${paragraphId}`;
}

interface SelectionSnapshot {
  reviewId: string;
  paragraphId: string;
  source: "textarea" | "preview";
  start: number;
  end: number;
  textSnapshot: string;
}

interface ActionDraftSnapshot {
  reviewId: string;
  rawValue: string;
  committedAdvice: string;
  syntheticFirstPrefix?: boolean;
}

interface ParagraphReviewEditorProps {
  reviewId: string;
  report: ParagraphEvaluationReport;
  ocr: Extract<PublicOcrView, { version: 2 }>;
  images: ReviewImageView[] | Array<{ id: number; position: number }>;
  disabled: boolean;
  onChange: (report: ParagraphEvaluationReport) => void;
  onRewriteParagraph?: (paragraphId: string, instruction?: string) => Promise<void>;
  rewritingParagraphId?: string | null;
  showSourceCrops?: boolean;
  showCharacterCounts?: boolean;
  showSuggestions?: boolean;
  revisionHeading?: string;
  revisionLabel?: string;
}

export function ParagraphReviewEditor({
  reviewId,
  report,
  ocr,
  images,
  disabled: externallyDisabled,
  onChange,
  onRewriteParagraph,
  rewritingParagraphId = null,
  showSourceCrops = true,
  showCharacterCounts = false,
  showSuggestions = true,
  revisionHeading = "改后全段",
  revisionLabel = "改后全段",
}: ParagraphReviewEditorProps) {
  const [instructions, setInstructions] = useState<Record<string, string>>({});
  const [prevReviewId, setPrevReviewId] = useState(reviewId);
  const [selection, setSelection] = useState<SelectionSnapshot | null>(null);
  if (prevReviewId !== reviewId) {
    setPrevReviewId(reviewId);
    if (selection !== null) {
      setSelection(null);
    }
  }
  const [actionDrafts, setActionDrafts] = useState<Record<string, ActionDraftSnapshot | undefined>>({});
  const [manualPanels, setManualPanels] = useState<Record<string, boolean>>({});
  const [underlineHints, setUnderlineHints] = useState<Record<string, string>>({});
  const actionTextareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const lastTextareaCaretRef = useRef<Record<string, { start: number; end: number; textSnapshot: string } | undefined>>({});
  const lastEssayCaretRef = useRef<Record<string, { start: number; end: number; textSnapshot: string } | undefined>>({});

  const paragraphs = [...ocr.paragraphs]
    .sort((left, right) => left.paragraphIndex - right.paragraphIndex);
  const grouped = paragraphReviewUsesGroups(report.paragraphReviews);
  const groups = resolveReviewGroups(report.paragraphReviews, paragraphs);
  const essayOutOfSync = essayDiffersFromParagraphReviews(report);
  const migrationDisabled = externallyDisabled;
  const disabled = externallyDisabled || essayOutOfSync;
  const totalCharacters = report.paragraphReviews.reduce(
    (total, review) => total + countTextCharactersIncludingPunctuation(review.revisedText),
    0,
  );

  function updateParagraph(
    paragraphId: string,
    update: (review: ParagraphReview) => ParagraphReview,
    syncEssay = false,
  ) {
    const nextParagraphReviews = report.paragraphReviews.map((review) => (
      review.paragraphId === paragraphId ? update(review) : review
    ));
    onChange({
      ...report,
      paragraphReviews: nextParagraphReviews,
      ...(syncEssay && report.rewrittenEssay
        ? { rewrittenEssay: deriveEssayFromParagraphReviews(nextParagraphReviews) }
        : {}),
    });
  }

  function recordRangeSelection(
    paragraphId: string,
    source: "textarea" | "preview",
    revisedText: string,
    start: number,
    end: number,
  ) {
    const key = scopedParagraphKey(reviewId, paragraphId);
    if (source === "textarea") {
      lastTextareaCaretRef.current[key] = { start, end, textSnapshot: revisedText };
    }
    const snapped = snapRangeToCodePointBounds(revisedText, start, end);
    if (snapped.end <= snapped.start || !revisedText.slice(snapped.start, snapped.end).trim()) {
      setSelection((current) => (
        current
        && current.reviewId === reviewId
        && current.paragraphId === paragraphId
        && (source === "textarea" || current.source === "preview")
          ? null
          : current
      ));
      return;
    }
    setSelection({
      reviewId,
      paragraphId,
      source,
      start: snapped.start,
      end: snapped.end,
      textSnapshot: revisedText,
    });
  }

  function applyRangesToParagraph(
    paragraphReview: ParagraphReview,
    nextRanges: readonly QuoteRange[],
    actionCount: number,
  ) {
    const key = scopedParagraphKey(reviewId, paragraphReview.paragraphId);
    const advice = mergedParagraphAction(paragraphReview.suggestions);
    const capacityError = validateQuoteRangesCapacity(paragraphReview.revisedText, nextRanges, actionCount, advice);
    if (capacityError) {
      setUnderlineHints((current) => ({ ...current, [key]: capacityError }));
      return;
    }
    const quotes = rangesToRevisedQuotes(paragraphReview.revisedText, nextRanges, actionCount);
    const persistedRanges = rangesToPersistedRanges(paragraphReview.revisedText, nextRanges, actionCount);
    setUnderlineHints((current) => ({ ...current, [key]: "" }));
    updateParagraph(paragraphReview.paragraphId, (current) => ({
      ...current,
      suggestions: withUpdatedUnderlineData(current.suggestions, {
        revisedQuotes: quotes,
        revisedRanges: persistedRanges,
      }),
    }));
  }

  function handlePaintRange(
    paragraphReview: ParagraphReview,
    sourceText: string,
    start: number,
    end: number,
    actionIndex: number | null,
  ) {
    const key = scopedParagraphKey(reviewId, paragraphReview.paragraphId);
    const actionCount = paragraphActions(paragraphReview.suggestions).length;
    if (actionCount === 0) return;
    if (actionCount > MAX_ACTIONS_WITH_QUOTES) {
      setUnderlineHints((current) => ({
        ...current,
        [key]: `单段修改动作最多支持 ${MAX_ACTIONS_WITH_QUOTES} 条`,
      }));
      return;
    }
    const currentRanges = effectiveQuoteRanges(sourceText, paragraphReview.revisedText, paragraphReview.suggestions);
    const painted = paintQuoteRange(
      paragraphReview.revisedText,
      currentRanges,
      start,
      end,
      actionIndex,
      actionCount,
    );
    applyRangesToParagraph(paragraphReview, painted, actionCount);
    const prevSource = selection?.reviewId === reviewId && selection.paragraphId === paragraphReview.paragraphId
      ? selection.source
      : undefined;
    setSelection((current) => (
      current?.reviewId === reviewId && current.paragraphId === paragraphReview.paragraphId ? null : current
    ));
    if (prevSource === "preview" && typeof window !== "undefined") {
      window.getSelection()?.removeAllRanges();
    }
  }

  function handleAddAction(paragraphReview: ParagraphReview) {
    const key = scopedParagraphKey(reviewId, paragraphReview.paragraphId);
    const committedAdvice = mergedParagraphAction(paragraphReview.suggestions);
    const activeDraft = actionDrafts[key];
    const currentText = activeDraft?.reviewId === reviewId && activeDraft.committedAdvice === committedAdvice
      ? activeDraft.rawValue
      : committedAdvice;
    const cleaned = stripTrailingEmptyNumberedLines(currentText, Boolean(activeDraft?.syntheticFirstPrefix));
    const slices = splitParagraphActionSlices(cleaned);
    if (slices.length >= MAX_ACTIONS_WITH_QUOTES) return;

    let nextRaw: string;
    let syntheticFirstPrefix = Boolean(activeDraft?.syntheticFirstPrefix);
    if (!cleaned || cleaned === UNCHANGED_PARAGRAPH_ACTION || slices.length === 0) {
      nextRaw = "1. ";
      syntheticFirstPrefix = false;
    } else if (slices.length === 1) {
      syntheticFirstPrefix = syntheticFirstPrefix || slices[0]!.prefix === "";
      nextRaw = `1. ${slices[0]!.body}\n2. `;
    } else {
      const existing = slices.map((slice, idx) => `${idx + 1}. ${slice.body}`).join("\n");
      nextRaw = `${existing}\n${slices.length + 1}. `;
    }

    setActionDrafts((current) => ({
      ...current,
      [key]: { reviewId, rawValue: nextRaw, committedAdvice, syntheticFirstPrefix },
    }));

    const focusTarget = () => {
      const el = actionTextareaRefs.current[key];
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextRaw.length, nextRaw.length);
    };
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(focusTarget);
    } else {
      setTimeout(focusTarget, 0);
    }
  }

  function handleRemoveAction(paragraphReview: ParagraphReview, sourceText: string, removeIndex: number) {
    const key = scopedParagraphKey(reviewId, paragraphReview.paragraphId);
    const slices = splitParagraphActionSlices(mergedParagraphAction(paragraphReview.suggestions));
    if (slices.length <= 1 || removeIndex < 0 || removeIndex >= slices.length) return;
    const surviving = slices
      .map((slice, oldIndex) => ({ body: slice.body, oldIndex }))
      .filter((item) => item.oldIndex !== removeIndex && item.body.length > 0);

    const nextAdvice = surviving.length === 0
      ? UNCHANGED_PARAGRAPH_ACTION
      : surviving.length === 1
      ? surviving[0]!.body
      : surviving.map((item, idx) => `${idx + 1}. ${item.body}`).join("\n");

    setActionDrafts((current) => ({ ...current, [key]: undefined }));

    const hasExplicit = paragraphReview.suggestions.some(
      (item) => Array.isArray(item.revisedQuotes) || Array.isArray(item.revisedRanges),
    );
    if (!hasExplicit && surviving.length > 0) {
      updateParagraph(paragraphReview.paragraphId, (current) => ({
        ...current,
        suggestions: withUpdatedUnderlineData(current.suggestions, { advice: nextAdvice, clearExplicit: true }),
      }));
      return;
    }

    const oldToNew = new Map<number, number>();
    surviving.forEach((item, newIndex) => oldToNew.set(item.oldIndex, newIndex));
    const currentRanges = effectiveQuoteRanges(sourceText, paragraphReview.revisedText, paragraphReview.suggestions);
    const shiftedRanges: QuoteRange[] = currentRanges
      .map((range) => {
        const mappedIndex = oldToNew.get(range.actionIndex);
        return mappedIndex !== undefined ? { ...range, actionIndex: mappedIndex } : null;
      })
      .filter((range): range is QuoteRange => range !== null);

    const nextCount = surviving.length;
    const nextQuotes = nextCount === 0
      ? []
      : rangesToRevisedQuotes(paragraphReview.revisedText, shiftedRanges, nextCount);
    const nextPersistedRanges = nextCount === 0
      ? []
      : rangesToPersistedRanges(paragraphReview.revisedText, shiftedRanges, nextCount);

    updateParagraph(paragraphReview.paragraphId, (current) => ({
      ...current,
      suggestions: withUpdatedUnderlineData(current.suggestions, {
        advice: nextAdvice,
        revisedQuotes: nextQuotes,
        revisedRanges: nextPersistedRanges,
      }),
    }));
  }

  return (
    <div className="paragraph-review-editor">
      {showCharacterCounts ? <div className="paragraph-review-total">
        {report.rewrittenEssay ? "完整范文" : "改后全段"}总字数 <strong>{totalCharacters}</strong> 字（含标点）
      </div> : null}
      {report.rewrittenEssay ? <section className="paragraph-review-unit" aria-label="完整范文">
        <div className="paragraph-review-heading">
          <div className="essay-sync">
            <h3>按要求重写的完整范文</h3>
            {essayOutOfSync ? <div role="alert">
              <p>旧报告有两份不同的草稿。请先选择后续编辑版本；两份原文都会随保存备份。</p>
              <button type="button" disabled={migrationDisabled} onClick={() => onChange(migrateEssayDraft(report, "essay", paragraphs.map(({ id }) => id)))}>保留完整范文（{report.rewrittenEssay.length} 段）</button>
              <button type="button" disabled={migrationDisabled} onClick={() => onChange(migrateEssayDraft(report, "paragraphs", paragraphs.map(({ id }) => id)))}>保留逐段稿（{report.paragraphReviews.length} 段）</button>
            </div> : null}
            {report.draftMigration ? <details><summary>查看迁移前的两份草稿</summary>
              <h4>原完整范文</h4>{report.draftMigration.originalEssay.map((text, index) => <p key={index}>{text}</p>)}
              <h4>原逐段稿</h4>{report.draftMigration.originalParagraphReviews.map((item, index) => <p key={index}>{item.revisedText}</p>)}
            </details> : null}
          </div>
          <span>共 {report.rewrittenEssay.length} 段 · {totalCharacters} 字（含标点）</span>
        </div>
        {report.rewrittenEssay.map((text, index) => {
          const essayKey = `${reviewId}:essay:${index}`;
          const recordEssayCaret = (start: number, end: number) => {
            lastEssayCaretRef.current[essayKey] = { start, end, textSnapshot: text };
          };
          return <label key={index}>第 {index + 1} 段
            <textarea
              className="paragraph-revision-input"
              aria-label={`完整范文第 ${index + 1} 段`}
              value={text}
              disabled={disabled}
              onSelect={(event) => recordEssayCaret(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)}
              onMouseUp={(event) => recordEssayCaret(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)}
              onKeyUp={(event) => recordEssayCaret(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)}
              onKeyDown={(event) => recordEssayCaret(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)}
              onChange={(event) => {
                const nextText = event.target.value;
                const trackedEssayCaret = lastEssayCaretRef.current[essayKey];
                let essayEditHint: TextEditHint | null = null;
                if (trackedEssayCaret && trackedEssayCaret.textSnapshot === text) {
                  if (trackedEssayCaret.end > trackedEssayCaret.start) {
                    essayEditHint = { start: trackedEssayCaret.start, end: trackedEssayCaret.end };
                  } else if (nextText.length < text.length) {
                    const caretAfter = event.currentTarget.selectionStart;
                    const delLen = text.length - nextText.length;
                    if (caretAfter >= 0 && caretAfter + delLen <= text.length) {
                      essayEditHint = { start: caretAfter, end: caretAfter + delLen };
                    }
                  } else if (nextText.length > text.length) {
                    essayEditHint = { start: trackedEssayCaret.start, end: trackedEssayCaret.start };
                  }
                }
                lastEssayCaretRef.current[essayKey] = {
                  start: event.currentTarget.selectionStart,
                  end: event.currentTarget.selectionEnd,
                  textSnapshot: nextText,
                };
                const nextEssay = report.rewrittenEssay!.map((current, i) => i === index ? nextText : current);
                const syncedReviewId = nextEssay.length === report.paragraphReviews.length
                  ? report.paragraphReviews[index]?.paragraphId
                  : undefined;
                if (syncedReviewId) {
                  const syncedKey = scopedParagraphKey(reviewId, syncedReviewId);
                  setSelection((current) => (
                    current?.reviewId === reviewId && current.paragraphId === syncedReviewId ? null : current
                  ));
                  lastTextareaCaretRef.current[syncedKey] = undefined;
                }
                onChange({
                  ...report,
                  rewrittenEssay: nextEssay,
                  ...(nextEssay.length === report.paragraphReviews.length
                    ? {
                        paragraphReviews: report.paragraphReviews.map((review, i) => (
                          i === index
                            ? {
                                ...review,
                                revisedText: nextText,
                                suggestions: reconcileQuotesOnRevisedTextChange(
                                  review.revisedText,
                                  nextText,
                                  review.suggestions,
                                  essayEditHint,
                                ),
                              }
                            : review
                        )),
                      }
                    : {}),
                });
              }}
            />
          </label>;
        })}
      </section> : null}
      {(grouped ? groups : paragraphs.map((paragraph) => {
        const reviewIndex = report.paragraphReviews.findIndex(
          ({ paragraphId }) => paragraphId === paragraph.id,
        );
        const review = report.paragraphReviews[reviewIndex];
        return review ? {
          reviewIndex,
          review,
          paragraphs: [paragraph],
          sourceText: paragraph.text,
          sourceLabel: null,
          pageIndex: paragraph.segments[0]?.pageIndex,
        } : null;
      })).map((group, index) => {
        if (!group) {
          const paragraphNumber = paragraphs[index]?.paragraphIndex !== undefined
            ? paragraphs[index].paragraphIndex + 1
            : index + 1;
          return <div className="paragraph-review-error" role="alert" key={`missing-${index}`}>
            第 {paragraphNumber} 段缺少逐段批改
          </div>;
        }
        const paragraphReview = group.review;
        const scopedKey = scopedParagraphKey(reviewId, paragraphReview.paragraphId);
        const paragraphNumber = grouped ? index + 1 : group.paragraphs[0].paragraphIndex + 1;
        const instruction = instructions[scopedKey] ?? "";
        const rewriting = rewritingParagraphId === paragraphReview.paragraphId;
        const mergedAdvice = mergedParagraphAction(paragraphReview.suggestions);
        const draftSnapshot = actionDrafts[scopedKey];
        const textareaAdviceValue = draftSnapshot
          && draftSnapshot.reviewId === reviewId
          && draftSnapshot.committedAdvice === mergedAdvice
          ? draftSnapshot.rawValue
          : mergedAdvice;
        const actionSlices = splitParagraphActionSlices(mergedAdvice);
        const actionUnderlines = adviceActionUnderlines(paragraphReview.revisedText, paragraphReview.suggestions);
        const previewRuns = buildAdviceRevisionRuns(group.sourceText, paragraphReview.revisedText, paragraphReview.suggestions);
        const effectiveRanges = showSuggestions
          ? effectiveQuoteRanges(group.sourceText, paragraphReview.revisedText, paragraphReview.suggestions)
          : [];
        const hasExplicitQuotes = paragraphReview.suggestions.some(
          (item) => Array.isArray(item.revisedQuotes) || Array.isArray(item.revisedRanges),
        );
        const activeSelection = selection
          && selection.reviewId === reviewId
          && selection.paragraphId === paragraphReview.paragraphId
          && selection.textSnapshot === paragraphReview.revisedText
          && selection.start >= 0
          && selection.end <= paragraphReview.revisedText.length
          && selection.end > selection.start
          && paragraphReview.revisedText.slice(selection.start, selection.end).trim().length > 0
          ? selection
          : null;
        const manualOpen = Boolean(manualPanels[scopedKey]);
        const statusHint = underlineHints[scopedKey] ?? "";

        return (
          <section
            className="paragraph-review-unit"
            data-paragraph-id={paragraphReview.paragraphId}
            key={paragraphReview.paragraphId}
          >
            <div className="paragraph-review-heading">
              <h3>第 {paragraphNumber} 段</h3>
              {group.sourceLabel ? <span>{group.sourceLabel}</span> : null}
              {showCharacterCounts ? <span>
                改后全段 <strong>{countTextCharactersIncludingPunctuation(paragraphReview.revisedText)}</strong> 字（含标点）
              </span> : null}
            </div>
            {showSourceCrops ? group.paragraphs.map((source) => (
              <ParagraphCropPreview
                key={source.id}
                reviewId={reviewId}
                paragraphNumber={source.paragraphIndex + 1}
                images={images}
                segments={source.segments}
              />
            )) : null}

            {showSuggestions ? <div className="paragraph-suggestion">
              <div className="paragraph-suggestion__header">
                <h4>【修改动作】</h4>
                <div className="paragraph-suggestion__tools">
                  <button
                    type="button"
                    aria-label={`第 ${paragraphNumber} 段新增一条修改动作`}
                    disabled={disabled || rewriting || actionSlices.length >= MAX_ACTIONS_WITH_QUOTES}
                    onClick={() => handleAddAction(paragraphReview)}
                  >+ 加一条动作</button>
                  <button
                    type="button"
                    aria-label={`第 ${paragraphNumber} 段设为无需修改`}
                    disabled={disabled || rewriting || (mergedAdvice === UNCHANGED_PARAGRAPH_ACTION && hasExplicitQuotes && !draftSnapshot)}
                    onClick={() => {
                      setActionDrafts((current) => ({ ...current, [scopedKey]: undefined }));
                      setUnderlineHints((current) => ({ ...current, [scopedKey]: "" }));
                      updateParagraph(paragraphReview.paragraphId, (current) => ({
                        ...current,
                        suggestions: withUpdatedUnderlineData(current.suggestions, {
                          advice: UNCHANGED_PARAGRAPH_ACTION,
                          revisedQuotes: [],
                          revisedRanges: [],
                        }),
                      }));
                    }}
                  >设为无需修改</button>
                </div>
              </div>
              <label><span className="visually-hidden">修改动作</span>
                <textarea
                  ref={(node) => { actionTextareaRefs.current[scopedKey] = node; }}
                  aria-label={`第 ${paragraphNumber} 段修改动作`}
                  placeholder="输入修改动作；多条用 1. 2. 分行，留空表示本段无需修改"
                  value={textareaAdviceValue}
                  disabled={disabled || rewriting}
                  onChange={(event) => {
                    const rawNext = event.target.value;
                    setUnderlineHints((current) => ({ ...current, [scopedKey]: "" }));
                    const wasSynthetic = Boolean(draftSnapshot?.reviewId === reviewId && draftSnapshot.syntheticFirstPrefix);
                    const stripped = stripTrailingEmptyNumberedLines(rawNext, wasSynthetic);
                    const nextCommitted = stripped || UNCHANGED_PARAGRAPH_ACTION;
                    if (rawNext !== nextCommitted) {
                      setActionDrafts((current) => ({
                        ...current,
                        [scopedKey]: {
                          reviewId,
                          rawValue: rawNext,
                          committedAdvice: nextCommitted,
                          syntheticFirstPrefix: wasSynthetic,
                        },
                      }));
                    } else {
                      setActionDrafts((current) => (
                        current[scopedKey]
                          ? { ...current, [scopedKey]: undefined }
                          : current
                      ));
                    }
                    if (nextCommitted !== mergedAdvice || !rawNext.trim()) {
                      updateParagraph(paragraphReview.paragraphId, (current) => ({
                        ...current,
                        suggestions: [reconcileQuotesOnAdviceChange(current.revisedText, current.suggestions, nextCommitted)],
                      }));
                    }
                  }}
                  onBlur={() => {
                    setActionDrafts((current) => (
                      current[scopedKey]
                        ? { ...current, [scopedKey]: undefined }
                        : current
                    ));
                  }}
                />
              </label>
              {actionSlices.length > 0 ? (
                <div className="paragraph-action-preview" aria-label={`第 ${paragraphNumber} 段修改动作线型对应预览`}>
                  {actionSlices.map((slice, actionIndex) => {
                    const style = adviceUnderlineStyle(actionIndex);
                    const activeUnderline = actionUnderlines[actionIndex] ?? null;
                    const underlineStyles = activeUnderline
                      ? buildPreviewUnderlineStyles(activeUnderline, "#C00000")
                      : undefined;
                    return (
                      <div className="paragraph-action-preview__item" key={`${actionIndex}:${slice.body}`}>
                        <span className="paragraph-action-preview__badge">
                          第 {actionIndex + 1} 条·{UNDERLINE_STYLE_LABELS[style]}
                        </span>
                        <span
                          className="paragraph-action-preview__text"
                          data-action-underline={activeUnderline ?? "none"}
                          style={{
                            color: "#C00000",
                            fontWeight: 700,
                            ...underlineStyles,
                          }}
                        >{slice.body || "（待填写）"}</span>
                        {!activeUnderline ? (
                          <small className="paragraph-action-preview__hint">未关联正文标线</small>
                        ) : null}
                        {actionSlices.length > 1 ? (
                          <button
                            type="button"
                            className="paragraph-action-preview__remove"
                            aria-label={`删除第 ${paragraphNumber} 段第 ${actionIndex + 1} 条修改动作`}
                            disabled={disabled || rewriting}
                            onClick={() => handleRemoveAction(paragraphReview, group.sourceText, actionIndex)}
                          >删除此条</button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div> : null}

            <div className="paragraph-revision-block">
              <h4>【{revisionHeading}】</h4>
              <label><span className="visually-hidden">{revisionLabel}</span>
                <textarea
                  className="paragraph-revision-input"
                  aria-label={`第 ${paragraphNumber} 段${revisionLabel}`}
                  value={paragraphReview.revisedText}
                  disabled={disabled || rewriting}
                  onSelect={(event) => recordRangeSelection(
                    paragraphReview.paragraphId,
                    "textarea",
                    paragraphReview.revisedText,
                    event.currentTarget.selectionStart,
                    event.currentTarget.selectionEnd,
                  )}
                  onMouseUp={(event) => recordRangeSelection(
                    paragraphReview.paragraphId,
                    "textarea",
                    paragraphReview.revisedText,
                    event.currentTarget.selectionStart,
                    event.currentTarget.selectionEnd,
                  )}
                  onKeyUp={(event) => recordRangeSelection(
                    paragraphReview.paragraphId,
                    "textarea",
                    paragraphReview.revisedText,
                    event.currentTarget.selectionStart,
                    event.currentTarget.selectionEnd,
                  )}
                  onKeyDown={(event) => {
                    lastTextareaCaretRef.current[scopedKey] = {
                      start: event.currentTarget.selectionStart,
                      end: event.currentTarget.selectionEnd,
                      textSnapshot: paragraphReview.revisedText,
                    };
                  }}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    const trackedCaret = lastTextareaCaretRef.current[scopedKey];
                    let editHint: TextEditHint | null = null;
                    if (trackedCaret && trackedCaret.textSnapshot === paragraphReview.revisedText) {
                      if (trackedCaret.end > trackedCaret.start) {
                        editHint = { start: trackedCaret.start, end: trackedCaret.end };
                      } else if (nextValue.length < paragraphReview.revisedText.length) {
                        const caretAfter = event.currentTarget.selectionStart;
                        const delLen = paragraphReview.revisedText.length - nextValue.length;
                        if (caretAfter >= 0 && caretAfter + delLen <= paragraphReview.revisedText.length) {
                          editHint = { start: caretAfter, end: caretAfter + delLen };
                        }
                      } else if (nextValue.length > paragraphReview.revisedText.length) {
                        editHint = { start: trackedCaret.start, end: trackedCaret.start };
                      }
                    }
                    lastTextareaCaretRef.current[scopedKey] = {
                      start: event.currentTarget.selectionStart,
                      end: event.currentTarget.selectionEnd,
                      textSnapshot: nextValue,
                    };
                    setSelection((current) => (
                      current?.reviewId === reviewId && current.paragraphId === paragraphReview.paragraphId ? null : current
                    ));
                    setUnderlineHints((current) => ({ ...current, [scopedKey]: "" }));
                    updateParagraph(paragraphReview.paragraphId, (current) => ({
                      ...current,
                      revisedText: nextValue,
                      suggestions: reconcileQuotesOnRevisedTextChange(
                        current.revisedText,
                        nextValue,
                        current.suggestions,
                        editHint,
                      ),
                    }), true);
                  }}
                />
              </label>
            </div>

            {showSuggestions ? (
              <div className="underline-editor-toolbar" role="group" aria-label={`第 ${paragraphNumber} 段标线编辑工具栏`}>
                <span className="underline-editor-toolbar__status">
                  {actionSlices.length === 0
                    ? "当前为无需修改（无标线）"
                    : activeSelection
                    ? `已选「${truncateSnippet(paragraphReview.revisedText.slice(activeSelection.start, activeSelection.end))}」：`
                    : "标线编辑（拖选上方或下方文字后点按钮划线，或点「按句调标线」）："}
                </span>
                <div className="underline-editor-toolbar__buttons">
                  {actionSlices.map((_slice, actionIndex) => {
                    const style = adviceUnderlineStyle(actionIndex);
                    return (
                      <button
                        key={actionIndex}
                        type="button"
                        className="underline-brush-button"
                        data-brush-style={style}
                        aria-label={`第 ${paragraphNumber} 段选中文字划第 ${actionIndex + 1} 条标线`}
                        disabled={disabled || rewriting || !activeSelection}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          if (!activeSelection) return;
                          handlePaintRange(
                            paragraphReview,
                            group.sourceText,
                            activeSelection.start,
                            activeSelection.end,
                            actionIndex,
                          );
                        }}
                      >划第 {actionIndex + 1} 条·{UNDERLINE_STYLE_LABELS[style]}</button>
                    );
                  })}
                  {actionSlices.length > 0 ? (
                    <button
                      type="button"
                      className="underline-brush-button"
                      aria-label={`第 ${paragraphNumber} 段取消选中文字标线`}
                      disabled={disabled || rewriting || !activeSelection}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        if (!activeSelection) return;
                        handlePaintRange(
                          paragraphReview,
                          group.sourceText,
                          activeSelection.start,
                          activeSelection.end,
                          null,
                        );
                      }}
                    >取消选中标线</button>
                  ) : null}
                  {actionSlices.length > 0 ? (
                    <button
                      type="button"
                      className="underline-brush-button"
                      aria-label={`第 ${paragraphNumber} 段按句调整标线`}
                      aria-expanded={manualOpen}
                      disabled={disabled || rewriting}
                      onClick={() => setManualPanels((current) => ({
                        ...current,
                        [scopedKey]: !current[scopedKey],
                      }))}
                    >{manualOpen ? "收起按句调标线" : "按句调标线"}</button>
                  ) : null}
                  {actionSlices.length > 0 ? (
                    <button
                      type="button"
                      className="underline-brush-button"
                      aria-label={`第 ${paragraphNumber} 段清空全段标线`}
                      disabled={disabled || rewriting || (effectiveRanges.length === 0 && hasExplicitQuotes)}
                      onClick={() => {
                        if (actionSlices.length > MAX_ACTIONS_WITH_QUOTES) {
                          setUnderlineHints((current) => ({
                            ...current,
                            [scopedKey]: `单段修改动作最多支持 ${MAX_ACTIONS_WITH_QUOTES} 条`,
                          }));
                          return;
                        }
                        setUnderlineHints((current) => ({ ...current, [scopedKey]: "" }));
                        updateParagraph(paragraphReview.paragraphId, (current) => ({
                          ...current,
                          suggestions: withUpdatedUnderlineData(current.suggestions, {
                            revisedQuotes: Array.from({ length: actionSlices.length }, () => ""),
                            revisedRanges: [],
                          }),
                        }));
                      }}
                    >清空全段标线</button>
                  ) : null}
                  {actionSlices.length > 0 && hasExplicitQuotes ? (
                    <button
                      type="button"
                      className="underline-brush-button"
                      aria-label={`第 ${paragraphNumber} 段恢复自动标线`}
                      disabled={disabled || rewriting}
                      onClick={() => {
                        setUnderlineHints((current) => ({ ...current, [scopedKey]: "" }));
                        updateParagraph(paragraphReview.paragraphId, (current) => ({
                          ...current,
                          suggestions: withUpdatedUnderlineData(current.suggestions, { clearExplicit: true }),
                        }));
                      }}
                    >恢复自动标线</button>
                  ) : null}
                </div>
                {statusHint ? <p className="underline-editor-toolbar__hint" role="status">{statusHint}</p> : null}
              </div>
            ) : null}

            <RevisionPreview
              runs={previewRuns}
              sentenceHighlight
              onSelectRange={showSuggestions && !disabled && !rewriting ? (range) => {
                if (range) {
                  recordRangeSelection(
                    paragraphReview.paragraphId,
                    "preview",
                    paragraphReview.revisedText,
                    range.start,
                    range.end,
                  );
                } else {
                  setSelection((current) => (
                    current?.reviewId === reviewId
                    && current.paragraphId === paragraphReview.paragraphId
                    && current.source === "preview"
                      ? null
                      : current
                  ));
                }
              } : undefined}
            />

            {showSuggestions && manualOpen && actionSlices.length > 0 ? (
              <div className="underline-manual-panel" aria-label={`第 ${paragraphNumber} 段按句标线面板`}>
                <div className="underline-manual-panel__sentences">
                  {splitRevisedSentences(paragraphReview.revisedText).map((sentence, sentenceIdx) => {
                    let trimmedStart = sentence.start;
                    let trimmedEnd = sentence.end;
                    while (trimmedStart < trimmedEnd && /\s/u.test(paragraphReview.revisedText[trimmedStart]!)) trimmedStart += 1;
                    while (trimmedEnd > trimmedStart && /\s/u.test(paragraphReview.revisedText[trimmedEnd - 1]!)) trimmedEnd -= 1;
                    const overlapping = effectiveRanges.filter(
                      (range) => range.start < trimmedEnd && range.end > trimmedStart,
                    );
                    const fullMatch = overlapping.length === 1
                      && overlapping[0]!.start <= trimmedStart
                      && overlapping[0]!.end >= trimmedEnd
                      ? overlapping[0]!.actionIndex
                      : overlapping.length === 0
                      ? null
                      : "partial";
                    return (
                      <div className="underline-sentence-row" key={`${sentenceIdx}:${sentence.start}`}>
                        <span className="underline-sentence-row__text">{sentence.text}</span>
                        <div className="underline-sentence-row__pills">
                          <button
                            type="button"
                            aria-label={`第 ${paragraphNumber} 段第 ${sentenceIdx + 1} 句设为不划线`}
                            aria-pressed={fullMatch === null}
                            disabled={disabled || rewriting}
                            onClick={() => handlePaintRange(
                              paragraphReview,
                              group.sourceText,
                              sentence.start,
                              sentence.end,
                              null,
                            )}
                          >不划</button>
                          {actionSlices.map((_slice, actionIndex) => {
                            const style = adviceUnderlineStyle(actionIndex);
                            return (
                              <button
                                key={actionIndex}
                                type="button"
                                aria-label={`第 ${paragraphNumber} 段第 ${sentenceIdx + 1} 句设为第 ${actionIndex + 1} 条标线`}
                                aria-pressed={fullMatch === actionIndex}
                                disabled={disabled || rewriting}
                                onClick={() => handlePaintRange(
                                  paragraphReview,
                                  group.sourceText,
                                  sentence.start,
                                  sentence.end,
                                  actionIndex,
                                )}
                              >第 {actionIndex + 1} 条·{UNDERLINE_STYLE_LABELS[style]}</button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="underline-manual-panel__quotes">
                  {actionSlices.map((_slice, actionIndex) => {
                    const style = adviceUnderlineStyle(actionIndex);
                    const actionRanges = effectiveRanges.filter((range) => range.actionIndex === actionIndex);
                    return (
                      <div className="underline-quote-group" key={actionIndex}>
                        <span className="underline-quote-group__label">
                          第 {actionIndex + 1} 条（{UNDERLINE_STYLE_LABELS[style]}）已标：
                        </span>
                        {actionRanges.length === 0 ? (
                          <span className="underline-quote-group__empty">无</span>
                        ) : actionRanges.map((range, segIdx) => {
                          const segText = paragraphReview.revisedText.slice(range.start, range.end);
                          return (
                            <span className="underline-quote-chip" key={`${range.start}:${range.end}`}>
                              <span>{truncateSnippet(segText, 24)}</span>
                              <button
                                type="button"
                                aria-label={`移除第 ${paragraphNumber} 段第 ${actionIndex + 1} 条标线片段 ${segIdx + 1}`}
                                disabled={disabled || rewriting}
                                onClick={() => handlePaintRange(
                                  paragraphReview,
                                  group.sourceText,
                                  range.start,
                                  range.end,
                                  null,
                                )}
                              >×</button>
                            </span>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {onRewriteParagraph ? <div className="paragraph-rewrite-actions">
              <label>AI 修改要求（可选）
                <input
                  aria-label={`第 ${paragraphNumber} 段 AI 修改要求`}
                  value={instruction}
                  disabled={disabled || rewritingParagraphId !== null}
                  onChange={(event) => setInstructions((current) => ({
                    ...current,
                    [scopedKey]: event.target.value,
                  }))}
                />
              </label>
              <button
                type="button"
                aria-label={`重新生成第 ${paragraphNumber} 段`}
                disabled={disabled || rewritingParagraphId !== null}
                onClick={() => void onRewriteParagraph(paragraphReview.paragraphId)}
              >重新生成本段</button>
              <button
                type="button"
                aria-label={`按要求重写第 ${paragraphNumber} 段`}
                disabled={disabled || rewritingParagraphId !== null || !instruction.trim()}
                onClick={() => void onRewriteParagraph(paragraphReview.paragraphId, instruction.trim())}
              >{rewriting ? "AI 正在生成…" : "按要求修改"}</button>
            </div> : null}
          </section>
        );
      })}
    </div>
  );
}
