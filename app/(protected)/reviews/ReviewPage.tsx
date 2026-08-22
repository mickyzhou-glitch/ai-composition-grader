"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  evaluationReportSchema,
  expectedSampleParagraphCount,
  MAX_REVIEW_IMAGES,
  PRIVACY_NOTICE_VERSION,
  type Annotation,
  type EvaluationReport,
} from "@/src/domain/contracts";
import { AppHeader } from "../../components/AppHeader";
import { AsyncButton } from "../../components/AsyncButton";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ParentFeedbackEditor } from "../../components/ParentFeedbackEditor";
import { OcrTextEditor } from "../../components/OcrTextEditor";
import { PhotoAnnotationEditor } from "../../components/PhotoAnnotationEditor";
import { ReportEditor, type FeedbackSection } from "../../components/ReportEditor";
import { StatusBadge } from "../../components/StatusBadge";
import { ApiError, apiFetch, errorMessage } from "../../lib/api";
import { prepareImageForCloudUpload } from "../../lib/image-upload-transform";
import { downloadReviewPdf } from "../../lib/pdf-download";
import type { ReviewView } from "../../lib/types";

interface AnalysisJobView {
  id: string;
  reviewId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  progressStage: "queued" | "reading_images" | "saving_ocr" | "generating_review" | "mapping_annotations" | "validating_result" | "saving_result";
  message: string | null;
  createdAt: string;
  finishedAt: string | null;
}

type ReviewLoadResult = { ok: true } | { ok: false; error: unknown };

const stageLabels: Record<AnalysisJobView["progressStage"], string> = {
  queued: "排队中",
  reading_images: "正在识别作文",
  saving_ocr: "正在识别作文",
  generating_review: "正在生成批改内容",
  mapping_annotations: "正在生成批改内容",
  validating_result: "正在生成批改内容",
  saving_result: "正在保存结果",
};

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

const diagnosticFieldLabels: Record<string, string> = {
  authenticityAndRelevance: "真实度与切题",
  materialAndDetails: "素材与细节",
  structure: "结构要求",
  language: "语言流畅度",
};

function validationPathMessage(inputPath: readonly unknown[]): string | null {
  const path = inputPath[0] === "report" ? inputPath.slice(1) : inputPath;
  if (path[0] === "themeReason") return "主题判断依据不能为空";
  if (path[0] === "personalizedComment") return "优点至少保留一项，且内容不能为空";
  if (path[0] === "sampleParagraphs" && typeof path[1] === "number") {
    const field = path[2] === "title" ? "标题" : path[2] === "suggestion" ? "修改建议" : "示范正文";
    return `示范文第 ${path[1] + 1} 段的${field}不能为空`;
  }
  if (path[0] === "diagnostics" && typeof path[1] === "string") {
    const field = path[2] === "action" ? "修改动作" : "精准定位";
    return `${diagnosticFieldLabels[path[1]] ?? "四维诊断"}的${field}不能为空`;
  }
  if (path[0] === "parentFeedbacks" && typeof path[1] === "number") {
    return `第 ${path[1] + 1} 份家长反馈不能为空`;
  }
  if (path[0] === "studentName") return "学生姓名不能超过 50 个字";
  if (path[0] === "annotations") return "图片批注位置或内容无效，请检查后再保存";
  return null;
}

function reportValidationMessage(report: EvaluationReport): string | null {
  const result = evaluationReportSchema.safeParse(report);
  if (result.success) return null;
  return validationPathMessage(result.error.issues[0]?.path ?? [])
    ?? "复核内容有未填写或格式不正确的项目，请检查后再保存";
}

function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === "VALIDATION_ERROR") {
    const details = error.details;
    if (typeof details === "object" && details !== null && "path" in details) {
      const path = (details as { path?: unknown }).path;
      const message = validationPathMessage(Array.isArray(path) ? path : []);
      if (message) return message;
    }
  }
  return errorMessage(error);
}

