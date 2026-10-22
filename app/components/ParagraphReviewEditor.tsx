"use client";

import { useState } from "react";

import type { ParagraphEvaluationReport, ParagraphReview } from "@/src/domain/contracts";
import {
  applyEssayToParagraphReviews,
  essayDiffersFromParagraphReviews,
} from "@/src/domain/essay-paragraph-sync";
import { mergedParagraphAction } from "@/src/domain/paragraph-actions";
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
  const essayOutOfSync = essayDiffersFromParagraphReviews(report);
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
    onChange({
      ...report,
      paragraphReviews: report.paragraphReviews.map((review) => (
        review.paragraphId === paragraphId ? update(review) : review
      )),
    });
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
            <button type="button" disabled={disabled} onClick={() => onChange(applyEssayToParagraphReviews(report))}>同步到逐段</button>
            {essayOutOfSync ? <span className="essay-sync-hint">与逐段不一致</span> : null}
          </div>
          <span>共 {report.rewrittenEssay.length} 段 · {totalCharacters} 字（含标点）</span>
        </div>
        {report.rewrittenEssay.map((text, index) => <label key={index}>第 {index + 1} 段
          <textarea
            className="paragraph-revision-input"
            aria-label={`完整范文第 ${index + 1} 段`}
            value={text}
            disabled={disabled}
            onChange={(event) => {
            const nextText = event.target.value;
            onChange({
              ...report,
              rewrittenEssay: report.rewrittenEssay!.map((current, i) => i === index ? nextText : current),
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

              {showSuggestions ? <div className="paragraph-suggestion">
                <h4>【修改动作】</h4>
                <label>修改动作
                  <textarea
                    aria-label={`第 ${paragraphNumber} 段修改动作`}
                    value={mergedParagraphAction(paragraphReview.suggestions)}
                    disabled={disabled || rewriting}
                    onChange={(event) => updateParagraph(paragraphReview.paragraphId, (current) => ({
                      ...current,
                      suggestions: [{ advice: event.target.value }],
                    }))}
                  />
                </label>
              </div> : null}

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
