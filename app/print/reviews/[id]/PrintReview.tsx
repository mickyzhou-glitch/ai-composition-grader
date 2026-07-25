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
  const numbered = orderedAnnotations(review.annotations.filter((annotation) => !annotation.isHighlight));
  return (
    <article className={styles.document} data-print-ready="true">
      <header className={styles.runningHeader} aria-hidden="true">
        <span>作文批改报告</span>
        <b>{review.config.title}</b>
      </header>
      <section
        className={`${styles.sheet} ${styles.summary}`}
        data-page-kind="summary"
        data-print-section="summary"
      >
        <p className={styles.eyebrow}>小升初作文批改</p>
        <h1>{review.config.title}</h1>
        <div className={styles.summaryGrid}>
          <div className={styles.overallComment}>
            <h2>总评</h2>
            <p>{report.personalizedComment}</p>
          </div>
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
            <div className={styles.feedbackHeading}>
              <p className={styles.eyebrow}>五段式学习单</p>
              <h2>第 {pageIndex + 1} 页：考场范文、原文问题与修改</h2>
            </div>
            <div className={styles.feedbackLayout}>
              <aside className={styles.sampleColumn} aria-label={`第 ${pageIndex + 1} 页示范文章`}>
                <h3>示范文章</h3>
                {samples.map((paragraph, index) => (
                  <article className={styles.sampleParagraph} data-testid="sample-paragraph" key={`${pageIndex}-${index}-${paragraph.title}`}>
                    <h4>{paragraph.title}</h4>
                    <p className={styles.sampleText}>{paragraph.text}</p>
                  </article>
                ))}
              </aside>
              <figure className={styles.imageFigure}>
                {/* A native image is intentional: PdfService waits on document.images. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt={`第 ${pageIndex + 1} 页原作文`} src={imageSources[pageIndex]} />
                <svg aria-hidden="true" className={styles.annotationOverlay} preserveAspectRatio="none" viewBox="0 0 100 100">
                  {pageAnnotations.map(({ annotation, number }) => (
                    <line
                      data-issue-underline="true"
                      key={`issue-${number}`}
                      x1={Math.max(0, annotation.x * 100 - 5)}
                      y1={Math.min(99, annotation.y * 100 + 2)}
                      x2={Math.min(100, annotation.x * 100 + 5)}
                      y2={Math.min(99, annotation.y * 100 + 2)}
                    />
                  ))}
                </svg>
              </figure>
              <aside className={styles.annotationNotes} aria-label={`第 ${pageIndex + 1} 页修改建议`}>
                <h3>修改建议</h3>
                {pageAnnotations.length ? (
                  <ol>
                    {pageAnnotations.map(({ annotation, number }) => (
                      <li data-annotation-number={number} key={`note-${number}`}>
                        <span>{number}</span>
                        <div>
                          {annotation.anchorText ? <b>{annotation.anchorText}</b> : null}
                          <p>{annotation.comment}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : <p className={styles.muted}>这一页没有需要重点修改的问题。</p>}
              </aside>
            </div>
          </section>
        );
      })}
    </article>
  );
}
