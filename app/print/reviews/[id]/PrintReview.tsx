import type { Annotation } from "@/src/domain/contracts";
import type { ReviewRecord } from "@/src/db/review-repository";

import styles from "./print.module.css";

function safeImageUrl(reviewId: string, imageId: number): string {
  return `/api/reviews/${encodeURIComponent(reviewId)}/files?imageId=${imageId}&variant=annotation`;
}

const themeLabels = {
  fits: "切题",
  partial: "部分切题",
  off_topic: "偏题",
} as const;

const scoreRows = [
  ["themeIntent", "主题立意", 10],
  ["contentSelection", "选材内容", 10],
  ["structure", "篇章结构", 8],
  ["languageExpression", "语言表达", 8],
  ["writingConventions", "书写规范", 4],
] as const;

function orderedAnnotations(annotations: Annotation[]) {
  return [...annotations]
    .sort((left, right) =>
      left.pageIndex - right.pageIndex ||
      left.y - right.y ||
      left.x - right.x,
    )
    .map((annotation, index) => ({ annotation, number: index + 1 }));
}

function ListSection({
  title,
  items,
  section,
}: {
  title: string;
  items: string[];
  section: string;
}) {
  return (
    <section className={styles.card} data-print-section={section}>
      <h2>{title}</h2>
      {items.length ? (
        <ul className={styles.textList}>
          {items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
        </ul>
      ) : <p className={styles.muted}>暂无</p>}
    </section>
  );
}

export function PrintReview({ review, imageSources }: { review: ReviewRecord; imageSources?: string[] }) {
  if (!review.report || review.images.length === 0) {
    throw new TypeError("print review requires report and images");
  }

  const report = review.report;
  const numbered = orderedAnnotations(review.annotations);

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
        <p className={styles.eyebrow}>作文批改报告</p>
        <h1>{review.config.title}</h1>
        <div className={styles.summaryGrid}>
          <div className={styles.totalScore} aria-label={`总分 ${report.scores.total} 分`}>
            <strong>{report.scores.total}</strong>
            <span>/ 40</span>
            <b>{report.scores.level}</b>
          </div>
          <div className={styles.overallComment}>
            <h2>总评</h2>
            <p>{report.personalizedComment}</p>
          </div>
        </div>
        <dl className={styles.assignmentInfo}>
          <div><dt>年级</dt><dd>{review.config.grade}</dd></div>
          <div><dt>目标字数</dt><dd>{review.config.targetCharacters} 字</dd></div>
          <div><dt>写作要求</dt><dd>{review.config.writingRequirements}</dd></div>
          <div><dt>结构要求</dt><dd>{review.config.structureRequirements}</dd></div>
        </dl>
      </section>

      {review.images.map((image, imageIndex) => {
        const pageAnnotations = numbered.filter(
          ({ annotation }) => annotation.pageIndex === image.position,
        );
        return (
          <section
            className={`${styles.sheet} ${styles.annotationPage}`}
            data-page-kind="annotation"
            data-print-section={`annotated-page-${imageIndex + 1}`}
            key={image.id}
          >
            <div className={styles.pageHeading}>
              <p className={styles.eyebrow}>逐页红批</p>
              <h2>原作文第 {imageIndex + 1} 页</h2>
            </div>
            <div className={styles.annotationLayout}>
              <figure className={styles.imageFigure}>
                {/* A native image is intentional: PdfService waits on document.images. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt={`第 ${imageIndex + 1} 页原作文`}
                  src={imageSources?.[imageIndex] ?? safeImageUrl(review.id, image.id)}
                />
                <svg
                  aria-hidden="true"
                  className={styles.annotationOverlay}
                  preserveAspectRatio="none"
                  viewBox="0 0 100 100"
                >
                  {pageAnnotations.map(({ annotation, number }) => (
                    <g key={`anchor-${number}`}>
                      <line
                        data-anchor-line="true"
                        x1={annotation.x * 100}
                        x2="100"
                        y1={annotation.y * 100}
                        y2={annotation.y * 100}
                      />
                      <circle
                        cx={annotation.x * 100}
                        cy={annotation.y * 100}
                        data-anchor-point="true"
                        r="1.8"
                      />
                      <text
                        x={annotation.x * 100}
                        y={annotation.y * 100}
                      >{number}</text>
                    </g>
                  ))}
                </svg>
              </figure>
              <aside className={styles.annotationNotes} aria-label={`第 ${imageIndex + 1} 页批注`}>
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
                ) : <p className={styles.muted}>本页无批注</p>}
              </aside>
            </div>
          </section>
        );
      })}

      <div className={styles.analysisPages} data-page-kind="analysis">
        <section className={`${styles.card} ${styles.themeCard}`} data-print-section="theme">
          <div>
            <p className={styles.eyebrow}>主题判断</p>
            <h2>{themeLabels[report.themeFit]}</h2>
          </div>
          <p>{report.themeReason}</p>
        </section>
        <ListSection title="核心痛点" items={report.painPoints} section="pain-points" />
        <ListSection title="共性问题" items={report.commonIssues} section="common-issues" />
        <ListSection title="修改建议" items={report.revisionSuggestions} section="suggestions" />
        <section className={styles.card} data-print-section="score-breakdown">
          <h2>分项明细</h2>
          <table className={styles.scoreTable}>
            <thead><tr><th>评分项</th><th>得分</th><th>满分</th></tr></thead>
            <tbody>
              {scoreRows.map(([key, label, maximum]) => (
                <tr key={key}>
                  <th scope="row">{label}</th>
                  <td>{report.scores[key]}</td>
                  <td>{maximum}</td>
                </tr>
              ))}
              <tr className={styles.totalRow}>
                <th scope="row">总分</th><td>{report.scores.total}</td><td>40</td>
              </tr>
            </tbody>
          </table>
        </section>
        <section className={styles.samples} data-print-section="sample-paragraphs">
          <p className={styles.eyebrow}>示范文</p>
          <h2>逐段修改示范</h2>
          {report.sampleParagraphs.map((paragraph, index) => (
            <article className={styles.sampleParagraph} data-testid="sample-paragraph" key={`${index}-${paragraph.title}`}>
              <h3>{paragraph.title}</h3>
              <p className={styles.sampleText}>{paragraph.text}</p>
              <p className={styles.sampleSuggestion} data-suggestion="true">
                <b>修改建议：</b>{paragraph.suggestion}
              </p>
            </article>
          ))}
        </section>
      </div>
    </article>
  );
}
