"use client";

import { useState } from "react";

import type { ParagraphEvaluationReport, ParagraphReview } from "@/src/domain/contracts";
import type { PublicOcrView } from "@/src/ocr/contracts";
import { buildRevisionRuns } from "@/src/revisions/revision-diff";
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
}

const emptySuggestion = { problem: "", advice: "", example: "" };

export function ParagraphReviewEditor({
  reviewId,
  report,
  ocr,
  images,
  disabled,
  onChange,
  onRewriteParagraph,
  rewritingParagraphId = null,
}: ParagraphReviewEditorProps) {
  const [instructions, setInstructions] = useState<Record<string, string>>({});

  function updateParagraph(
    paragraphId: string,
    update: (review: ParagraphReview) => ParagraphReview,
  ) {
    onChange({
      ...report,
      paragraphReviews: report.paragraphReviews.map((review) => (
        review.paragraphId === paragraphId ? update(review) : review
      )),
    });
  }

  return (
    <div className="paragraph-review-editor">
      {[...ocr.paragraphs]
        .sort((left, right) => left.paragraphIndex - right.paragraphIndex)
        .map((paragraph) => {
          const paragraphReview = report.paragraphReviews.find(
            ({ paragraphId }) => paragraphId === paragraph.id,
          );
          const paragraphNumber = paragraph.paragraphIndex + 1;
          if (!paragraphReview) {
            return <div className="paragraph-review-error" role="alert" key={paragraph.id}>
              第 {paragraphNumber} 段缺少逐段批改
            </div>;
          }
          const instruction = instructions[paragraph.id] ?? "";
          const rewriting = rewritingParagraphId === paragraph.id;
          return (
            <section
              className="paragraph-review-unit"
              data-paragraph-id={paragraph.id}
              key={paragraph.id}
            >
              <h3>【第 {paragraphNumber} 段】</h3>
              <ParagraphCropPreview
                reviewId={reviewId}
                paragraphNumber={paragraphNumber}
                images={images}
                segments={paragraph.segments}
              />

              <h4>【修改建议】</h4>
              <div className="paragraph-suggestion-list">
                {paragraphReview.suggestions.map((suggestion, suggestionIndex) => (
                  <fieldset className="paragraph-suggestion" key={suggestionIndex}>
                    <legend>建议 {suggestionIndex + 1}</legend>
                    <label>问题描述
                      <input
                        aria-label={`第 ${paragraphNumber} 段第 ${suggestionIndex + 1} 条问题描述`}
                        value={suggestion.problem}
                        disabled={disabled || rewriting}
                        onChange={(event) => updateParagraph(paragraph.id, (current) => ({
                          ...current,
                          suggestions: current.suggestions.map((item, index) => index === suggestionIndex
                            ? { ...item, problem: event.target.value }
                            : item),
                        }))}
                      />
                    </label>
                    <label>修改动作
                      <input
                        aria-label={`第 ${paragraphNumber} 段第 ${suggestionIndex + 1} 条修改动作`}
                        value={suggestion.advice}
                        disabled={disabled || rewriting}
                        onChange={(event) => updateParagraph(paragraph.id, (current) => ({
                          ...current,
                          suggestions: current.suggestions.map((item, index) => index === suggestionIndex
                            ? { ...item, advice: event.target.value }
                            : item),
                        }))}
                      />
                    </label>
                    <label>修改示例
                      <textarea
                        aria-label={`第 ${paragraphNumber} 段第 ${suggestionIndex + 1} 条修改示例`}
                        value={suggestion.example}
                        disabled={disabled || rewriting}
                        onChange={(event) => updateParagraph(paragraph.id, (current) => ({
                          ...current,
                          suggestions: current.suggestions.map((item, index) => index === suggestionIndex
                            ? { ...item, example: event.target.value }
                            : item),
                        }))}
                      />
                    </label>
                    <button
                      type="button"
                      aria-label={`删除第 ${paragraphNumber} 段第 ${suggestionIndex + 1} 条建议`}
                      disabled={disabled || rewriting || paragraphReview.suggestions.length <= 1}
                      onClick={() => updateParagraph(paragraph.id, (current) => ({
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
                onClick={() => updateParagraph(paragraph.id, (current) => ({
                  ...current,
                  suggestions: [...current.suggestions, emptySuggestion],
                }))}
              >新增建议</button>

              <h4>【修改后段落】</h4>
              <label>完整修改稿
                <textarea
                  className="paragraph-revision-input"
                  aria-label={`第 ${paragraphNumber} 段修改稿`}
                  value={paragraphReview.revisedText}
                  disabled={disabled || rewriting}
                  onChange={(event) => updateParagraph(paragraph.id, (current) => ({
                    ...current,
                    revisedText: event.target.value,
                  }))}
                />
              </label>
              <RevisionPreview runs={buildRevisionRuns(paragraph.text, paragraphReview.revisedText)} />
              {onRewriteParagraph ? <div className="paragraph-rewrite-actions">
                <label>AI 修改要求（可选）
                  <input
                    aria-label={`第 ${paragraphNumber} 段 AI 修改要求`}
                    value={instruction}
                    disabled={disabled || rewritingParagraphId !== null}
                    onChange={(event) => setInstructions((current) => ({
                      ...current,
                      [paragraph.id]: event.target.value,
                    }))}
                  />
                </label>
                <button
                  type="button"
                  aria-label={`重新生成第 ${paragraphNumber} 段`}
                  disabled={disabled || rewritingParagraphId !== null}
                  onClick={() => void onRewriteParagraph(paragraph.id)}
                >重新生成本段</button>
                <button
                  type="button"
                  aria-label={`按要求重写第 ${paragraphNumber} 段`}
                  disabled={disabled || rewritingParagraphId !== null || !instruction.trim()}
                  onClick={() => void onRewriteParagraph(paragraph.id, instruction.trim())}
                >{rewriting ? "AI 正在生成…" : "按要求修改"}</button>
              </div> : null}
            </section>
          );
        })}
    </div>
  );
}
