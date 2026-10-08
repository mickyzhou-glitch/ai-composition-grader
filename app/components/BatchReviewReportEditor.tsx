"use client";

import {
  isLegacyEvaluationReport,
  type EvaluationReport,
  type LegacyEvaluationReport,
} from "@/src/domain/contracts";
import { countTextCharactersIncludingPunctuation } from "@/src/domain/sample-writing-requirements";
import type { PublicOcrView } from "@/src/ocr/contracts";
import type { ReviewImageView } from "../lib/types";
import { ParagraphReviewEditor } from "./ParagraphReviewEditor";

interface BatchReviewReportEditorProps {
  report: EvaluationReport;
  reviewId: string;
  ocr: PublicOcrView | null;
  images: ReviewImageView[];
  disabled: boolean;
  onChange: (report: EvaluationReport) => void;
}

export function BatchReviewReportEditor({
  report,
  reviewId,
  ocr,
  images,
  disabled,
  onChange,
}: BatchReviewReportEditorProps) {
  if (!isLegacyEvaluationReport(report)) {
    if (!ocr || ocr.version !== 2) {
      return <div className="paragraph-review-error" role="alert">
        逐段批改需要当前自然段识别结果
      </div>;
    }
    return (
      <div className="report-editor batch-report-editor">
        <header className="report-version-heading batch-report-heading">
          <p className="eyebrow">逐段审核</p>
          <h2>修改意见与示范文</h2>
        </header>
        <ParagraphReviewEditor
          reviewId={reviewId}
          report={report}
          ocr={ocr}
          images={images}
          disabled={disabled}
          onChange={onChange}
          showSourceCrops={false}
          showCharacterCounts
          revisionHeading="示范文"
          revisionLabel="完整示范文"
          revisionHighlight="sentences"
        />
      </div>
    );
  }

  const totalCharacters = report.sampleParagraphs.reduce(
    (total, paragraph) => total + countTextCharactersIncludingPunctuation(paragraph.text),
    0,
  );
  const updateSample = (
    index: number,
    change: Partial<LegacyEvaluationReport["sampleParagraphs"][number]>,
  ) => {
    onChange({
      ...report,
      sampleParagraphs: report.sampleParagraphs.map((sample, sampleIndex) => (
        sampleIndex === index ? { ...sample, ...change } : sample
      )),
    });
  };

  return (
    <div className="report-editor batch-report-editor">
      <header className="report-version-heading batch-report-heading">
        <p className="eyebrow">逐段审核</p>
        <h2>修改意见与示范文</h2>
      </header>
      <div className="paragraph-review-total">
        示范文总字数 <strong>{totalCharacters}</strong> 字（含标点）
      </div>
      <p className="batch-legacy-note">
        这篇作文使用旧版报告，未保存逐字标色；重新分析后可显示红黑修改标记。
      </p>
      <div className="paragraph-review-editor">
        {report.sampleParagraphs.map((sample, index) => (
          <section className="paragraph-review-unit batch-legacy-paragraph" key={index}>
            <div className="paragraph-review-heading">
              <h3>第 {index + 1} 段</h3>
              <span>示范文 <strong>{countTextCharactersIncludingPunctuation(sample.text)}</strong> 字（含标点）</span>
            </div>
            <label>修改意见
              <textarea
                value={sample.suggestion}
                disabled={disabled}
                onChange={(event) => updateSample(index, { suggestion: event.target.value })}
              />
            </label>
            <h4>【示范文】</h4>
            <label>完整示范文
              <textarea
                className="paragraph-revision-input"
                value={sample.text}
                disabled={disabled}
                onChange={(event) => updateSample(index, { text: event.target.value })}
              />
            </label>
            <div className="revision-preview">{sample.text}</div>
          </section>
        ))}
      </div>
    </div>
  );
}
