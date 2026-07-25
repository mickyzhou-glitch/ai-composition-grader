import type { Annotation } from "@/src/domain/contracts";
import type { ReviewRecord } from "@/src/db/review-repository";

import styles from "./print.module.css";

function orderedAnnotations(annotations: Annotation[]) {
  return [...annotations]
    .sort((left, right) =>
      left.pageIndex - right.pageIndex || left.y - right.y || left.x - right.x,
    )
    .map((annotation, index) => ({ annotation, number: index + 1 }));
}

function sampleParagraphsForPage<T>(paragraphs: T[], pageIndex: number, pageCount: number): T[] {
  return paragraphs.filter((_, index) => Math.floor((index * pageCount) / paragraphs.length) === pageIndex);
}

export function PrintReview({ review, imageSources }: { review: ReviewRecord; imageSources: string[] }) {
  if (!review.report || review.images.length === 0) {
    throw new TypeError("print review requires report and images");
  }

  const report = review.report;
  const numbered = orderedAnnotations(review.annotations.filter((annotation) => annotation.category === "structure"));
  return (
    <article className={styles.document} data-print-ready="true">
      <section className={`${styles.sheet} ${styles.summary}`} data-page-kind="summary" data-print-section="summary">
        <div className={styles.summaryContent}>
          <h1>总体评价</h1>
          <p><b>优点：</b>{report.themeReason} {report.personalizedComment}</p>
          <p><b>需要改进：</b>{report.painPoints.length ? report.painPoints.join("；") : "继续把关键情节写得更具体，让前后衔接更自然。"}</p>
        </div>
      </section>
      {review.images.map((image, pageIndex) => {
        const pageAnnotations = numbered.filter(({ annotation }) => annotation.pageIndex === image.position);
        const samples = sampleParagraphsForPage(report.sampleParagraphs, pageIndex, review.images.length);
        return (
          <section
            className={`${styles.sheet} ${styles.feedbackPage}`}
            data-page-kind="feedback"
            data-print-section={`feedback-page-${pageIndex + 1}`}
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
                <svg aria-hidden="true" className={styles.annotationOverlay} preserveAspectRatio="none" viewBox="0 0 100 100">
                  {pageAnnotations.map(({ annotation, number }) => (
                    <g key={`issue-${number}`}>
                      <ellipse data-issue-circle="true" cx={annotation.x * 100} cy={annotation.y * 100} rx="4.2" ry="2.4" />
                      <line data-issue-underline="true" x1={Math.max(0, annotation.x * 100 - 5)} y1={Math.min(99, annotation.y * 100 + 3)} x2={Math.min(100, annotation.x * 100 + 5)} y2={Math.min(99, annotation.y * 100 + 3)} />
                    </g>
                  ))}
                </svg>
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
