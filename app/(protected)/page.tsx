"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AppHeader } from "../components/AppHeader";
import { BatchReanalysisDialog } from "../components/BatchReanalysisDialog";
import { ErrorBanner } from "../components/ErrorBanner";
import { StatusBadge } from "../components/StatusBadge";
import { apiFetch, errorMessage } from "../lib/api";
import { downloadReviewPdf, downloadReviewPdfArchive } from "../lib/pdf-download";
import { filterReviewsByStudentName, isReviewedPendingExport, reviewDisplayStatus } from "../lib/review-queue";
import type { BatchReanalysisCommitItem, BatchReanalysisCommitResult, BatchReanalysisPreview, ReviewView } from "../lib/types";
import { gradeFromLegacyTotal } from "@/src/domain/contracts";
import { BATCH_REANALYSIS_LIMIT } from "@/src/reanalysis/contracts";

function reviewDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "日期未知"
    : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(date);
}

export default function Home() {
  const [reviews, setReviews] = useState<ReviewView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [selectedReviewIds, setSelectedReviewIds] = useState<Set<string>>(() => new Set());
  const [batchExporting, setBatchExporting] = useState(false);
  const [studentSearch, setStudentSearch] = useState("");
  const [reanalysisOpen, setReanalysisOpen] = useState(false);
  const [reanalysisLoading, setReanalysisLoading] = useState(false);
  const [reanalysisSubmitting, setReanalysisSubmitting] = useState(false);
  const [reanalysisPreview, setReanalysisPreview] = useState<BatchReanalysisPreview | null>(null);
  const [reanalysisResult, setReanalysisResult] = useState<BatchReanalysisCommitResult | null>(null);
  const [reanalysisError, setReanalysisError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setReviews(await apiFetch<ReviewView[]>("/api/reviews"));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void apiFetch<ReviewView[]>("/api/reviews")
      .then((loaded) => { if (active) setReviews(loaded); })
      .catch((caught) => { if (active) setError(errorMessage(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const reviewedPendingExport = useMemo(
    () => reviews.filter(isReviewedPendingExport),
    [reviews],
  );
  const stats = useMemo(() => ({
    draft: reviews.filter(({ status }) => status === "draft").length,
    review: reviews.filter(({ status, teacherReviewedAt }) =>
      !teacherReviewedAt && ["analyzing", "needs_better_images", "ready_for_review", "failed"].includes(status),
    ).length,
    reviewed: reviewedPendingExport.length,
    exported: reviews.filter(({ status }) => status === "exported").length,
  }), [reviews, reviewedPendingExport.length]);
  const visibleReviews = useMemo(
    () => filterReviewsByStudentName(reviews, studentSearch),
    [reviews, studentSearch],
  );
  const selectedVisibleCount = visibleReviews.filter(({ id }) => selectedReviewIds.has(id)).length;
  const hiddenSelectedCount = selectedReviewIds.size - selectedVisibleCount;
  const allVisibleSelected = visibleReviews.length > 0 && selectedVisibleCount === visibleReviews.length;
  const reanalysisBusy = reanalysisLoading || reanalysisSubmitting;

  async function remove(review: ReviewView) {
    if (!window.confirm(`确认永久删除《${review.config.title}》？删除后不可恢复。`)) return;
    setDeleting(review.id);
    setError("");
    try {
      await apiFetch(`/api/reviews/${encodeURIComponent(review.id)}`, { method: "DELETE" });
      setReviews((current) => current.filter(({ id }) => id !== review.id));
      setSelectedReviewIds((current) => {
        const next = new Set(current);
        next.delete(review.id);
        return next;
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setDeleting(null);
    }
  }

  async function exportPdf(review: ReviewView) {
    if (exporting || batchExporting) return;
    setExporting(review.id);
    setError("");
    try {
      await downloadReviewPdf(review.id);
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setExporting(null);
    }
  }

  function toggleReviewSelection(reviewId: string) {
    setSelectedReviewIds((current) => {
      const next = new Set(current);
      if (next.has(reviewId)) next.delete(reviewId);
      else next.add(reviewId);
      return next;
    });
  }

  function toggleAllReviews() {
    setSelectedReviewIds((current) => {
      const next = new Set(current);
      if (visibleReviews.every(({ id }) => next.has(id))) {
        visibleReviews.forEach(({ id }) => next.delete(id));
      } else {
        visibleReviews.forEach(({ id }) => next.add(id));
      }
      return next;
    });
  }

  async function exportSelectedPdfs() {
    if (selectedReviewIds.size === 0 || batchExporting || exporting) return;
    setBatchExporting(true);
    setError("");
    try {
      await downloadReviewPdfArchive(reviews
        .filter(({ id }) => selectedReviewIds.has(id))
        .map(({ id }) => id));
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBatchExporting(false);
    }
  }

  async function exportReviewedPdfs() {
    if (reviewedPendingExport.length === 0 || batchExporting || exporting || reanalysisBusy) return;
    setBatchExporting(true);
    setError("");
    try {
      await downloadReviewPdfArchive(reviewedPendingExport.map(({ id }) => id));
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBatchExporting(false);
    }
  }

  async function openBatchReanalysis() {
    if (selectedReviewIds.size === 0 || selectedReviewIds.size > BATCH_REANALYSIS_LIMIT || reanalysisBusy || batchExporting || exporting) return;
    setReanalysisOpen(true);
    setReanalysisLoading(true);
    setReanalysisPreview(null);
    setReanalysisResult(null);
    setReanalysisError("");
    try {
      const preview = await apiFetch<BatchReanalysisPreview>("/api/reviews/batch-reanalysis/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewIds: [...selectedReviewIds] }),
      });
      setReanalysisPreview(preview);
    } catch (caught) {
      setReanalysisError(errorMessage(caught));
    } finally {
      setReanalysisLoading(false);
    }
  }

  async function submitBatchReanalysis(items: BatchReanalysisCommitItem[]) {
    if (reanalysisSubmitting || items.length === 0) return;
    setReanalysisSubmitting(true);
    setReanalysisError("");
    try {
      const result = await apiFetch<BatchReanalysisCommitResult>("/api/reviews/batch-reanalysis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
      });
      setReanalysisResult(result);
      setSelectedReviewIds((current) => {
        const next = new Set(current);
        result.submitted.forEach(({ reviewId }) => next.delete(reviewId));
        return next;
      });
      await load();
    } catch (caught) {
      setReanalysisError(errorMessage(caught));
    } finally {
      setReanalysisSubmitting(false);
    }
  }

  function closeBatchReanalysis() {
    if (reanalysisBusy) return;
    setReanalysisOpen(false);
    setReanalysisLoading(false);
    setReanalysisPreview(null);
    setReanalysisResult(null);
    setReanalysisError("");
  }

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="page-container">
        <section className="hero" aria-labelledby="history-title">
          <div>
            <p className="eyebrow">教师工作台</p>
            <h1 id="history-title">新建作文批改</h1>
            <p className="hero-copy">上传学生作文，AI 先做细读，你来完成最后一道朱批。</p>
          </div>
          <Link href="/new" className="hero-cta">开始批改 <span aria-hidden="true">→</span></Link>
        </section>

        <dl className="stats-grid" aria-label="批改统计">
          <div><dt>草稿</dt><dd>{stats.draft}</dd></div>
          <div><dt>待复核</dt><dd>{stats.review}</dd></div>
          <div><dt>已复核</dt><dd>{stats.reviewed}</dd></div>
          <div><dt>已导出</dt><dd>{stats.exported}</dd></div>
        </dl>

        <section className="history-section" aria-labelledby="recent-title">
          <div className="section-heading">
            <div><p className="eyebrow">最近工作</p><h2 id="recent-title">批改历史</h2></div>
            <span className="muted">共 {reviews.length} 篇</span>
          </div>
          <div className="history-tools">
            <label className="history-search">搜索学生姓名<input type="search" aria-label="搜索学生姓名" value={studentSearch} onChange={(event) => setStudentSearch(event.target.value)} /></label>
            <Link className="button button--primary" href="/reviews/batch">开始批量审核</Link>
          </div>
          {reviews.length ? (
            <div className="history-batch-actions">
              <label><input type="checkbox" checked={allVisibleSelected} disabled={visibleReviews.length === 0 || reanalysisBusy} onChange={toggleAllReviews} /> 全选当前结果</label>
              <span className="muted">已选择 {selectedReviewIds.size} 篇</span>
              {hiddenSelectedCount > 0 ? <span className="muted">其中 {hiddenSelectedCount} 篇未显示</span> : null}
              <button className="button button--primary" type="button" disabled={reviewedPendingExport.length === 0 || batchExporting || exporting !== null || reanalysisBusy} onClick={() => void exportReviewedPdfs()}>
                {batchExporting ? "正在打包导出…" : `一键导出已复核（${reviewedPendingExport.length}）`}
              </button>
              <button className="button button--quiet" type="button" disabled={selectedReviewIds.size === 0 || batchExporting || exporting !== null || reanalysisBusy} onClick={() => void exportSelectedPdfs()}>
                {batchExporting
                  ? "正在打包导出…"
                  : selectedReviewIds.size > 1
                    ? `导出所选 ${selectedReviewIds.size} 篇（ZIP）`
                    : "导出所选 PDF"}
              </button>
              <button className="button button--primary" type="button" disabled={selectedReviewIds.size === 0 || selectedReviewIds.size > BATCH_REANALYSIS_LIMIT || batchExporting || exporting !== null || reanalysisBusy} onClick={() => void openBatchReanalysis()}>
                {reanalysisLoading ? "正在预览…" : "按最新框架重新分析"}
              </button>
              {selectedReviewIds.size > BATCH_REANALYSIS_LIMIT ? <span className="history-limit-note" role="status">每次最多重新分析 {BATCH_REANALYSIS_LIMIT} 篇</span> : null}
            </div>
          ) : null}
          {error ? <ErrorBanner message={error} onRetry={load} /> : null}
          {loading ? <p className="loading-note" role="status">正在翻阅批改记录…</p> : null}
          {!loading && !error && reviews.length === 0 ? (
            <div className="empty-state">
              <span className="empty-seal" aria-hidden="true">空</span>
              <h3>还没有作文批改记录</h3>
              <p>从一篇作文开始，批注与报告会整齐保存在这里。</p>
              <Link className="button button--primary" href="/new">新建作文批改</Link>
            </div>
          ) : null}
          <div className="history-list">
            {!loading && reviews.length > 0 && visibleReviews.length === 0 ? <p className="muted">没有找到该学生的作文</p> : null}
            {visibleReviews.map((review) => (
              <article className="history-card" key={review.id}>
                <label className="history-select"><input type="checkbox" aria-label={`选择《${review.config.title}》`} checked={selectedReviewIds.has(review.id)} disabled={batchExporting || reanalysisBusy} onChange={() => toggleReviewSelection(review.id)} /></label>
                <div className="history-main">
                  <div className="history-meta">
                    <StatusBadge status={reviewDisplayStatus(review)} />
                    <span>学生：{review.studentName || "未填写"}</span>
                    <time>{reviewDate(review.updatedAt ?? review.createdAt)}</time>
                  </div>
                  <h3><Link href={`/reviews?id=${encodeURIComponent(review.id)}`}>{review.config.title}</Link></h3>
                  <p>{review.report ? (() => { const grade = review.report.grade ?? gradeFromLegacyTotal(review.report.scores?.total ?? 0); return `${grade}${grade === "C" ? " · 需要重写" : " · 已完成四维诊断"}`; })() : "尚未生成等级评定"}</p>
                  <p className="muted">长期保留，可手动永久删除</p>
                </div>
                <div className="card-actions">
                  <Link className="button button--quiet" href={`/reviews?id=${encodeURIComponent(review.id)}`}>进入复核</Link>
                  <button
                    className="button button--quiet"
                    type="button"
                    aria-busy={exporting === review.id}
                    disabled={exporting !== null || batchExporting}
                    onClick={() => void exportPdf(review)}
                  >
                    {exporting === review.id ? "正在生成 PDF…" : "下载 PDF"}
                  </button>
                  <button className="button button--danger-quiet" type="button" disabled={deleting === review.id || batchExporting || reanalysisBusy} onClick={() => void remove(review)} aria-label={`删除《${review.config.title}》`}>
                    {deleting === review.id ? "删除中…" : "删除"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>
      <BatchReanalysisDialog
        open={reanalysisOpen}
        preview={reanalysisPreview}
        loading={reanalysisLoading}
        submitting={reanalysisSubmitting}
        error={reanalysisError}
        result={reanalysisResult}
        onClose={closeBatchReanalysis}
        onConfirm={(items) => { void submitBatchReanalysis(items); }}
      />
    </div>
  );
}
