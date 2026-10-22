import type { DeliveryDocument } from "@/src/delivery/contracts";
import { paginateDeliveryDocument, type DeliveryPageBlock } from "@/app/lib/delivery-pagination";

import styles from "./print.module.css";

function sectionHeading(
  block: Extract<DeliveryPageBlock, { kind: "paragraph-heading" | "suggestion-heading" | "revision-heading" }>,
) {
  if (block.kind === "paragraph-heading") {
    const range = block.sourceLabel ? ` ${block.sourceLabel}` : "";
    return `【${block.essayParagraphNumber ? "完整范文·" : ""}第 ${block.essayParagraphNumber ?? block.paragraphNumber} 段${block.continued ? "（续）" : ""}】${range}`;
  }
  const title = block.kind === "suggestion-heading" ? "修改动作" : "改后全段";
  return `【${title}${block.continued ? "（续）" : ""}】`;
}

export function PrintReview({
  document,
  cropSources,
}: {
  document: DeliveryDocument;
  cropSources: string[][];
}) {
  const pages = paginateDeliveryDocument(document);

  return (
    <article className={styles.document} data-print-ready="true">
      {pages.map((page, pageIndex) => {
        let paragraphNumber = 0;
        return (
          <section
            className={styles.sheet}
            data-print-section={`page-${page.pageNumber}`}
            data-print-final={pageIndex === pages.length - 1 ? "true" : undefined}
            key={page.pageNumber}
          >
            {page.hasDocumentTitle ? <h1 className={styles.title}>{document.title}</h1> : null}
            {page.blocks.map((block, blockIndex) => {
              if (block.kind === "paragraph-heading") {
                paragraphNumber = block.paragraphNumber;
                return <h2 className={styles.sectionHeading} style={{ height: `${block.heightMm}mm` }} key={blockIndex}>{sectionHeading(block)}</h2>;
              }
              const paragraphIndex = document.paragraphs.findIndex((paragraph) => (
                paragraph.paragraphNumber === paragraphNumber
              ));
              const paragraph = document.paragraphs[paragraphIndex];
              if (!paragraph) throw new TypeError("逐段打印内容不完整");
              if (block.kind === "crop") {
                const crop = paragraph.crops[block.cropIndex];
                const source = cropSources[paragraphIndex]?.[block.cropIndex];
                if (!crop || !source) throw new TypeError("原文裁图不完整");
                return <figure className={styles.cropFigure} style={{ height: `${block.heightMm}mm` }} key={blockIndex}>
                  {/* Canvas-generated object URLs intentionally bypass Next image optimization. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    alt={`第 ${paragraph.paragraphNumber} 段原文裁图，第 ${crop.pageIndex + 1} 页`}
                    src={source}
                    style={{ width: `${block.widthMm}mm`, height: `${block.heightMm}mm` }}
                  />
                </figure>;
              }
              if (block.kind === "suggestion-heading" || block.kind === "revision-heading") {
                return <h2 className={styles.sectionHeading} style={{ height: `${block.heightMm}mm` }} key={blockIndex}>{sectionHeading(block)}</h2>;
              }
              if (block.kind === "suggestion") {
                const suggestion = paragraph.suggestions[block.suggestionIndex];
                if (!suggestion) throw new TypeError("修改建议不完整");
                return <ol className={styles.suggestions} start={block.suggestionIndex + 1} style={{ height: `${block.heightMm}mm` }} key={blockIndex}>
                  <li>
                    <p>{suggestion.advice}</p>
                  </li>
                </ol>;
              }
              return <p className={styles.revision} style={{ height: `${block.heightMm}mm` }} key={blockIndex}>
                {block.runs
                  .filter((run) => run.kind !== "deleted")
                  .map((run, runIndex) => (
                    <span
                      className={run.kind === "inserted" ? styles.inserted : undefined}
                      data-run-kind={run.kind}
                      key={runIndex}
                    >{run.text}</span>
                  ))}
              </p>;
            })}
          </section>
        );
      })}
    </article>
  );
}
