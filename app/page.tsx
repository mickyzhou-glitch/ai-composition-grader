"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AppHeader } from "./components/AppHeader";
import { ErrorBanner } from "./components/ErrorBanner";
import { StatusBadge } from "./components/StatusBadge";
import { apiFetch, errorMessage } from "./lib/api";
import { downloadReviewPdf } from "./lib/pdf-download";
import type { ReviewView } from "./lib/types";

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

  const stats = useMemo(() => ({
    draft: reviews.filter(({ status }) => status === "draft").length,
    review: reviews.filter(({ status }) => ["analyzing", "needs_better_images", "ready_for_review", "failed"].includes(status)).length,
    exported: reviews.filter(({ status }) => status === "exported").length,
  }), [reviews]);

  async function remove(review: ReviewView) {
    if (!window.confirm(`确认删除《${review.config.title}》？此操作无法撤销。`)) return;
    setDeleting(review.id);
    setError("");
    try {
      await apiFetch(`/api/reviews/${encodeURIComponent(review.id)}`, { method: "DELETE" });
      setReviews((current) => current.filter(({ id }) => id !== review.id));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setDeleting(null);
    }
  }

  async function exportPdf(review: ReviewView) {
    if (exporting) return;
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
          <div><dt>已导出</dt><dd>{stats.exported}</dd></div>
        </dl>

        <section className="history-section" aria-labelledby="recent-title">
          <div className="section-heading">
            <div><p className="eyebrow">最近工作</p><h2 id="recent-title">批改历史</h2></div>
            <span className="muted">共 {reviews.length} 篇</span>
          </div>
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
            {reviews.map((review) => (
              <article className="history-card" key={review.id}>
                <div className="history-main">
                  <div className="history-meta"><StatusBadge status={review.status} /><time>{reviewDate(review.updatedAt ?? review.createdAt)}</time></div>
                  <h3><Link href={`/reviews/${encodeURIComponent(review.id)}`}>{review.config.title}</Link></h3>
                  <p>{review.report ? `${review.report.scores.total} 分 · ${review.report.scores.level}` : "尚未生成评分"}</p>
                </div>
                <div className="card-actions">
                  <Link className="button button--quiet" href={`/reviews/${encodeURIComponent(review.id)}`}>进入复核</Link>
                  <button
                    className="button button--quiet"
                    type="button"
                    aria-busy={exporting === review.id}
                    disabled={exporting !== null}
                    onClick={() => void exportPdf(review)}
                  >
                    {exporting === review.id
                      ? review.hasPdf ? "正在下载…" : "正在导出…"
                      : review.hasPdf ? "下载 PDF" : "重新导出"}
                  </button>
                  <button className="button button--danger-quiet" type="button" disabled={deleting === review.id} onClick={() => void remove(review)} aria-label={`删除《${review.config.title}》`}>
                    {deleting === review.id ? "删除中…" : "删除"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
