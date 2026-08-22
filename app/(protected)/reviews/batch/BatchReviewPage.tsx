"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AppHeader } from "../../../components/AppHeader";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { RevisionRequestDialog } from "../../../components/RevisionRequestDialog";
import { ReportEditor } from "../../../components/ReportEditor";
import { ReviewExportList } from "../../../components/ReviewExportList";
import { apiFetch, errorMessage } from "../../../lib/api";
import { downloadReviewPdfArchive } from "../../../lib/pdf-download";
import { filterReviewsByStudentName, reviewPrefetchWindow } from "../../../lib/review-queue";
import type { PublicAnalysisJobView, RevisionRequestResult, ReviewView } from "../../../lib/types";

export interface ReviewQueueItemView {
  id: string;
  studentName: string;
  title: string;
  status: ReviewView["status"];
  revision: number;
  createdAt: string;
}

function cacheKey(id: string, revision: number) {
  return `${id}:${revision}`;
}

interface RevisionJobTracker {
  reviewId: string;
  jobId: string;
}

export function BatchReviewPage() {
  const [queue, setQueue] = useState<ReviewQueueItemView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewView | null>(null);
  const [reviewed, setReviewed] = useState<ReviewView[]>([]);
  const [selectedExportIds, setSelectedExportIds] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"review" | "export">("review");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [revisionDialogOpen, setRevisionDialogOpen] = useState(false);
  const [revisionSubmitting, setRevisionSubmitting] = useState(false);
  const [revisionError, setRevisionError] = useState("");
  const [revisionNotice, setRevisionNotice] = useState("");
  const [revisionJobs, setRevisionJobs] = useState<RevisionJobTracker[]>([]);
  const cacheRef = useRef(new Map<string, ReviewView>());
  const requestsRef = useRef(new Map<string, { controller: AbortController; promise: Promise<ReviewView> }>());
  const revisionButtonRef = useRef<HTMLButtonElement>(null);

  const visibleQueue = useMemo(() => filterReviewsByStudentName(queue, search), [queue, search]);

  const loadDetail = useCallback((item: ReviewQueueItemView): Promise<ReviewView> => {
    const key = cacheKey(item.id, item.revision);
    const cached = cacheRef.current.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = requestsRef.current.get(key);
    if (pending) return pending.promise;
    const controller = new AbortController();
    const promise = apiFetch<ReviewView>(`/api/reviews/${encodeURIComponent(item.id)}`, { signal: controller.signal })
      .then((loaded) => {
        cacheRef.current.set(key, loaded);
        const firstImage = loaded.images[0];
        if (firstImage && typeof Image !== "undefined") {
          const image = new Image();
          image.src = `/api/reviews/${encodeURIComponent(loaded.id)}/files?imageId=${firstImage.id}&variant=annotation`;
        }
        return loaded;
      })
      .finally(() => requestsRef.current.delete(key));
    requestsRef.current.set(key, { controller, promise });
    return promise;
  }, []);

  useEffect(() => {
    let active = true;
    const requests = requestsRef.current;
    void apiFetch<ReviewQueueItemView[]>("/api/reviews/review-queue")
      .then((loaded) => {
        if (!active) return;
        setQueue(loaded);
        setActiveId(loaded[0]?.id ?? null);
      })
      .catch((caught) => { if (active) setError(errorMessage(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      requests.forEach(({ controller }) => controller.abort());
    };
  }, []);

  useEffect(() => {
    if (!activeId) return;
    const ids = visibleQueue.map(({ id }) => id);
    const windowIds = reviewPrefetchWindow(ids, activeId);
    const items = windowIds.map((id) => visibleQueue.find((item) => item.id === id)!).filter(Boolean);
    let active = true;
    const current = items[0];
    if (current) {
      const cached = cacheRef.current.get(cacheKey(current.id, current.revision));
      if (cached) { setReview(cached); setDirty(false); }
      void loadDetail(current).then((loaded) => {
        if (active && loaded.id === activeId) { setReview(loaded); setDirty(false); }
      }).catch((caught) => { if (active && !(caught instanceof DOMException && caught.name === "AbortError")) setError(errorMessage(caught)); });
    }
    items.slice(1).forEach((item) => { void loadDetail(item).catch(() => undefined); });
    return () => { active = false; };
  }, [activeId, loadDetail, visibleQueue]);

  useEffect(() => {
    if (revisionJobs.length === 0) return;
    let active = true;

    async function pollRevisionJobs() {
      const succeededReviewIds: string[] = [];
      const failedReviewIds: string[] = [];
      await Promise.all(revisionJobs.map(async (task) => {
        try {
          const result = await apiFetch<{ job: PublicAnalysisJobView | null }>(
            `/api/reviews/${encodeURIComponent(task.reviewId)}/analyze/status`,
          );
          if (!active || !result.job || result.job.id !== task.jobId) return;
          if (result.job.status === "succeeded") succeededReviewIds.push(task.reviewId);
          else if (result.job.status === "failed" || result.job.status === "canceled") failedReviewIds.push(task.reviewId);
        } catch {
          if (active) setRevisionNotice("任务状态暂时无法刷新，正在尝试重新连接。");
        }
      }));
      if (!active) return;
      const terminalIds = new Set([...succeededReviewIds, ...failedReviewIds]);
      if (terminalIds.size > 0) {
        setRevisionJobs((current) => current.filter(({ reviewId }) => !terminalIds.has(reviewId)));
      }
      if (failedReviewIds.length > 0) {
        setRevisionNotice("退回后的重新分析失败，作文未加入待审核队列。");
      }
      if (succeededReviewIds.length === 0) return;
      try {
        const loaded = await apiFetch<ReviewQueueItemView[]>("/api/reviews/review-queue");
        if (!active) return;
        setQueue(loaded);
        setActiveId((current) => current ?? loaded[0]?.id ?? null);
      } catch {
        if (active) setRevisionNotice("待审核队列暂时无法刷新，请稍后重试。");
      }
    }

    const timer = window.setInterval(() => { void pollRevisionJobs(); }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [revisionJobs]);

  function choose(id: string) {
    if (id === activeId) return;
    if (dirty && !window.confirm("当前修改尚未审核保存，确认切换作文？")) return;
    setActiveId(id);
  }

  function updateSearch(value: string) {
    const nextVisible = filterReviewsByStudentName(queue, value);
    if (activeId && !nextVisible.some(({ id }) => id === activeId)) {
      if (dirty && !window.confirm("当前修改尚未审核保存，确认切换作文？")) return;
      const next = nextVisible[0] ?? null;
      setActiveId(next?.id ?? null);
      setReview(next ? cacheRef.current.get(cacheKey(next.id, next.revision)) ?? null : null);
      setDirty(false);
    }
    setSearch(value);
  }

  function advanceAfterQueueRemoval(reviewId: string) {
    const currentIndex = visibleQueue.findIndex(({ id }) => id === reviewId);
    const next = currentIndex >= 0
      ? visibleQueue[currentIndex + 1] ?? visibleQueue[currentIndex - 1] ?? null
      : null;
    setQueue((current) => current.filter(({ id }) => id !== reviewId));
    setActiveId(next?.id ?? null);
    setReview(next ? cacheRef.current.get(cacheKey(next.id, next.revision)) ?? null : null);
    setDirty(false);
  }

  async function completeReview() {
    if (!review?.report || saving) return;
    setSaving(true);
    setError("");
    try {
      const saved = await apiFetch<ReviewView>(`/api/reviews/${encodeURIComponent(review.id)}/teacher-review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: review.revision, studentName: review.studentName, report: review.report, annotations: review.annotations }),
      });
      cacheRef.current.set(cacheKey(saved.id, saved.revision), saved);
      setReviewed((current) => [...current.filter(({ id }) => id !== saved.id), saved]);
      setSelectedExportIds((current) => new Set(current).add(saved.id));
      advanceAfterQueueRemoval(saved.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  function closeRevisionDialog() {
    if (revisionSubmitting) return;
    revisionButtonRef.current?.focus();
    setRevisionDialogOpen(false);
    setRevisionError("");
  }

  function openRevisionDialog() {
    if (!review || revisionSubmitting || saving) return;
    if (dirty && !window.confirm("当前修改尚未审核保存，确认切换作文？")) return;
    setRevisionError("");
    setRevisionNotice("");
    setRevisionDialogOpen(true);
  }

  async function requestRevision(input: { reason: string; changeRequest: string }) {
    if (!review || revisionSubmitting) return;
    const currentReview = review;
    setRevisionSubmitting(true);
    setRevisionError("");
    setRevisionNotice("");
    try {
      const result = await apiFetch<RevisionRequestResult>(`/api/reviews/${encodeURIComponent(currentReview.id)}/revision-request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: currentReview.revision, reason: input.reason, changeRequest: input.changeRequest }),
      });
      for (const key of cacheRef.current.keys()) {
        if (key.startsWith(`${currentReview.id}:`)) cacheRef.current.delete(key);
      }
      if (result.job.status === "queued" || result.job.status === "running") {
        setRevisionJobs((current) => [...current.filter(({ reviewId }) => reviewId !== result.job.reviewId), { reviewId: result.job.reviewId, jobId: result.job.id }]);
      }
      setRevisionDialogOpen(false);
      advanceAfterQueueRemoval(currentReview.id);
    } catch (caught) {
      setRevisionError(errorMessage(caught));
    } finally {
      setRevisionSubmitting(false);
    }
  }

  async function exportSelected() {
    const ids = reviewed.filter(({ id }) => selectedExportIds.has(id)).map(({ id }) => id);
    if (ids.length === 0) return;
    setExporting(true);
    setError("");
    try { await downloadReviewPdfArchive(ids); } catch (caught) { setError(errorMessage(caught)); } finally { setExporting(false); }
  }

  return <div className="app-shell batch-review-shell">
    <AppHeader />
    <main className="batch-review-page">
      <header className="batch-review-topbar">
        <div><p className="eyebrow">教师审核</p><h1>批量作文审核</h1></div>
        <div className="segmented-control" aria-label="批量审核视图">
          <button type="button" aria-pressed={view === "review"} onClick={() => setView("review")}>连续审核</button>
          <button type="button" aria-pressed={view === "export"} onClick={() => setView("export")}>待导出清单 ({reviewed.length})</button>
        </div>
        <Link className="button button--quiet" href="/">返回历史</Link>
      </header>
      {error ? <ErrorBanner message={error} /> : null}
      {revisionNotice ? <div className="revision-job-notice" role="status">{revisionNotice}</div> : null}
      {view === "export" ? <section className="batch-export-view">
        <div className="batch-export-actions"><span>已选择 {selectedExportIds.size} 篇</span><button type="button" className="button button--primary" disabled={selectedExportIds.size === 0 || exporting} onClick={() => void exportSelected()}>{exporting ? "正在导出…" : "导出所选作文"}</button></div>
        <ReviewExportList reviews={reviewed} selectedIds={selectedExportIds} onToggle={(id) => setSelectedExportIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} onReturnToReview={(id) => { const target = reviewed.find((item) => item.id === id); if (target) { setReview(target); setActiveId(id); setView("review"); } }} />
      </section> : <div className="batch-review-layout">
        <aside className="batch-queue" aria-label="待审核作文队列">
          <label>搜索学生姓名<input type="search" aria-label="搜索待审核学生姓名" value={search} onChange={(event) => updateSearch(event.target.value)} /></label>
          <p className="muted">待审核 {queue.length} 篇</p>
          <div className="batch-queue-list">{visibleQueue.map((item, index) => <button type="button" className={item.id === activeId ? "is-active" : ""} key={item.id} onClick={() => choose(item.id)}><span>{index + 1}</span><b>{item.studentName || "未填写学生"}</b><small>{item.title}</small></button>)}</div>
        </aside>
        <section className="batch-essay-pane">
          {loading || (activeId && !review) ? <p className="loading-note" role="status">正在展开作文与批改报告…</p> : !activeId ? <div className="batch-empty"><h2>待审核队列已完成</h2><p>可以前往待导出清单核对并导出作文。</p></div> : review ? <>
            <div className="batch-pane-heading"><div><p className="eyebrow">当前学生</p><h2>{review.studentName || "未填写学生"}</h2></div><span>{review.config.title}</span></div>
            <div className="batch-essay-content">{review.images.map((image, index) => <figure key={image.id}><img src={`/api/reviews/${encodeURIComponent(review.id)}/files?imageId=${image.id}&variant=annotation`} alt={`作文第 ${index + 1} 页`} /><figcaption>第 {index + 1} 页</figcaption></figure>)}</div>
            {review.ocr ? <details className="batch-ocr"><summary>查看识别原文</summary>{review.ocr.pages.map((page) => <p key={page.pageIndex}>{page.text}</p>)}</details> : null}
          </> : null}
        </section>
        <section className="batch-report-pane">
          {review?.report ? <><label className="batch-student-name">学生姓名<input value={review.studentName} onChange={(event) => { setReview({ ...review, studentName: event.target.value }); setDirty(true); }} /></label><ReportEditor report={review.report} onChange={(report) => { setReview({ ...review, report }); setDirty(true); }} /></> : <p className="muted">选择一篇作文开始审核</p>}
        </section>
        <footer className="batch-review-footer"><span>{dirty ? "有未确认的修改" : review ? "修改将在审核确认时保存" : ""}</span><div className="batch-review-footer-actions"><button ref={revisionButtonRef} type="button" className="button button--danger-quiet" disabled={!review || saving || revisionSubmitting} onClick={openRevisionDialog}>不合适</button><button type="button" className="button button--primary" disabled={!review?.report || saving || revisionSubmitting} onClick={() => void completeReview()}>{saving ? "正在保存并切换…" : "审核通过并进入下一篇"}</button></div></footer>
      </div>}
    </main>
    {revisionDialogOpen ? <RevisionRequestDialog open submitting={revisionSubmitting} error={revisionError} onClose={closeRevisionDialog} onSubmit={(input) => { void requestRevision(input); }} /> : null}
  </div>;
}