export function ReviewPage({ reviewId }: { reviewId: string }) {
  const [review, setReview] = useState<ReviewView | null>(null);
  const [studentName, setStudentName] = useState("");
  const [teacherGuidance, setTeacherGuidance] = useState("");
  const [report, setReport] = useState<EvaluationReport | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [analysisJob, setAnalysisJob] = useState<AnalysisJobView | null>(null);
  const [activePage, setActivePage] = useState(0);
  const [activeView, setActiveView] = useState<"report" | "ocr">("report");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "analyze" | "replace" | "export" | "rewrite-feedback" | "rewrite-sample" | "rewrite-all-samples" | null>(null);
  const [rewritingFeedbackSection, setRewritingFeedbackSection] = useState<FeedbackSection | null>(null);
  const [rewritingSampleIndex, setRewritingSampleIndex] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loadingAnalysisResult, setLoadingAnalysisResult] = useState(false);
  const [analysisResultLoadFailed, setAnalysisResultLoadFailed] = useState(false);
  const [analysisResultRetry, setAnalysisResultRetry] = useState(0);
  const mountedRef = useRef(false);
  const requestTokenRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const jobRequestTokenRef = useRef(0);
  const jobRequestControllerRef = useRef<AbortController | null>(null);
  const refreshedTerminalJobRef = useRef<string | null>(null);

  const invalidateLoad = useCallback(() => {
    requestTokenRef.current += 1;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
  }, []);

  const invalidateJobLoad = useCallback(() => {
    jobRequestTokenRef.current += 1;
    jobRequestControllerRef.current?.abort();
    jobRequestControllerRef.current = null;
  }, []);

  const applyReview = useCallback((loaded: ReviewView) => {
    setReview(loaded);
    setStudentName(loaded.studentName);
    setReport(loaded.report);
    setAnnotations(loaded.annotations ?? []);
    setActivePage((current) => Math.min(current, Math.max(0, loaded.images.length - 1)));
  }, []);

  const loadJob = useCallback(async () => {
    const token = jobRequestTokenRef.current + 1;
    jobRequestTokenRef.current = token;
    jobRequestControllerRef.current?.abort();
    const controller = new AbortController();
    jobRequestControllerRef.current = controller;
    const isLatest = () => mountedRef.current && jobRequestTokenRef.current === token;
    try {
      const result = await apiFetch<{ job: AnalysisJobView | null }>(
        `/api/reviews/${encodeURIComponent(reviewId)}/analyze/status`,
        { signal: controller.signal },
      );
      if (!isLatest()) return null;
      setAnalysisJob(result.job);
      if (result.job) {
        setNotice((current) => current.startsWith("AI 分析已提交：") ? "" : current);
      }
      return result.job;
    } finally {
      if (jobRequestTokenRef.current === token) jobRequestControllerRef.current = null;
    }
  }, [reviewId]);

  const loadReview = useCallback(async (showLoading = true, reportError = true): Promise<ReviewLoadResult> => {
    const token = requestTokenRef.current + 1;
    requestTokenRef.current = token;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    const controller = new AbortController();
    requestControllerRef.current = controller;
    const isLatest = () =>
      mountedRef.current &&
      requestTokenRef.current === token;

    if (showLoading && isLatest()) setLoading(true);
    if (isLatest()) setError("");
    try {
      const loaded = await apiFetch<ReviewView>(`/api/reviews/${encodeURIComponent(reviewId)}`, {
        signal: controller.signal,
      });
      if (isLatest()) {
        applyReview(loaded);
        setDirty(false);
      }
      return isLatest() ? { ok: true } : { ok: false, error: new DOMException("Request superseded", "AbortError") };
    } catch (caught) {
      if (isLatest() && !isAbortError(caught) && reportError) setError(errorMessage(caught));
      return { ok: false, error: caught };
    } finally {
      if (showLoading && isLatest()) setLoading(false);
    }
  }, [applyReview, reviewId]);

  const refresh = useCallback(async (showLoading = true, force = false) => {
    if (dirty && !force) {
      setNotice("本地复核内容尚未保存，已保留当前草稿。");
      return;
    }
    await loadReview(showLoading);
  }, [dirty, loadReview]);

  async function forceRefresh() {
    if (!window.confirm("将放弃当前未保存的复核修改并加载服务器最新内容，确定继续吗？")) return;
    await refresh(true, true);
  }

  useEffect(() => {
    mountedRef.current = true;
    const token = requestTokenRef.current + 1;
    requestTokenRef.current = token;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    const isLatest = () => mountedRef.current && requestTokenRef.current === token;

    void Promise.resolve().then(() => {
      if (!isLatest()) return;
      setLoading(true);
      setError("");
    });
    void apiFetch<ReviewView>(`/api/reviews/${encodeURIComponent(reviewId)}`, {
      signal: controller.signal,
    })
      .then((loaded) => {
        if (isLatest()) {
          applyReview(loaded);
          // Query the durable job separately: a refresh can happen while the
          // job is still queued, before the worker changes review.status.
          void loadJob().catch(() => undefined);
        }
      })
      .catch((caught) => {
        if (!isLatest() || isAbortError(caught)) return;
        setReview((current) => current?.id === reviewId ? current : null);
        setError(errorMessage(caught));
      })
      .finally(() => {
        if (isLatest()) setLoading(false);
      });
    return () => {
      mountedRef.current = false;
      invalidateLoad();
      invalidateJobLoad();
    };
  }, [applyReview, invalidateJobLoad, invalidateLoad, loadJob, reviewId]);

  useEffect(() => {
    if (!analysisJob) return;
    if (analysisJob.status === "succeeded") {
      const terminalKey = `${analysisJob.id}:${analysisJob.status}:${analysisJob.finishedAt ?? "pending"}`;
      if (refreshedTerminalJobRef.current === terminalKey) return;
      let canceled = false;
      let retryTimer: number | null = null;
      let retryCount = 0;
      setLoadingAnalysisResult(true);
      setAnalysisResultLoadFailed(false);
      setError("");
      const loadFinalResult = async () => {
        const result = await loadReview(false, false);
        if (canceled) return;
        if (result.ok) {
          refreshedTerminalJobRef.current = terminalKey;
          setLoadingAnalysisResult(false);
          setAnalysisJob((current) => current?.id === analysisJob.id ? null : current);
          return;
        }
        const retryable = result.error instanceof TypeError ||
          (result.error instanceof ApiError && result.error.status >= 500);
        if (retryable && retryCount < 3) {
          const delay = 1500 * (2 ** retryCount);
          retryCount += 1;
          retryTimer = window.setTimeout(() => void loadFinalResult(), delay);
          return;
        }
        setLoadingAnalysisResult(false);
        setAnalysisResultLoadFailed(true);
        setError(retryable
          ? "网络连接不稳定，批改结果暂时无法加载。"
          : "批改结果加载失败，请重新加载。");
      };
      void loadFinalResult();
      return () => {
        canceled = true;
        if (retryTimer !== null) window.clearTimeout(retryTimer);
      };
    }
    if (analysisJob.status === "failed" || analysisJob.status === "canceled") {
      const terminalKey = `${analysisJob.id}:${analysisJob.status}:${analysisJob.finishedAt ?? "pending"}`;
      if (refreshedTerminalJobRef.current === terminalKey) return;
      refreshedTerminalJobRef.current = terminalKey;
      void loadReview(false);
      return;
    }
    const timer = window.setInterval(() => {
      void loadJob().catch(() => {
        if (mountedRef.current) setNotice("任务状态暂时无法刷新，正在尝试重新连接。");
      });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [analysisJob, analysisResultRetry, loadJob, loadReview]);

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
    if (analysisJob?.status === "queued" || analysisJob?.status === "running") return;
    invalidateLoad();
    setAnnotations(next);
    setDirty(true);
    setNotice("");
  }

  function changeReport(next: EvaluationReport) {
    if (analysisJob?.status === "queued" || analysisJob?.status === "running") return;
    invalidateLoad();
    setReport(next);
    setDirty(true);
    setNotice("");
  }

  function changeStudentName(next: string) {
    if (analysisJob?.status === "queued" || analysisJob?.status === "running") return;
    invalidateLoad();
    setStudentName(next);
    setDirty(true);
    setNotice("");
  }

  async function rewriteSample(index: number, instruction?: string) {
    if (!review || !report || busy || analysisJob?.status === "queued" || analysisJob?.status === "running") return;
    setBusy("rewrite-sample");
    setRewritingSampleIndex(index);
    setError("");
    setNotice("");
    try {
      const result = await apiFetch<{ text: string }>(
        `/api/reviews/${encodeURIComponent(review.id)}/sample-paragraphs/${index}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(instruction?.trim() ? { instruction } : {}),
        },
      );
      changeReport({
        ...report,
        sampleParagraphs: report.sampleParagraphs.map((sample, sampleIndex) =>
          sampleIndex === index ? { ...sample, text: result.text } : sample,
        ),
      });
      setNotice(`第 ${index + 1} 段示范正文已由 AI 更新，请复核后保存。`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRewritingSampleIndex(null);
      setBusy(null);
    }
  }

  async function rewriteFeedback(section: FeedbackSection) {
    if (!review || !report || busy || analysisJob?.status === "queued" || analysisJob?.status === "running") return;
    setBusy("rewrite-feedback");
    setRewritingFeedbackSection(section);
    setError("");
    setNotice("");
    try {
      const result = await apiFetch<{ items: string[] }>(
        `/api/reviews/${encodeURIComponent(review.id)}/feedback/${section}`,
        { method: "POST" },
      );
      changeReport(section === "strengths"
        ? { ...report, personalizedComment: result.items.join("\n") }
        : { ...report, painPoints: result.items });
      setNotice(`${section === "strengths" ? "优点" : "需要修改"}已由 AI 重新生成，请复核后保存。`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRewritingFeedbackSection(null);
      setBusy(null);
    }
  }

  async function rewriteAllSamples(instruction?: string) {
    if (!review || !report || busy || analysisJob?.status === "queued" || analysisJob?.status === "running") return;
    setBusy("rewrite-all-samples");
    setError("");
    setNotice("");
    try {
      const result = await apiFetch<{ sampleParagraphs: EvaluationReport["sampleParagraphs"] }>(
        `/api/reviews/${encodeURIComponent(review.id)}/sample-paragraphs/regenerate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(instruction?.trim() ? { instruction } : {}),
        },
      );
      changeReport({ ...report, sampleParagraphs: result.sampleParagraphs });
      setNotice(`整篇 ${expectedSampleParagraphCount(review.config)} 段示范正文已由 AI 更新，请复核后保存。`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!report || !review || busy || analysisJob?.status === "queued" || analysisJob?.status === "running") return;
    const validationMessage = reportValidationMessage(report);
    if (validationMessage) {
      setError(validationMessage);
      setNotice("");
      return;
    }
    setBusy("save");
    setError("");
    try {
      const saved = await apiFetch<ReviewView>(`/api/reviews/${encodeURIComponent(reviewId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: review.revision,
          studentName,
          report,
          annotations,
        }),
      });
      applyReview(saved);
      setDirty(false);
      setNotice("复核内容已保存");
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 409 ? "内容发生冲突，请刷新后重新检查。" : saveErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function analyze(mode: "full" | "content_only" = "full") {
    if (busy) return;
    if (dirty && !window.confirm("当前复核内容尚未保存，重新分析会覆盖这些修改。确定继续吗？")) {
      return;
    }
    invalidateLoad();
    invalidateJobLoad();
    setAnalysisResultLoadFailed(false);
    setBusy("analyze");
    setError("");
    setNotice("");
    try {
      const job = await apiFetch<AnalysisJobView>(`/api/reviews/${encodeURIComponent(reviewId)}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(mode === "content_only" ? { mode } : {}),
          ...(teacherGuidance.trim() ? { teacherGuidance: teacherGuidance.trim() } : {}),
        }),
      });
      setAnalysisJob(job);
      setDirty(false);
      setNotice(`AI 分析已提交：${stageLabels[job.progressStage]}`);
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 409 ? "分析结果与当前内容冲突，请刷新后重试。" : errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function replaceImages(files: File[]) {
    if (!review || busy || analysisJob?.status === "queued" || analysisJob?.status === "running") return;
    if (files.length < 1 || files.length > MAX_REVIEW_IMAGES) {
      setError(`请选择 1 至 ${MAX_REVIEW_IMAGES} 张作文图片`);
      return;
    }
    if (dirty && !window.confirm("当前复核内容尚未保存，替换图片会清空这些修改。确定继续吗？")) {
      return;
    }
    invalidateLoad();
    setBusy("replace");
    setError("");
    setNotice("");
    try {
      const form = new FormData();
      form.append("expectedRevision", String(review.revision));
      form.append("privacyConfirmed", "true");
      form.append("privacyNoticeVersion", PRIVACY_NOTICE_VERSION);
      const prepared = await Promise.all(files.map((file) => prepareImageForCloudUpload({ file, rotation: 0, crop: null })));
      prepared.forEach(({ file }) => form.append("images", file));
      form.append("imageMeta", JSON.stringify(prepared.map(({ width, height }) => ({ width, height }))));
      const uploaded = await apiFetch<{ images: ReviewView["images"]; revision: number }>(
        `/api/reviews/${encodeURIComponent(reviewId)}/images`,
        { method: "POST", body: form },
      );
      setReview((current) => current ? {
        ...current,
        images: uploaded.images,
        status: "draft",
        report: null,
        annotations: [],
        revision: uploaded.revision,
      } : current);
      setReport(null);
      setAnnotations([]);
      setActivePage(0);
      setDirty(false);
      setNotice("作文图片已压缩优化并替换，可重新开始 AI 分析。");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function exportPdf() {
    if (!review || !report || busy || dirty) return;
    setBusy("export");
    setError("");
    setNotice("");
    try {
      await downloadReviewPdf(review.id);
      await loadReview(false);
      setNotice("PDF 已导出并开始下载。");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  const analysisActive = loadingAnalysisResult ||
    (analysisJob?.status === "succeeded" && !analysisResultLoadFailed) ||
    analysisJob?.status === "queued" || analysisJob?.status === "running";

  function replacementControl(className = "button button--quiet") {
    return <label className={`${className} file-label`}>
      替换/重拍作文
      <input
        className="visually-hidden"
        aria-label="替换/重拍作文图片"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        disabled={busy !== null || analysisActive}
        onChange={(event) => {
          void replaceImages(Array.from(event.target.files ?? []));
          event.currentTarget.value = "";
        }}
      />
    </label>;
  }

  if (loading || (review !== null && review.id !== reviewId)) return <div className="app-shell"><AppHeader compact /><main className="review-loading" role="status">正在展开作文与批改报告…</main></div>;
  if (!review) return <div className="app-shell"><AppHeader compact /><main className="narrow-page"><ErrorBanner message={error || "批改记录不存在"} onRetry={() => void refresh()} /></main></div>;

  return (
    <div className="app-shell">
      <AppHeader compact />
      <main className="review-page">
        <header className="review-heading">
          <div className="review-title-block">
            <div className="history-meta"><StatusBadge status={review.status} /><span>{review.config.grade}</span></div>
            <h1>{review.config.title}</h1>
            <label className="student-name-field">
              <span>学生姓名</span>
              <input
                aria-label="学生姓名"
                maxLength={50}
                placeholder="请输入学生姓名"
                value={studentName}
                disabled={busy !== null || analysisActive}
                onChange={(event) => changeStudentName(event.target.value)}
              />
            </label>
            <p>左侧核对落笔位置，右侧完善批注与最终评语。</p>
          </div>
          <div className="review-actions">
            <label className="analysis-guidance"><span>老师补充观点（可选）</span><textarea aria-label="老师补充观点" maxLength={1000} placeholder="例如：请重点核对结尾主题是否由正文细节支撑" value={teacherGuidance} disabled={busy !== null || analysisActive} onChange={(event) => setTeacherGuidance(event.target.value)} /></label>
            <AsyncButton className="button button--quiet" busy={busy === "analyze"} busyLabel="正在提交…" disabled={busy !== null || analysisActive} onClick={() => void analyze()}>重新分析</AsyncButton>
            {review.status !== "needs_better_images" ? replacementControl() : null}
            {report ? (
              <AsyncButton
                className="button button--quiet"
                busy={busy === "export"}
                busyLabel="正在生成 PDF…"
                disabled={dirty || busy !== null || analysisActive}
                title={dirty ? "请先保存复核修改再导出" : undefined}
                onClick={() => void exportPdf()}
              >{review.hasPdf ? "下载 PDF" : "导出 PDF"}</AsyncButton>
            ) : null}
            {report ? <AsyncButton className="button button--primary" busy={busy === "save"} busyLabel="保存中…" disabled={!dirty || busy !== null || analysisActive} onClick={() => void save()}>保存复核</AsyncButton> : null}
          </div>
        </header>
        {error ? <ErrorBanner
          message={error}
          onRetry={analysisResultLoadFailed
            ? () => {
                if (dirty && !window.confirm("将放弃当前未保存的复核修改并加载服务器最新内容，确定继续吗？")) return;
                setAnalysisResultLoadFailed(false);
                setAnalysisResultRetry((current) => current + 1);
              }
            : error.includes("冲突") ? () => void forceRefresh() : undefined}
          retryLabel={analysisResultLoadFailed ? "重新加载结果" : error.includes("冲突") ? "放弃本地修改并刷新" : undefined}
        /> : null}
        {notice ? <div className="success-banner" role="status">{notice}</div> : null}
        {loadingAnalysisResult ? <div className="success-banner" role="status">AI 分析已完成，正在加载批改结果。</div> : null}
        {analysisJob && !loadingAnalysisResult && !analysisResultLoadFailed ? <div className="success-banner" role="status">AI 分析：{stageLabels[analysisJob.progressStage]}{analysisJob.message ? `。${analysisJob.message}` : ""}</div> : null}
        {review.reportStale && report ? <div className="stale-report-banner" role="alert"><span>批改报告基于旧版识别原文</span><AsyncButton className="button button--primary" busy={busy === "analyze"} busyLabel="正在提交…" disabled={busy !== null || analysisActive} onClick={() => void analyze("content_only")}>重新生成批改</AsyncButton></div> : null}
        <div className="privacy-note" role="note">作文图片与批改文件会长期保留，老师可在历史记录中手动永久删除。</div>
        {review.status === "needs_better_images" ? <div className="retake-banner" role="alert"><b>图片暂时无法辨认</b><span>请直接重新拍摄并替换：保持平整、光线均匀并拍全纸张边缘。</span>{replacementControl("button button--quiet retake-upload")}</div> : null}
        <div className="review-view-tabs" role="tablist" aria-label="复核内容">
          <button type="button" role="tab" aria-selected={activeView === "report"} aria-controls="review-report-panel" onClick={() => setActiveView("report")}>批改报告</button>
          <button type="button" role="tab" aria-selected={activeView === "ocr"} aria-controls="review-ocr-panel" disabled={!review.ocr} onClick={() => setActiveView("ocr")}>识别原文</button>
        </div>
        <section id="review-report-panel" role="tabpanel" aria-label="批改报告" hidden={activeView !== "report"}>
          {report ? (
            <ParentFeedbackEditor
              feedbacks={report.parentFeedbacks ?? []}
              savedFeedbacks={review.report?.parentFeedbacks ?? []}
              disabled={busy !== null || analysisActive}
              onChange={(parentFeedbacks) => changeReport({ ...report, parentFeedbacks })}
              onCopySuccess={() => {
                setError("");
                setNotice("家长反馈已复制");
              }}
              onCopyError={() => {
                setNotice("");
                setError("无法自动复制，请选中文本后手动复制。");
              }}
            />
          ) : null}
          <div className="review-grid" role="region" aria-label="作文复核工作区">
          <div className="photo-pane">
            {review.images.length > 1 ? <div className="page-tabs" role="tablist" aria-label="作文页码">{review.images.map((image, index) => <button role="tab" aria-selected={activePage === index} key={image.id} onClick={() => setActivePage(index)}>第 {index + 1} 页</button>)}</div> : null}
            {activeImage ? <PhotoAnnotationEditor imageUrl={`/api/reviews/${encodeURIComponent(review.id)}/files?imageId=${activeImage.id}&variant=annotation`} pageIndex={activePage} annotations={annotations} onChange={changeAnnotations} /> : <div className="empty-state"><h3>尚未上传作文图片</h3><p>请从新建流程上传 1 至 {MAX_REVIEW_IMAGES} 张图片后再分析。</p></div>}
          </div>
          <div className="report-pane">
            {report ? <ReportEditor report={report} onChange={changeReport} onRewriteFeedback={rewriteFeedback} rewritingFeedbackSection={rewritingFeedbackSection} onRewriteSample={rewriteSample} rewritingSampleIndex={rewritingSampleIndex} onRewriteAllSamples={rewriteAllSamples} rewritingAllSamples={busy === "rewrite-all-samples"} expectedSampleParagraphCount={expectedSampleParagraphCount(review.config)} /> : <div className="analysis-guide"><span className="empty-seal" aria-hidden="true">析</span><h2>先让 AI 细读作文</h2><p>分析后会生成逐页红批、四维诊断、等级评定和可直接参考的示范段落。所有内容都由你最终复核。</p><AsyncButton className="button button--primary" busy={busy === "analyze"} busyLabel="正在提交…" disabled={review.images.length === 0 || busy !== null || analysisActive} onClick={() => void analyze()}>开始 AI 分析</AsyncButton></div>}
          </div>
          </div>
        </section>
        {review.ocr ? <section id="review-ocr-panel" role="tabpanel" aria-label="识别原文" hidden={activeView !== "ocr"}>
          <OcrTextEditor
            key={`${review.id}:${review.ocr.ocrRevision}`}
            reviewId={review.id}
            ocr={review.ocr}
            disabled={busy !== null || analysisActive}
            onSaved={(saved) => {
              applyReview(saved);
              setNotice("识别原文已保存，可重新生成批改。");
            }}
          />
        </section> : null}
      </main>
    </div>
  );
}

export default function LegacyReviewPage() {
  const { id } = useParams<{ id: string }>();
  return <ReviewPage reviewId={String(id)} />;
}
