"use client";

import { useState } from "react";

import type { ParagraphEvaluationReport, ParagraphReview } from "@/src/domain/contracts";
import { paragraphReviewUsesGroups, resolveReviewGroups } from "@/src/domain/paragraph-review-groups";
import { countTextCharactersIncludingPunctuation } from "@/src/domain/sample-writing-requirements";
import type { PublicOcrView } from "@/src/ocr/contracts";
import { buildSentenceRevisionRuns } from "@/src/revisions/revision-diff";
import type { ReviewImageView } from "../lib/types";
import { ParagraphCropPreview } from "./ParagraphCropPreview";
import { RevisionPreview } from "./RevisionPreview";

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

const emptySuggestion = { advice: "" };

export function ParagraphReviewEditor({
  reviewId,
  report,
  ocr,
  images,
  disabled,
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
  const paragraphs = [...ocr.paragraphs]
    .sort((left, right) => left.paragraphIndex - right.paragraphIndex);
  const grouped = paragraphReviewUsesGroups(report.paragraphReviews);
  const groups = resolveReviewGroups(report.paragraphReviews, paragraphs);
  const essayAligned = grouped
    && report.rewrittenEssay?.length === report.paragraphReviews.length;
  const totalCharacters = report.rewrittenEssay
    ? report.rewrittenEssay.reduce((total, text) => total + countTextCharactersIncludingPunctuation(text), 0)
    : paragraphs.reduce((total, paragraph) => {
    const paragraphReview = report.paragraphReviews.find(
      ({ paragraphId }) => paragraphId === paragraph.id,
    );
    return total + countTextCharactersIncludingPunctuation(paragraphReview?.revisedText ?? "");
  }, 0);

  function updateParagraph(
    paragraphId: string,
    update: (review: ParagraphReview) => ParagraphReview,
  ) {
    const paragraphReviews = report.paragraphReviews.map((review) => (
      review.paragraphId === paragraphId ? update(review) : review
    ));
    onChange({
      ...report,
      paragraphReviews,
      rewrittenEssay: essayAligned
        ? paragraphReviews.map((review) => review.revisedText)
        : report.rewrittenEssay,
    });
  }

  return (
    <div className="paragraph-review-editor">
      {showCharacterCounts ? <div className="paragraph-review-total">
        {report.rewrittenEssay ? "完整范文" : "改后全段"}总字数 <strong>{totalCharacters}</strong> 字（含标点）
      </div> : null}
      {report.rewrittenEssay ? <section className="paragraph-review-unit" aria-label="完整范文">
        <div className="paragraph-review-heading">
          <h3>按要求重写的完整范文</h3>
          <span>共 {report.rewrittenEssay.length} 段 · {totalCharacters} 字（含标点）</span>
        </div>
        {report.rewrittenEssay.map((text, index) => <label key={index}>第 {index + 1} 段
          <textarea
            className="paragraph-revision-input"
            aria-label={`完整范文第 ${index + 1} 段`}
            value={text}
            disabled={disabled}
            onChange={(event) => {
            const rewrittenEssay = report.rewrittenEssay!.map((current, i) => i === index ? event.target.value : current);
            onChange({
              ...report,
              rewrittenEssay,
              paragraphReviews: essayAligned
                ? report.paragraphReviews.map((review, reviewIndex) => (
                  reviewIndex === index ? { ...review, revisedText: event.target.value } : review
                ))
                : report.paragraphReviews,
            });
          }}
          />
        </label>)}
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
        const paragraphNumber = grouped ? index + 1 : group.paragraphs[0].paragraphIndex + 1;
        const instruction = instructions[paragraphReview.paragraphId] ?? "";
        const rewriting = rewritingParagraphId === paragraphReview.paragraphId;
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

              {showSuggestions ? <>
                <h4>【修改动作】</h4>
                <div className="paragraph-suggestion-list">
                  {paragraphReview.suggestions.map((suggestion, suggestionIndex) => (
                    <fieldset className="paragraph-suggestion" key={suggestionIndex}>
                      <legend>建议 {suggestionIndex + 1}</legend>
                      <label>修改动作
                        <input
                          aria-label={`第 ${paragraphNumber} 段第 ${suggestionIndex + 1} 条修改动作`}
                          value={suggestion.advice}
                          disabled={disabled || rewriting}
                          onChange={(event) => updateParagraph(paragraphReview.paragraphId, (current) => ({
                            ...current,
                            suggestions: current.suggestions.map((item, index) => index === suggestionIndex
                              ? { ...item, advice: event.target.value }
                              : item),
                          }))}
                        />
                      </label>
                      <button
                        type="button"
                        aria-label={`删除第 ${paragraphNumber} 段第 ${suggestionIndex + 1} 条建议`}
                        disabled={disabled || rewriting || paragraphReview.suggestions.length <= 1}
                        onClick={() => updateParagraph(paragraphReview.paragraphId, (current) => ({
                          ...current,
                          suggestions: current.suggestions.filter((_, index) => index !== suggestionIndex),
                        }))}
                      >删除建议</button>
                    </fieldset>
                  ))}
                </div>
                <button
                  type="button"
                  aria-label={`新增第 ${paragraphNumber} 段建议`}
                  disabled={disabled || rewriting || paragraphReview.suggestions.length >= 4}
                  onClick={() => updateParagraph(paragraphReview.paragraphId, (current) => ({
                    ...current,
                    suggestions: [...current.suggestions, emptySuggestion],
                  }))}
                >新增建议</button>
              </> : null}

              <h4>【{revisionHeading}】</h4>
              <label>{revisionLabel}
                <textarea
                  className="paragraph-revision-input"
                  aria-label={`第 ${paragraphNumber} 段${revisionLabel}`}
                  value={paragraphReview.revisedText}
                  disabled={disabled || rewriting}
                  onChange={(event) => updateParagraph(paragraphReview.paragraphId, (current) => ({
                    ...current,
                    revisedText: event.target.value,
                  }))}
                />
              </label>
              <RevisionPreview
                runs={buildSentenceRevisionRuns(group.sourceText, paragraphReview.revisedText)}
                sentenceHighlight
              />
              {onRewriteParagraph ? <div className="paragraph-rewrite-actions">
                <label>AI 修改要求（可选）
                  <input
                    aria-label={`第 ${paragraphNumber} 段 AI 修改要求`}
                    value={instruction}
                    disabled={disabled || rewritingParagraphId !== null}
                    onChange={(event) => setInstructions((current) => ({
                      ...current,
                      [paragraphReview.paragraphId]: event.target.value,
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
