import type { ReviewView } from "@/app/lib/types";

import styles from "./print.module.css";

function sampleParagraphsForPage<T>(paragraphs: T[], pageIndex: number, pageCount: number): T[] {
  return paragraphs.filter((_, index) => Math.floor((index * pageCount) / paragraphs.length) === pageIndex);
}

type PrintableReview = Pick<ReviewView, "images" | "report">;

export function PrintReview({ review, imageSources }: { review: PrintableReview; imageSources: string[] }) {
  if (!review.report || review.images.length === 0) {
    throw new TypeError("print review requires report and images");
  }

  const report = review.report;
  return (
    <article className={styles.document} data-print-ready="true">
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
