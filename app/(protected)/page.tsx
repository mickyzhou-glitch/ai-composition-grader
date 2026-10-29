"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ClassFilter } from "../components/ClassFilter";
import { filterReviewsByClass } from "../lib/classification";
import { AppHeader } from "../components/AppHeader";
import { BatchReanalysisDialog } from "../components/BatchReanalysisDialog";
import { ErrorBanner } from "../components/ErrorBanner";
import { ExportMenu } from "../components/ExportMenu";
import { StatusBadge } from "../components/StatusBadge";
import { apiFetch, errorMessage } from "../lib/api";
import { downloadLegacyCachedPdf, downloadReview, downloadReviewArchive, type ExportFormat } from "../lib/review-export";
import { chunkItems } from "../lib/failed-regrade";
import { exportEligibility, filterReviewsByStudentName, isReviewedPendingExport, isReviewFailed, matchesHistoryStatus, reviewDisplayStatus, type HistoryStatusFilter } from "../lib/review-queue";
import type { BatchReanalysisCommitItem, BatchReanalysisCommitResult, BatchReanalysisPreview, PublicAnalysisJobView, ReviewView } from "../lib/types";
import { gradeFromLegacyTotal, isLegacyEvaluationReport } from "@/src/domain/contracts";
import { BATCH_REANALYSIS_LIMIT } from "@/src/reanalysis/contracts";

const REGRADE_POLL_INTERVAL_MS = 1_000;
const REGRADE_POLL_DEADLINE_MS = 12 * 60_000;

