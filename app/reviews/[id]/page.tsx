"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Annotation, EvaluationReport } from "@/src/domain/contracts";
import { AppHeader } from "../../components/AppHeader";
import { AsyncButton } from "../../components/AsyncButton";
import { ErrorBanner } from "../../components/ErrorBanner";
import { PhotoAnnotationEditor } from "../../components/PhotoAnnotationEditor";
import { ReportEditor } from "../../components/ReportEditor";
import { StatusBadge } from "../../components/StatusBadge";
import { ApiError, apiFetch, errorMessage } from "../../lib/api";
import type { ReviewView } from "../../lib/types";

interface AnalyzeResult { review: ReviewView; pageWarnings: string[] }

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const reviewId = String(id);
  const [review, setReview] = useState<ReviewView | null>(null);
  const [report, setReport] = useState<EvaluationReport | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [activePage, setActivePage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "analyze" | "replace" | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const applyReview = useCallback((loaded: ReviewView) => {
    setReview(loaded);
    setReport(loaded.report);
    setAnnotations(loaded.annotations ?? []);
    setActivePage((current) => Math.min(current, Math.max(0, loaded.images.length - 1)));
  }, []);

  const refresh = useCallback(async (showLoading = true) => {
    if (dirty) {
      setNotice("本地复核内容尚未保存，已保留当前草稿。");
      return;
    }
    if (showLoading) setLoading(true);
    setError("");
    try {
      applyReview(await apiFetch<ReviewView>(`/api/reviews/${encodeURIComponent(reviewId)}`));
      setDirty(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [applyReview, dirty, reviewId]);

  useEffect(() => {
    let active = true;
    void apiFetch<ReviewView>(`/api/reviews/${encodeURIComponent(reviewId)}`)
      .then((loaded) => { if (active) applyReview(loaded); })
      .catch((caught) => { if (active) setError(errorMessage(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [applyReview, reviewId]);

  useEffect(() => {
    if (review?.status !== "analyzing") return;
    const timer = window.setInterval(() => { void refresh(false); }, 1500);
    return () => window.clearInterval(timer);
  }, [refresh, review?.status]);

  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const followLink = (event: MouseEvent) => {
      const link = (event.target as Element).closest("a");
      if (!link || link.target === "_blank" || link.href === window.location.href) return;
      if (!window.confirm("复核内容尚未保存，确定离开吗？")) event.preventDefault();
    };
    window.addEventListener("beforeunload", leave);
    document.addEventListener("click", followLink, true);
    return () => {
      window.removeEventListener("beforeunload", leave);
      document.removeEventListener("click", followLink, true);
    };
  }, [dirty]);

  const activeImage = useMemo(
    () => review?.images.find(({ position }) => position === activePage) ?? review?.images[activePage],
    [activePage, review?.images],
  );

  function changeAnnotations(next: Annotation[]) {
    setAnnotations(next);
    setDirty(true);
    setNotice("");
  }

  function changeReport(next: EvaluationReport) {
    setReport(next);
    setDirty(true);
    setNotice("");
  }

  async function save() {
    if (!report) return;
    setBusy("save");
    setError("");
    try {
      const saved = await apiFetch<ReviewView>(`/api/reviews/${encodeURIComponent(reviewId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ report, annotations }),
      });
      applyReview(saved);
      setDirty(false);
      setNotice("复核内容已保存");
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 409 ? "内容发生冲突，请刷新后重新检查。" : errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function analyze() {
    if (dirty && !window.confirm("当前复核内容尚未保存，重新分析会覆盖这些修改。确定继续吗？")) {
      return;
    }
    setBusy("analyze");
    setError("");
    setNotice("");
    try {
      const result = await apiFetch<AnalyzeResult>(`/api/reviews/${encodeURIComponent(reviewId)}/analyze`, { method: "POST" });
      applyReview(result.review);
      setDirty(false);
      setNotice(result.pageWarnings.length ? `分析完成：${result.pageWarnings.join("；")}` : "AI 分析完成，请开始复核。 ");
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 409 ? "分析结果与当前内容冲突，请刷新后重试。" : errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function replaceImages(files: File[]) {
    if (files.length < 1 || files.length > 3) {
      setError("请选择 1 至 3 张作文图片");
      return;
    }
    setBusy("replace");
    setError("");
    setNotice("");
    try {
      const form = new FormData();
      files.forEach((file) => form.append("images", file));
      const uploaded = await apiFetch<{ images: ReviewView["images"] }>(
        `/api/reviews/${encodeURIComponent(reviewId)}/images`,
        { method: "POST", body: form },
      );
      setReview((current) => current ? {
        ...current,
        images: uploaded.images,
        status: "draft",
        report: null,
        annotations: [],
        revision: current.revision + 1,
      } : current);
      setReport(null);
      setAnnotations([]);
      setActivePage(0);
      setDirty(false);
      setNotice("作文图片已替换，可重新开始 AI 分析。");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  function replacementControl(className = "button button--quiet") {
    return <label className={className}>
      替换/重拍作文
      <input
        className="visually-hidden"
        aria-label="替换/重拍作文图片"
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        multiple
        disabled={busy === "replace"}
        onChange={(event) => {
          void replaceImages(Array.from(event.target.files ?? []));
          event.currentTarget.value = "";
        }}
      />
    </label>;
  }

  if (loading) return <div className="app-shell"><AppHeader compact /><main className="review-loading" role="status">正在展开作文与批改报告…</main></div>;
  if (!review) return <div className="app-shell"><AppHeader compact /><main className="narrow-page"><ErrorBanner message={error || "批改记录不存在"} onRetry={() => void refresh()} /></main></div>;

  return (
    <div className="app-shell">
      <AppHeader compact />
      <main className="review-page">
        <header className="review-heading">
          <div><div className="history-meta"><StatusBadge status={review.status} /><span>{review.config.grade}</span></div><h1>{review.config.title}</h1><p>左侧核对落笔位置，右侧完善批注与最终评语。</p></div>
          <div className="review-actions"><AsyncButton className="button button--quiet" busy={busy === "analyze"} busyLabel="AI 正在细读…" onClick={() => void analyze()}>重新分析</AsyncButton>{review.status !== "needs_better_images" ? replacementControl() : null}{report ? <AsyncButton className="button button--primary" busy={busy === "save"} busyLabel="保存中…" disabled={!dirty} onClick={() => void save()}>保存复核</AsyncButton> : null}</div>
        </header>
        {error ? <ErrorBanner message={error} onRetry={error.includes("冲突") ? () => void refresh() : undefined} /> : null}
        {notice ? <div className="success-banner" role="status">{notice}</div> : null}
        {review.status === "needs_better_images" ? <div className="retake-banner" role="alert"><b>图片暂时无法辨认</b><span>请直接重新拍摄并替换：保持平整、光线均匀并拍全纸张边缘。</span>{replacementControl("button button--quiet retake-upload")}</div> : null}

        <section className="review-grid" aria-label="作文复核工作区">
          <div className="photo-pane">
            {review.images.length > 1 ? <div className="page-tabs" role="tablist" aria-label="作文页码">{review.images.map((image, index) => <button role="tab" aria-selected={activePage === index} key={image.id} onClick={() => setActivePage(index)}>第 {index + 1} 页</button>)}</div> : null}
            {activeImage ? <PhotoAnnotationEditor imageUrl={`/api/reviews/${encodeURIComponent(review.id)}/files?imageId=${activeImage.id}&variant=annotation`} pageIndex={activePage} annotations={annotations} onChange={changeAnnotations} /> : <div className="empty-state"><h3>尚未上传作文图片</h3><p>请从新建流程上传 1 至 3 张图片后再分析。</p></div>}
          </div>
          <div className="report-pane">
            {report ? <ReportEditor report={report} onChange={changeReport} /> : <div className="analysis-guide"><span className="empty-seal" aria-hidden="true">析</span><h2>先让 AI 细读作文</h2><p>分析后会生成逐页红批、主题判断、五项评分和示范段落。所有内容都由你最终复核。</p><AsyncButton className="button button--primary" busy={busy === "analyze"} busyLabel="AI 正在细读…" disabled={review.images.length === 0} onClick={() => void analyze()}>开始 AI 分析</AsyncButton></div>}
          </div>
        </section>
      </main>
    </div>
  );
}
