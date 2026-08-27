"use client";

import { useRef } from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent } from "react";

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
  disabled?: boolean;
  onChange: (annotations: Annotation[]) => void;
}

export function PhotoAnnotationEditor({ imageUrl, pageIndex, annotations, disabled = false, onChange }: PhotoAnnotationEditorProps) {
  const draggingPointerId = useRef<number | null>(null);
  const pageAnnotations = annotations
    .map((annotation, index) => ({ annotation, index }))
    .filter(({ annotation }) => annotation.pageIndex === pageIndex)
    .sort((left, right) => left.annotation.y - right.annotation.y);

  function replace(index: number, change: Partial<Annotation>) {
    if (disabled) return;
    onChange(annotations.map((annotation, current) => current === index ? { ...annotation, ...change } : annotation));
  }

  function addAt(point: { x: number; y: number }) {
    onChange([...annotations, {
      pageIndex,
      ...point,
      category: "expression",
      anchorText: "",
      comment: "",
      isHighlight: false,
    }]);
  }

  function add(event: MouseEvent<HTMLDivElement>) {
    if (disabled) return;
    if ((event.target as Element).closest("button")) return;
    addAt(normalizedPoint(event, event.currentTarget.getBoundingClientRect()));
  }

  function addByKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }
    event.preventDefault();
    addAt({ x: 0.5, y: 0.5 });
  }

  function startDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (disabled) return;
    draggingPointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function drag(event: ReactPointerEvent<HTMLButtonElement>, index: number) {
    if (disabled) return;
    if (draggingPointerId.current !== event.pointerId) return;
    const canvas = event.currentTarget.closest(".annotation-canvas") as HTMLElement | null;
    if (canvas) replace(index, normalizedPoint(event, canvas.getBoundingClientRect()));
  }

  function stopDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (draggingPointerId.current === event.pointerId) draggingPointerId.current = null;
  }

  function nudge(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (disabled) return;
    const shifts: Record<string, Partial<Pick<Annotation, "x" | "y">>> = {
      ArrowLeft: { x: -0.01 },
      ArrowRight: { x: 0.01 },
      ArrowUp: { y: -0.01 },
      ArrowDown: { y: 0.01 },
    };
    const shift = shifts[event.key];
    if (!shift) return;
    event.preventDefault();
    const annotation = annotations[index];
    replace(index, {
      x: Math.max(0, Math.min(1, annotation.x + (shift.x ?? 0))),
      y: Math.max(0, Math.min(1, annotation.y + (shift.y ?? 0))),
    });
  }

  return (
    <div className="annotation-workspace">
      <div className="annotation-canvas" aria-label={`第 ${pageIndex + 1} 页作文批注画布`} aria-disabled={disabled} tabIndex={disabled ? -1 : 0} onClick={add} onKeyDown={addByKeyboard}>
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
            disabled={disabled}
            onPointerDown={startDrag}
            onPointerMove={(event) => drag(event, index)}
            onPointerUp={stopDrag}
            onPointerCancel={stopDrag}
            onKeyDown={(event) => nudge(event, index)}
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
              <label>类别<select aria-label={`批注类别 ${cardIndex + 1}`} disabled={disabled} value={annotation.category} onChange={(event) => replace(index, { category: event.target.value as Annotation["category"] })}>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label>原文锚点<input aria-label={`原文锚点 ${cardIndex + 1}`} disabled={disabled} value={annotation.anchorText} onChange={(event) => replace(index, { anchorText: event.target.value })} /></label>
              <label className="wide">批注内容<textarea aria-label={`批注内容 ${cardIndex + 1}`} disabled={disabled} value={annotation.comment} onChange={(event) => replace(index, { comment: event.target.value })} /></label>
            </div>
            <div className="annotation-card-actions">
              <label className="highlight-toggle"><input aria-label={`标记为亮点 ${cardIndex + 1}`} disabled={disabled} type="checkbox" checked={annotation.isHighlight} onChange={(event) => replace(index, { isHighlight: event.target.checked, category: event.target.checked ? "highlight" : annotation.category === "highlight" ? "expression" : annotation.category })} />设为亮点</label>
              <button type="button" className="text-button danger-text" disabled={disabled} aria-label={`删除批注 ${cardIndex + 1}`} onClick={() => onChange(annotations.filter((_, current) => current !== index))}>删除</button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
