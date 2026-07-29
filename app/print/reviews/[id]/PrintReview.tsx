import type { ReviewView } from "@/app/lib/types";
import { gradeFromLegacyTotal } from "@/src/domain/contracts";

import styles from "./print.module.css";

function summaryDensity(textLength: number): "normal" | "compact" | "dense" {
  if (textLength > 900) return "dense";
  if (textLength > 450) return "compact";
  return "normal";
}

function summaryClass(density: "normal" | "compact" | "dense", styles: Record<string, string>): string {
  if (density === "dense") return styles.summaryDense;
  if (density === "compact") return styles.summaryCompact;
  return "";
}

const pointLabels = ["一", "二", "三", "四", "五", "六"] as const;

function summaryItems(value: string | string[]): string[] {
  const rawItems = Array.isArray(value) ? value : value.split(/\r?\n/u);
  return rawItems.map((item) => item.trim()).filter(Boolean).slice(0, pointLabels.length);
}

function splitLegacyComment(comment: string): { strengths: string; improvement: string } {
  const marker = /(?:现在)?最需要(?:调整|改进|加强)(?:的是)?[：:，,]?/u;
  const match = marker.exec(comment);
  if (!match || match.index === undefined) {
    return { strengths: comment, improvement: "" };
  }
  return {
    strengths: comment.slice(0, match.index).trim(),
    improvement: comment.slice(match.index).trim(),
  };
}

function SummaryPoints({ items }: { items: string[] }) {
  return (
    <ol className={styles.summaryPoints}>
      {items.map((item, index) => (
        <li key={`${index}-${item}`}>
          <span>{pointLabels[index]}、</span>
          <p>{item}</p>
        </li>
      ))}
    </ol>
  );
}

function sampleParagraphsForPage<T>(paragraphs: T[], pageIndex: number, pageCount: number): T[] {
  return paragraphs.filter((_, index) => Math.floor((index * pageCount) / paragraphs.length) === pageIndex);
}

type PrintableReview = Pick<ReviewView, "images" | "report">;

export function PrintReview({ review, imageSources }: { review: PrintableReview; imageSources: string[] }) {
  if (!review.report || review.images.length === 0) {
    throw new TypeError("print review requires report and images");
  }

  const report = review.report;
  const grade = report.grade ?? gradeFromLegacyTotal(report.scores?.total ?? 0);
  const personalized = splitLegacyComment(report.personalizedComment);
  const strengths = summaryItems(personalized.strengths);
  const improvements = summaryItems([personalized.improvement, ...report.painPoints]);
  const strengthsDensity = summaryDensity(strengths.reduce((sum, item) => sum + Array.from(item).length, 0));
  const improvementsDensity = summaryDensity(improvements.reduce((sum, item) => sum + Array.from(item).length, 0));
  return (
    <article className={styles.document} data-print-ready="true">
      <section
        className={`${styles.sheet} ${styles.summary} ${summaryClass(strengthsDensity, styles)}`}
        data-page-kind="summary"
        data-print-section="strengths"
        data-summary-density={strengthsDensity}
      >
        <div className={styles.summaryContent}>
          <p className={styles.gradeBadge}>等级评定 · {grade}{grade === "C" ? "（重写）" : ""}</p>
          <h1>优点</h1>
          <SummaryPoints items={strengths} />
        </div>
      </section>
      <section
        className={`${styles.sheet} ${styles.summary} ${summaryClass(improvementsDensity, styles)}`}
        data-page-kind="summary"
        data-print-section="improvements"
        data-summary-density={improvementsDensity}
      >
        <div className={styles.summaryContent}>
          <h1>需要修改</h1>
          <SummaryPoints items={improvements} />
        </div>
      </section>
      {review.images.map((image, pageIndex) => {
        const samples = sampleParagraphsForPage(report.sampleParagraphs, pageIndex, review.images.length);
        return (
          <section
            className={`${styles.sheet} ${styles.feedbackPage}`}
            data-page-kind="feedback"
            data-print-section={`feedback-page-${pageIndex + 1}`}
            data-print-final={pageIndex === review.images.length - 1 ? "true" : undefined}
            key={image.id}
          >
            <div className={styles.feedbackLayout}>
              <aside className={styles.suggestionColumn} aria-label={`第 ${pageIndex + 1} 页段落修改建议`}>
                {samples.map((paragraph, index) => (
                  <article className={styles.suggestionParagraph} data-testid="sample-suggestion" key={`${pageIndex}-${index}-${paragraph.title}`}>
                    <h3>{paragraph.title}修改建议：</h3>
                    <p>{paragraph.suggestion}</p>
                  </article>
                ))}
              </aside>
              <figure className={styles.imageFigure}>
                {/* A native image is intentional: PdfService waits on document.images. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt={`第 ${pageIndex + 1} 页原作文`} src={imageSources[pageIndex]} />
              </figure>
              <aside className={styles.modelColumn} aria-label={`第 ${pageIndex + 1} 页考场范文`}>
                {pageIndex === 0 ? <h2>改后范文</h2> : null}
                {samples.map((paragraph, index) => (
                  <article className={styles.modelParagraph} data-testid="sample-paragraph" key={`${pageIndex}-${index}-${paragraph.title}`}>
                    <h4>{paragraph.title}</h4>
                    <p>{paragraph.text}</p>
                  </article>
                ))}
              </aside>
            </div>
          </section>
        );
      })}
    </article>
  );
}