async function pollRegradeJob(
  reviewId: string,
  jobId: string,
): Promise<{ status: string; message: string | null }> {
  const deadline = Date.now() + REGRADE_POLL_DEADLINE_MS;
  while (Date.now() <= deadline) {
    const payload = await apiFetch<{ job: PublicAnalysisJobView | null }>(
      `/api/reviews/${encodeURIComponent(reviewId)}/analyze/status`,
    );
    const job = payload.job;
    if (
      job?.id === jobId
      && (job.status === "failed" || job.status === "succeeded" || job.status === "canceled")
    ) {
      return { status: job.status, message: job.message };
    }
    if (Date.now() + REGRADE_POLL_INTERVAL_MS > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, REGRADE_POLL_INTERVAL_MS));
  }
  return { status: "running", message: "等待这次分析结果超时" };
}

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
  const [statusFilter, setStatusFilter] = useState<HistoryStatusFilter>("");
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [reanalysisOpen, setReanalysisOpen] = useState(false);
  const [reanalysisLoading, setReanalysisLoading] = useState(false);
  const [reanalysisSubmitting, setReanalysisSubmitting] = useState(false);
  const [reanalysisPreview, setReanalysisPreview] = useState<BatchReanalysisPreview | null>(null);
  const [reanalysisResult, setReanalysisResult] = useState<BatchReanalysisCommitResult | null>(null);
  const [reanalysisError, setReanalysisError] = useState("");
  const [failedRegrade, setFailedRegrade] = useState<{
    running: boolean;
    completed: number;
    total: number;
    submitted: number;
    skipped: BatchReanalysisPreview["skipped"];
    failures: Array<{ reviewId: string; studentName: string; summary: string }>;
    error: string;
  } | null>(null);

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

  const reviewedPending = useMemo(
    () => reviews.filter(isReviewedPendingExport),
    [reviews],
  );
  const reviewedPendingExport = useMemo(
    () => filterReviewsByClass(reviewedPending, classFilter).filter((item) => exportEligibility(item).eligible),
    [reviewedPending, classFilter],
  );
  const stats = useMemo(() => ({
    draft: reviews.filter(({ status }) => status === "draft").length,
    review: reviews.filter((review) => matchesHistoryStatus(review, "review")).length,
    failed: reviews.filter(isReviewFailed).length,
    reviewed: reviewedPending.length,
    exported: reviews.filter(({ status }) => status === "exported").length,
    rejected: reviews.filter(({ status }) => status === "rejected").length,
  }), [reviews, reviewedPending.length]);
  const visibleReviews = useMemo(
    () => filterReviewsByStudentName(filterReviewsByClass(reviews, classFilter), studentSearch)
      .filter((review) => matchesHistoryStatus(review, statusFilter)),
    [reviews, studentSearch, classFilter, statusFilter],
  );
  const failedInView = useMemo(
    () => visibleReviews.filter((review) => review.status === "failed"),
    [visibleReviews],
  );
  const selectedVisibleCount = visibleReviews.filter(({ id }) => selectedReviewIds.has(id)).length;
  const hiddenSelectedCount = selectedReviewIds.size - selectedVisibleCount;
  const allVisibleSelected = visibleReviews.length > 0 && selectedVisibleCount === visibleReviews.length;
  const selectedExportableReviews = reviews.filter(({ id }) => selectedReviewIds.has(id)).filter(
    (item) => exportEligibility(item).eligible,
  );
  const reanalysisBusy = reanalysisLoading || reanalysisSubmitting || failedRegrade?.running === true;

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

  async function exportReview(review: ReviewView, format: ExportFormat) {
    if (exporting || batchExporting) return;
    setExporting(review.id);
    setError("");
    try {
      await downloadReview(review.id, format);
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setExporting(null);
    }
  }

  async function downloadLegacyPdf(review: ReviewView) {
    if (exporting || batchExporting) return;
    setExporting(review.id);
    setError("");
    try {
      await downloadLegacyCachedPdf(review);
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

  async function exportSelected(format: ExportFormat) {
    if (selectedExportableReviews.length === 0 || batchExporting || exporting) return;
    setBatchExporting(true);
    setError("");
    try {
      await downloadReviewArchive(selectedExportableReviews.map(({ id }) => id), format);
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBatchExporting(false);
    }
  }

  async function exportReviewed(format: ExportFormat) {
    if (reviewedPendingExport.length === 0 || batchExporting || exporting || reanalysisBusy) return;
    setBatchExporting(true);
    setError("");
    try {
      await downloadReviewArchive(reviewedPendingExport.map(({ id }) => id), format);
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

  async function regradeFailed() {
    if (failedInView.length === 0 || reanalysisBusy || batchExporting || exporting) return;
    const ids = failedInView.map(({ id }) => id);
    const names = new Map(failedInView.map((item) => [item.id, item.studentName || "未填写"]));
    const chunks = chunkItems(ids);
    const skipped: BatchReanalysisPreview["skipped"] = [];
    const failures: Array<{ reviewId: string; studentName: string; summary: string }> = [];
    const submittedJobs: Array<{ reviewId: string; jobId: string }> = [];
    let submitted = 0;
    let completed = 0;
    setFailedRegrade({ running: true, completed: 0, total: ids.length, submitted: 0, skipped: [], failures: [], error: "" });
    setError("");
    try {
      for (const chunk of chunks) {
        const preview = await apiFetch<BatchReanalysisPreview>("/api/reviews/batch-reanalysis/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reviewIds: chunk }),
        });
        skipped.push(...preview.skipped);
        if (preview.matched.length > 0) {
          const result = await apiFetch<BatchReanalysisCommitResult>("/api/reviews/batch-reanalysis", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              items: preview.matched.map((item) => ({
                reviewId: item.reviewId,
                expectedRevision: item.expectedRevision,
                assignmentId: item.assignmentId,
                expectedAssignmentUpdatedAt: item.assignmentUpdatedAt,
              })),
            }),
          });
          submitted += result.submitted.length;
          skipped.push(...result.skipped);
          submittedJobs.push(...result.submitted.map(({ reviewId, jobId }) => ({ reviewId, jobId })));
          const submittedIds = new Set(result.submitted.map(({ reviewId }) => reviewId));
          setSelectedReviewIds((current) => {
            const next = new Set(current);
            submittedIds.forEach((reviewId) => next.delete(reviewId));
            return next;
          });
        }
        completed += chunk.length;
        setFailedRegrade({
          running: true,
          completed,
          total: ids.length,
          submitted,
          skipped: [...skipped],
          failures: [],
          error: "",
        });
      }
      const pollConcurrency = Math.min(4, Math.max(1, submittedJobs.length));
      const pollOutcomes = new Array<{ status: "succeeded" | "failed" | "running"; message?: string | null }>(submittedJobs.length);
      let nextPollIndex = 0;
      await Promise.all(
        Array.from({ length: pollConcurrency }, async () => {
          while (nextPollIndex < submittedJobs.length) {
            const index = nextPollIndex;
            nextPollIndex += 1;
            const item = submittedJobs[index]!;
            pollOutcomes[index] = await pollRegradeJob(item.reviewId, item.jobId);
          }
        }),
      );
      submittedJobs.forEach((item, index) => {
        const outcome = pollOutcomes[index];
        if (outcome && (outcome.status === "failed" || outcome.status === "running")) {
          failures.push({
            reviewId: item.reviewId,
            studentName: names.get(item.reviewId) ?? "未填写",
            summary: outcome.message ?? "分析失败，请重新分析",
          });
        }
      });
      await load();
      setFailedRegrade({
        running: false,
        completed: ids.length,
        total: ids.length,
        submitted,
        skipped,
        failures,
        error: "",
      });
    } catch (caught) {
      setFailedRegrade({
        running: false,
        completed,
        total: ids.length,
        submitted,
        skipped,
        failures,
        error: errorMessage(caught),
      });
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
          <div><dt>审核失败</dt><dd>{stats.failed}</dd></div>
          <div><dt>已复核</dt><dd>{stats.reviewed}</dd></div>
          <div><dt>已导出</dt><dd>{stats.exported}</dd></div>
          <div><dt>审核不通过</dt><dd>{stats.rejected}</dd></div>
        </dl>

        <section className="history-section" aria-labelledby="recent-title">
          <div className="section-heading">
            <div><p className="eyebrow">最近工作</p><h2 id="recent-title">批改历史</h2></div>
            <span className="muted">共 {reviews.length} 篇</span>
          </div>
          <div className="history-tools">
            <ClassFilter items={reviews} value={classFilter} onChange={setClassFilter} />
            <label className="history-search">搜索学生姓名<input type="search" aria-label="搜索学生姓名" value={studentSearch} onChange={(event) => setStudentSearch(event.target.value)} /></label>
            <label className="history-search">批改状态
              <select aria-label="筛选批改状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as HistoryStatusFilter)}>
                <option value="">全部</option>
                <option value="draft">草稿</option>
                <option value="review">待复核</option>
                <option value="failed">审核失败</option>
                <option value="reviewed">已复核</option>
                <option value="exported">已导出</option>
                <option value="rejected">审核不通过</option>
              </select>
            </label>
            <Link className="button button--primary" href="/reviews/batch">开始批量审核</Link>
          </div>
          {reviews.length ? (
            <div className="history-batch-actions">
              <label><input type="checkbox" checked={allVisibleSelected} disabled={visibleReviews.length === 0 || reanalysisBusy} onChange={toggleAllReviews} /> 全选当前结果</label>
              <span className="muted">已选择 {selectedReviewIds.size} 篇</span>
              {hiddenSelectedCount > 0 ? <span className="muted">其中 {hiddenSelectedCount} 篇未显示</span> : null}
              <div className="history-export-command"><span>一键导出已复核（{reviewedPendingExport.length}）</span><ExportMenu ariaLabel="导出全部已复核" disabled={reviewedPendingExport.length === 0 || batchExporting || exporting !== null || reanalysisBusy} busy={batchExporting} busyLabel="正在打包…" onExport={exportReviewed} /></div>
              <div className="history-export-command"><span>导出所选（{selectedExportableReviews.length}）</span><ExportMenu ariaLabel="导出所选记录" disabled={selectedExportableReviews.length === 0 || batchExporting || exporting !== null || reanalysisBusy} disabledReason={selectedReviewIds.size > 0 && selectedExportableReviews.length === 0 ? "所选记录没有可导出的新格式" : undefined} busy={batchExporting} busyLabel="正在打包…" onExport={exportSelected} /></div>
              <button className="button button--primary" type="button" disabled={selectedReviewIds.size === 0 || selectedReviewIds.size > BATCH_REANALYSIS_LIMIT || batchExporting || exporting !== null || reanalysisBusy} onClick={() => void openBatchReanalysis()}>
                {reanalysisLoading ? "正在预览…" : "按最新框架重新分析"}
              </button>
              <button className="button" type="button" disabled={failedInView.length === 0 || batchExporting || exporting !== null || reanalysisBusy} onClick={() => void regradeFailed()}>
                {failedRegrade?.running ? "正在重新批改…" : `一键重新批改失败作文（${failedInView.length}）`}
              </button>
              {selectedReviewIds.size > BATCH_REANALYSIS_LIMIT ? <span className="history-limit-note" role="status">每次最多重新分析 {BATCH_REANALYSIS_LIMIT} 篇</span> : null}
              {failedRegrade?.running ? <p className="history-limit-note" role="status">正在重新批改失败作文，已处理 {failedRegrade.completed} / {failedRegrade.total} 篇</p> : null}
              {failedRegrade && !failedRegrade.running ? <div className="history-limit-note" role="status">
                <p>{failedRegrade.error
                  ? `重新批改中断：已提交 ${failedRegrade.submitted} 篇。${failedRegrade.error}`
                  : `重新批改结束：已提交 ${failedRegrade.submitted} 篇${failedRegrade.skipped.length > 0 ? `，跳过 ${failedRegrade.skipped.length} 篇` : "。"}${failedRegrade.failures.length > 0 ? `这次失败 ${failedRegrade.failures.length} 篇。` : ""}`}</p>
                {failedRegrade.skipped.length > 0 ? <ul>
                  {failedRegrade.skipped.map((item) => <li key={`${item.reviewId}:${item.code}`}>{item.studentName ? `${item.studentName}：` : ""}{item.reason}</li>)}
                </ul> : null}
                {failedRegrade.failures.length > 0 ? <ul>
                  {failedRegrade.failures.map((item) => <li key={item.reviewId}>{item.studentName}：{item.summary}</li>)}
                </ul> : null}
              </div> : null}
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
                    <span>学生：{review.studentName || "未填写"}</span><span>班级：{review.className || "未分类"}</span>
                    <time>{reviewDate(review.updatedAt ?? review.createdAt)}</time>
                  </div>
                  <h3><Link href={`/reviews?id=${encodeURIComponent(review.id)}`}>{review.config.title}</Link></h3>
                  {review.status === "failed" && review.analysisFailure ? <p>
                    {review.analysisFailure.summary}
                    {review.analysisFailure.detail ? <details><summary>查看原始信息</summary><p>{review.analysisFailure.detail}</p></details> : null}
                  </p> : null}
                  <p>{review.report ? (() => { const grade = review.report.grade ?? gradeFromLegacyTotal(review.report.scores?.total ?? 0); return `${grade}${grade === "C" ? " · 需要重写" : " · 已完成四维诊断"}`; })() : "尚未生成等级评定"}</p>
                  <p className="muted">长期保留，可手动永久删除</p>
                </div>
                <div className="card-actions">
                  <Link className="button button--quiet" href={`/reviews?id=${encodeURIComponent(review.id)}`}>进入复核</Link>
                  {review.report && isLegacyEvaluationReport(review.report) ? review.hasPdf && review.pdfFilename?.trim() ? <button className="button button--quiet" type="button" disabled={exporting !== null || batchExporting} onClick={() => void downloadLegacyPdf(review)}>{exporting === review.id ? "正在下载…" : "下载已生成的旧版 PDF"}</button> : <Link className="button button--quiet" href={`/reviews?id=${encodeURIComponent(review.id)}`}>完整重新分析</Link> : (() => { const eligibility = exportEligibility(review); return <ExportMenu ariaLabel={`导出《${review.config.title}》`} disabled={!eligibility.eligible || exporting !== null || batchExporting} disabledReason={!eligibility.eligible ? eligibility.reason : undefined} busy={exporting === review.id} onExport={(format) => exportReview(review, format)} />; })()}
                  {review.report && isLegacyEvaluationReport(review.report) ? <span className="export-menu-reason">旧版示范段落报告需要完整重新分析后才能导出新格式</span> : null}
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
