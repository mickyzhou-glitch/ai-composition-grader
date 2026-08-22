"use client";

import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";

import type {
  BatchReanalysisCommitItem,
  BatchReanalysisCommitResult,
  BatchReanalysisMatchedItem,
  BatchReanalysisPreview,
} from "../lib/types";

export interface BatchReanalysisDialogProps {
  open: boolean;
  preview: BatchReanalysisPreview | null;
  loading: boolean;
  submitting: boolean;
  error: string;
  result: BatchReanalysisCommitResult | null;
  onClose(): void;
  onConfirm(items: BatchReanalysisCommitItem[]): void;
}

function groupMatchedItems(items: BatchReanalysisMatchedItem[]) {
  const groups = new Map<string, { assignmentId: string; title: string; updatedAt: string; items: BatchReanalysisMatchedItem[] }>();
  items.forEach((item) => {
    const key = item.assignmentId;
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, {
      assignmentId: item.assignmentId,
      title: item.title,
      updatedAt: item.assignmentUpdatedAt,
      items: [item],
    });
  });
  return [...groups.values()];
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "更新时间未知"
    : `最后更新于 ${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date)}`;
}

export function BatchReanalysisDialog({
  open,
  preview,
  loading,
  submitting,
  error,
  result,
  onClose,
  onConfirm,
}: BatchReanalysisDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const groups = useMemo(() => groupMatchedItems(preview?.matched ?? []), [preview]);
  const hasResult = result !== null;
  const matchedCount = preview?.matched.length ?? 0;
  const skippedCount = preview?.skipped.length ?? 0;
  const submittedCount = result?.submitted.length ?? 0;
  const resultSkippedCount = result?.skipped.length ?? 0;

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !loading && !submitting) {
      event.preventDefault();
      onClose();
    }
  }

  const items = preview?.matched.map(({ reviewId, expectedRevision, assignmentId, assignmentUpdatedAt }) => ({
    reviewId,
    expectedRevision,
    assignmentId,
    expectedAssignmentUpdatedAt: assignmentUpdatedAt,
  })) ?? [];

  return (
    <div className="batch-reanalysis-backdrop" role="presentation">
      <div
        className="batch-reanalysis-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-reanalysis-title"
        onKeyDown={handleKeyDown}
      >
        <div className="batch-reanalysis-heading">
          <div>
            <p className="eyebrow">批量操作</p>
            <h2 id="batch-reanalysis-title">按最新框架重新分析</h2>
          </div>
          <button ref={closeRef} type="button" className="button button--quiet" disabled={loading || submitting} onClick={onClose}>关闭</button>
        </div>

        {loading ? <div className="batch-reanalysis-loading" role="status">正在检查所选作文与最新框架…</div> : null}
        {error ? <p className="batch-reanalysis-error" role="alert">{error}</p> : null}

        {!loading && !hasResult && preview ? <div className="batch-reanalysis-body">
          <p className="batch-reanalysis-summary">
            共选择 {matchedCount + skippedCount} 篇，可重新分析 <strong>{matchedCount}</strong> 篇，跳过 <strong>{skippedCount}</strong> 篇。
          </p>
          {groups.length > 0 ? <div className="batch-reanalysis-groups">
            {groups.map((group) => <section className="batch-reanalysis-group" key={group.assignmentId}>
              <div className="batch-reanalysis-group-heading">
                <div><h3>{group.title}</h3><span>{formatUpdatedAt(group.updatedAt)}</span></div>
                <strong>{group.items.length} 篇</strong>
              </div>
              <ul>
                {group.items.map((item) => <li key={item.reviewId}><span>{item.studentName || "未填写学生"}</span><span>revision {item.expectedRevision}</span></li>)}
              </ul>
            </section>)}
          </div> : null}
          {skippedCount > 0 ? <section className="batch-reanalysis-skipped" aria-labelledby="batch-reanalysis-skipped-title">
            <h3 id="batch-reanalysis-skipped-title">将跳过的作文</h3>
            <ul>{preview.skipped.map((item) => <li key={item.reviewId}><span>{item.studentName || "作文"}{item.title ? ` · ${item.title}` : ""}</span><span>{item.reason}</span></li>)}</ul>
          </section> : null}
        </div> : null}

        {hasResult && result ? <div className="batch-reanalysis-body" role="status">
          <p className="batch-reanalysis-summary">已提交 <strong>{submittedCount}</strong> 篇重新分析任务{resultSkippedCount > 0 ? `，${resultSkippedCount} 篇保留选择` : "。"}</p>
          {resultSkippedCount > 0 ? <section className="batch-reanalysis-skipped" aria-labelledby="batch-reanalysis-result-skipped-title">
            <h3 id="batch-reanalysis-result-skipped-title">未提交的作文</h3>
            <ul>{result.skipped.map((item) => <li key={item.reviewId}><span>{item.studentName || "作文"}{item.title ? ` · ${item.title}` : ""}</span><span>{item.reason}</span></li>)}</ul>
          </section> : null}
        </div> : null}

        <div className="batch-reanalysis-actions">
          {hasResult ? <button type="button" className="button button--primary" onClick={onClose}>完成</button> : <>
            <button type="button" className="button button--quiet" disabled={loading || submitting} onClick={onClose}>取消</button>
            <button type="button" className="button button--primary" disabled={loading || submitting || items.length === 0} onClick={() => onConfirm(items)} aria-busy={submitting}>
              {submitting ? "正在提交…" : `确认重新分析 ${items.length} 篇`}
            </button>
          </>}
        </div>
      </div>
    </div>
  );
}
