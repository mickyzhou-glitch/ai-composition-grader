"use client";

import type { MouseEvent, PointerEvent as ReactPointerEvent } from "react";

import type { Annotation } from "@/src/domain/contracts";

interface RectLike { left: number; top: number; width: number; height: number }

export function normalizedPoint(
  point: { clientX: number; clientY: number },
  rect: RectLike,
) {
  const safeWidth = Math.max(1, rect.width);
  const safeHeight = Math.max(1, rect.height);
  return {
    x: Math.max(0, Math.min(1, (point.clientX - rect.left) / safeWidth)),
    y: Math.max(0, Math.min(1, (point.clientY - rect.top) / safeHeight)),
  };
}

const categoryLabels: Record<Annotation["category"], string> = {
  typo: "错别字",
  punctuation: "标点",
  sentence: "病句",
  expression: "表达",
  structure: "结构",
  highlight: "亮点",
};

interface PhotoAnnotationEditorProps {
  imageUrl: string;
  pageIndex: number;
  annotations: Annotation[];
  onChange: (annotations: Annotation[]) => void;
}

export function PhotoAnnotationEditor({ imageUrl, pageIndex, annotations, onChange }: PhotoAnnotationEditorProps) {
  const pageAnnotations = annotations
    .map((annotation, index) => ({ annotation, index }))
    .filter(({ annotation }) => annotation.pageIndex === pageIndex)
    .sort((left, right) => left.annotation.y - right.annotation.y);

  function replace(index: number, change: Partial<Annotation>) {
    onChange(annotations.map((annotation, current) => current === index ? { ...annotation, ...change } : annotation));
  }

  function add(event: MouseEvent<HTMLDivElement>) {
    if ((event.target as Element).closest("button")) return;
    const point = normalizedPoint(event, event.currentTarget.getBoundingClientRect());
    onChange([...annotations, {
      pageIndex,
      ...point,
      category: "expression",
      anchorText: "",
      comment: "",
      isHighlight: false,
    }]);
  }

  function drag(event: ReactPointerEvent<HTMLButtonElement>, index: number) {
    if (event.type === "pointerdown") {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
    const canvas = event.currentTarget.closest(".annotation-canvas") as HTMLElement | null;
    if (canvas) replace(index, normalizedPoint(event, canvas.getBoundingClientRect()));
  }

  return (
    <div className="annotation-workspace">
      <div className="annotation-canvas" aria-label={`第 ${pageIndex + 1} 页作文批注画布`} onClick={add}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt={`第 ${pageIndex + 1} 页作文`} />
        <svg className="annotation-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {pageAnnotations.map(({ annotation, index }) => (
            <circle key={`${index}-${annotation.x}-${annotation.y}`} cx={annotation.x * 100} cy={annotation.y * 100} r="1.8" className={annotation.isHighlight ? "highlight-circle" : "comment-circle"} />
          ))}
        </svg>
        {pageAnnotations.map(({ annotation, index }, markerIndex) => (
          <button
            key={`${index}-marker`}
            type="button"
            className={`annotation-marker ${annotation.isHighlight ? "annotation-marker--highlight" : ""}`}
            style={{ left: `${annotation.x * 100}%`, top: `${annotation.y * 100}%` }}
            aria-label={`拖动批注 ${markerIndex + 1}`}
            onPointerDown={(event) => drag(event, index)}
            onPointerMove={(event) => drag(event, index)}
          >{markerIndex + 1}</button>
        ))}
        <span className="canvas-hint">点击作文空白处添加批注</span>
      </div>

      <div className="annotation-list" aria-label={`第 ${pageIndex + 1} 页批注`}>
        {pageAnnotations.length === 0 ? <p className="annotation-empty">这一页还没有批注。点击左侧作文开始朱批。</p> : null}
        {pageAnnotations.map(({ annotation, index }, cardIndex) => (
          <article className={`annotation-card ${annotation.isHighlight ? "annotation-card--highlight" : ""}`} key={`${index}-card`}>
            <div className="annotation-card-heading"><span className="annotation-number">{cardIndex + 1}</span><b>{annotation.isHighlight ? "亮点摘录" : "红批"}</b><small>纵向 {Math.round(annotation.y * 100)}%</small></div>
            <div className="annotation-fields">
              <label>类别<select aria-label={`批注类别 ${cardIndex + 1}`} value={annotation.category} onChange={(event) => replace(index, { category: event.target.value as Annotation["category"] })}>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label>原文锚点<input aria-label={`原文锚点 ${cardIndex + 1}`} value={annotation.anchorText} onChange={(event) => replace(index, { anchorText: event.target.value })} /></label>
              <label className="wide">批注内容<textarea aria-label={`批注内容 ${cardIndex + 1}`} value={annotation.comment} onChange={(event) => replace(index, { comment: event.target.value })} /></label>
            </div>
            <div className="annotation-card-actions">
              <label className="highlight-toggle"><input aria-label={`标记为亮点 ${cardIndex + 1}`} type="checkbox" checked={annotation.isHighlight} onChange={(event) => replace(index, { isHighlight: event.target.checked, category: event.target.checked ? "highlight" : annotation.category === "highlight" ? "expression" : annotation.category })} />设为亮点</label>
              <button type="button" className="text-button danger-text" aria-label={`删除批注 ${cardIndex + 1}`} onClick={() => onChange(annotations.filter((_, current) => current !== index))}>删除</button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
