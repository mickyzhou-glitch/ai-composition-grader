import type { ReviewRecord } from "@/src/db/review-repository";

import styles from "./print.module.css";

const themeLabels = {
  fits: "切题",
  partial: "部分切题",
  off_topic: "偏题",
} as const;

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

export function PrintReview({ review }: { review: ReviewRecord }) {
  if (!review.report || review.images.length === 0) {
    throw new TypeError("print review requires report and images");
  }

  const report = review.report;
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
          <div className={styles.levelBadge} aria-label="作文等级">
            <span>作文等级</span>
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
