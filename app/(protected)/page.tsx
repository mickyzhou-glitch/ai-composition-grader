"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ClassFilter } from "../components/ClassFilter";
import { ClassRosterDialog, type RosterSavePayload } from "../components/ClassRosterDialog";
import { MissingSubmissionPanel } from "../components/MissingSubmissionPanel";
import { TitleFilter } from "../components/TitleFilter";
import { classNames, filterReviewsByClass, filterReviewsByTitle, titleNames } from "../lib/classification";
import { AppHeader } from "../components/AppHeader";
import { BatchReanalysisDialog } from "../components/BatchReanalysisDialog";
import { ErrorBanner } from "../components/ErrorBanner";
import { ExportMenu } from "../components/ExportMenu";
import { StatusBadge } from "../components/StatusBadge";
import { apiFetch, errorMessage } from "../lib/api";
import { downloadLegacyCachedPdf, downloadReview, downloadReviewArchive, type ExportFormat } from "../lib/review-export";
import { chunkItems } from "../lib/failed-regrade";
import {
  exportEligibility,
  filterReviewsByStudentName,
  isReviewedPendingExport,
  isReviewFailed,
  matchesHistoryStatus,
  reviewDisplayStatus,
  toReviewSummary,
  type HistoryStatusFilter,
} from "../lib/review-queue";
import type {
  BatchReanalysisCommitItem,
  BatchReanalysisCommitResult,
  BatchReanalysisPreview,
  ClassRosterView,
  PublicAnalysisJobView,
  ReviewHistoryStatsView,
  ReviewSummaryPageView,
  ReviewSummaryView,
  ReviewView,
} from "../lib/types";
import { BATCH_REANALYSIS_LIMIT } from "@/src/reanalysis/contracts";

const REGRADE_POLL_INTERVAL_MS = 1_000;
const REGRADE_POLL_DEADLINE_MS = 12 * 60_000;
const ANALYZING_REFRESH_INTERVAL_MS = 4_000;
export const HISTORY_PAGE_SIZE = 20;

const EMPTY_STATS: ReviewHistoryStatsView = {
  total: 0,
  draft: 0,
  review: 0,
  failed: 0,
  reviewed: 0,
  exported: 0,
  rejected: 0,
};

interface HistoryQueryParams {
  page: number;
  pageSize: number;
  classFilter: string | null;
  titleFilter: string | null;
  statusFilter: HistoryStatusFilter;
  studentSearch: string;
}

function buildSummaryUrl(params: HistoryQueryParams): string {
  const query = new URLSearchParams();
  query.set("summary", "1");
  query.set("page", String(params.page));
  query.set("pageSize", String(params.pageSize));
  if (params.classFilter !== null) query.set("class", params.classFilter);
  if (params.titleFilter !== null) query.set("title", params.titleFilter);
  if (params.statusFilter) query.set("status", params.statusFilter);
  const trimmedSearch = params.studentSearch.trim();
  if (trimmedSearch) query.set("q", trimmedSearch);
  return `/api/reviews?${query.toString()}`;
}

function computePageFromSummaries(
  summaries: ReviewSummaryView[],
  params: HistoryQueryParams,
  rosters: ClassRosterView[] = [],
): ReviewSummaryPageView {
  const stats: ReviewHistoryStatsView = {
    total: summaries.length,
    draft: summaries.filter(({ status }) => status === "draft").length,
    review: summaries.filter((item) => matchesHistoryStatus(item, "review")).length,
    failed: summaries.filter(isReviewFailed).length,
    reviewed: summaries.filter(isReviewedPendingExport).length,
    exported: summaries.filter(({ status }) => status === "exported").length,
    rejected: summaries.filter(({ status }) => status === "rejected").length,
  };
  const exportableReviewedIds = filterReviewsByTitle(
    filterReviewsByClass(summaries.filter(isReviewedPendingExport), params.classFilter),
    params.titleFilter,
  )
    .filter((item) => exportEligibility(item).eligible)
    .map(({ id }) => id);
  const classAndTitleFiltered = filterReviewsByTitle(
    filterReviewsByClass(summaries, params.classFilter),
    params.titleFilter,
  );
  const filtered = filterReviewsByStudentName(classAndTitleFiltered, params.studentSearch)
    .filter((item) => matchesHistoryStatus(item, params.statusFilter));
  const totalPages = Math.max(1, Math.ceil(filtered.length / params.pageSize));
  const safePage = Math.min(Math.max(1, params.page), totalPages);
  const start = (safePage - 1) * params.pageSize;
  const titleSubmissions = params.titleFilter !== null && params.titleFilter !== ""
    ? classAndTitleFiltered.map((item) => ({
        id: item.id,
        className: item.className ?? "",
        studentName: item.studentName ?? "",
        status: item.status,
        teacherReviewedAt: item.teacherReviewedAt,
      }))
    : undefined;
  return {
    items: filtered.slice(start, start + params.pageSize),
    page: safePage,
    pageSize: params.pageSize,
    totalFiltered: filtered.length,
    stats,
    classes: classNames(summaries, rosters.map((item) => item.className)),
    titles: titleNames(summaries),
    rosters,
    ...(titleSubmissions !== undefined ? { titleSubmissions } : {}),
    exportableReviewedIds,
    matchingFailed: filtered.filter(({ status }) => status === "failed").map(({ id, studentName }) => ({ id, studentName })),
  };
}

async function pollRegradeJob(
  reviewId: string,
  jobId: string,
  signal: AbortSignal,
): Promise<{ status: "succeeded" | "failed" | "running"; message: string | null }> {
  const deadline = Date.now() + REGRADE_POLL_DEADLINE_MS;
  while (Date.now() <= deadline && !signal.aborted) {
    const payload = await apiFetch<{ job: PublicAnalysisJobView | null }>(
      `/api/reviews/${encodeURIComponent(reviewId)}/analyze/status`,
      { signal },
    );
    const job = payload.job;
    if (
      job?.id === jobId
      && (job.status === "failed" || job.status === "succeeded" || job.status === "canceled")
    ) {
      return { status: job.status === "canceled" ? "failed" : job.status, message: job.message };
    }
    if (Date.now() + REGRADE_POLL_INTERVAL_MS > deadline || signal.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, REGRADE_POLL_INTERVAL_MS);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  return { status: "running", message: "等待这次分析结果超时" };
}

function reviewDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "日期未知"
    : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(date);
}

export function intersectLiveSelectedExportTargets(
  candidateIds: readonly string[],
  liveSelectedIds: ReadonlySet<string>,
): string[] {
  return candidateIds.filter((id) => liveSelectedIds.has(id));
}

export default function Home() {
  const [serverPage, setServerPage] = useState<ReviewSummaryPageView>({
    items: [],
    page: 1,
    pageSize: HISTORY_PAGE_SIZE,
    totalFiltered: 0,
    stats: EMPTY_STATS,
    classes: [],
    exportableReviewedIds: [],
    matchingFailed: [],
  });
  const [loadedQueryKey, setLoadedQueryKey] = useState<string | null>(null);
  const [legacySummaries, setLegacySummaries] = useState<ReviewSummaryView[] | null>(null);
  const [knownItemsById, setKnownItemsById] = useState<Map<string, ReviewSummaryView>>(() => new Map());
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [queryError, setQueryError] = useState("");
  const [actionError, setActionError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [selectedReviewIds, setSelectedReviewIds] = useState<Set<string>>(() => new Set());
  const [batchExporting, setBatchExporting] = useState(false);
  const [studentSearch, setStudentSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<HistoryStatusFilter>("");
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [titleFilter, setTitleFilter] = useState<string | null>(null);
  const [legacyRosters, setLegacyRosters] = useState<ClassRosterView[]>([]);
  const [rosterDialogSession, setRosterDialogSession] = useState<{ key: number; initialClassName: string } | null>(null);
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

  const mountedRef = useRef(true);
  const regradeControllerRef = useRef<AbortController | null>(null);
  const fetchControllerRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);
  const isLegacyModeRef = useRef(false);

  const currentQueryParams = useMemo<HistoryQueryParams>(() => ({
    page,
    pageSize: HISTORY_PAGE_SIZE,
    classFilter,
    titleFilter,
    statusFilter,
    studentSearch,
  }), [classFilter, page, statusFilter, studentSearch, titleFilter]);

  const currentQueryKey = useMemo(() => buildSummaryUrl(currentQueryParams), [currentQueryParams]);
  const latestQueryParamsRef = useRef<HistoryQueryParams>(currentQueryParams);
  const selectedReviewIdsRef = useRef<Set<string>>(selectedReviewIds);
  useEffect(() => {
    latestQueryParamsRef.current = currentQueryParams;
  }, [currentQueryParams]);
  useEffect(() => {
    selectedReviewIdsRef.current = selectedReviewIds;
  }, [selectedReviewIds]);

  const ingestPayload = useCallback((raw: ReviewSummaryPageView | ReviewView[], requestedParams: HistoryQueryParams) => {
    if (Array.isArray(raw)) {
      const summaries = raw.map(toReviewSummary);
      isLegacyModeRef.current = true;
      setLegacySummaries(summaries);
      setLoadedQueryKey(buildSummaryUrl(requestedParams));
      setKnownItemsById((previous) => {
        const next = new Map(previous);
        summaries.forEach((item) => next.set(item.id, item));
        return next;
      });
      return;
    }
    isLegacyModeRef.current = false;
    setLegacySummaries(null);
    setServerPage(raw);
    const effectiveParams: HistoryQueryParams = { ...requestedParams, page: raw.page };
    latestQueryParamsRef.current = effectiveParams;
    if (raw.page !== requestedParams.page) {
      setPage(raw.page);
    }
    setLoadedQueryKey(buildSummaryUrl(effectiveParams));
    setKnownItemsById((previous) => {
      const next = new Map(previous);
      const pageIds = new Set<string>();
      raw.items.forEach((item) => {
        pageIds.add(item.id);
        next.set(item.id, item);
      });
      if ((raw.summaryBackfillPending ?? 0) === 0) {
        const exportableSet = new Set(raw.exportableReviewedIds);
        for (const [id, prev] of next.entries()) {
          if (pageIds.has(id)) continue;
          if (exportableSet.has(id)) {
            next.set(id, {
              ...prev,
              status: prev.status === "exported" || prev.status === "rejected" ? "ready_for_review" : prev.status,
              teacherReviewedAt: prev.teacherReviewedAt ?? prev.updatedAt ?? prev.createdAt,
              exportEligibility: { eligible: true },
              summarySyncPending: undefined,
            });
          } else if (
            prev.exportEligibility.eligible
            && prev.status !== "exported"
            && raw.stats.exported === 0
            && (requestedParams.classFilter === null || (prev.className ?? "") === requestedParams.classFilter)
            && (requestedParams.titleFilter === null || (prev.config.title ?? "") === requestedParams.titleFilter)
          ) {
            next.set(id, {
              ...prev,
              exportEligibility: {
                eligible: false,
                reason: "当前作文导出资格已变更，请重新核对",
              },
            });
          }
        }
      }
      return next;
    });
  }, []);

  // 始终按调用时刻的最新筛选与页码刷新，绝不使用旧闭包覆盖用户刚刚切换的新班级/新筛选
  const refreshLatest = useCallback(async () => {
    fetchControllerRef.current?.abort();
    const controller = new AbortController();
    fetchControllerRef.current = controller;
    const seq = ++requestSeqRef.current;
    const targetParams = latestQueryParamsRef.current;
    const url = buildSummaryUrl(targetParams);
    setLoading(true);
    setQueryError("");
    try {
      const raw = await apiFetch<ReviewSummaryPageView | ReviewView[]>(url, { signal: controller.signal });
      if (!mountedRef.current || seq !== requestSeqRef.current) return;
      ingestPayload(raw, targetParams);
    } catch (caught) {
      if (!mountedRef.current || seq !== requestSeqRef.current || (caught instanceof DOMException && caught.name === "AbortError")) return;
      setQueryError(errorMessage(caught));
    } finally {
      if (mountedRef.current && seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [ingestPayload]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      fetchControllerRef.current?.abort();
      regradeControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (isLegacyModeRef.current) return;
    let active = true;
    fetchControllerRef.current?.abort();
    const controller = new AbortController();
    fetchControllerRef.current = controller;
    const seq = ++requestSeqRef.current;
    const queryParams = currentQueryParams;
    const url = buildSummaryUrl(queryParams);
    setLoading(true);
    setQueryError("");
    void apiFetch<ReviewSummaryPageView | ReviewView[]>(url, { signal: controller.signal })
      .then((raw) => {
        if (!active || seq !== requestSeqRef.current) return;
        ingestPayload(raw, queryParams);
      })
      .catch((caught) => {
        if (!active || seq !== requestSeqRef.current || (caught instanceof DOMException && caught.name === "AbortError")) return;
        setQueryError(errorMessage(caught));
      })
      .finally(() => {
        if (active && seq === requestSeqRef.current) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [currentQueryParams, ingestPayload]);

  const summaryPage = useMemo(() => (
    legacySummaries !== null
      ? computePageFromSummaries(legacySummaries, currentQueryParams, legacyRosters)
      : serverPage
  ), [currentQueryParams, legacyRosters, legacySummaries, serverPage]);

  // 严格校验当前已加载数据是否与当前筛选框/页码精确对齐：仅在查询未就绪或查询本身报错时收起列表，旧异步操作失败（actionError）不影响已就绪的新班级
  const isQuerySettled = legacySummaries !== null || (!loading && !queryError && loadedQueryKey === currentQueryKey);
  const visibleReviews = useMemo(
    () => (isQuerySettled ? summaryPage.items : []),
    [isQuerySettled, summaryPage.items],
  );

  const analyzingIds = useMemo(
    () => (legacySummaries ?? visibleReviews).filter(({ status }) => status === "analyzing").map(({ id }) => id),
    [legacySummaries, visibleReviews],
  );
  const hasAnalyzingReviews = analyzingIds.length > 0;
  const analyzingIdsRef = useRef<string[]>(analyzingIds);
  useEffect(() => {
    analyzingIdsRef.current = analyzingIds;
  }, [analyzingIds]);

  useEffect(() => {
    if (!hasAnalyzingReviews || failedRegrade?.running) return;
    let inFlight = false;
    const poll = () => {
      if (inFlight || document.visibilityState === "hidden") return;
      const ids = analyzingIdsRef.current;
      if (ids.length === 0) return;
      inFlight = true;
      if (ids.length > 50) {
        void refreshLatest().finally(() => { inFlight = false; });
        return;
      }
      const endpoint = `/api/reviews?ids=${ids.map((id) => encodeURIComponent(id)).join(",")}`;
      void apiFetch<Array<ReviewView | ReviewSummaryView>>(endpoint)
        .then(async (loaded) => {
          if (!mountedRef.current) return;
          const byId = new Map(loaded.map((item) => [
            item.id,
            "hasReport" in item ? item : toReviewSummary(item),
          ]));
          setKnownItemsById((previous) => {
            const next = new Map(previous);
            byId.forEach((value, key) => next.set(key, value));
            return next;
          });
          if (isLegacyModeRef.current) {
            setLegacySummaries((current) => (current ? current.map((item) => byId.get(item.id) ?? item) : current));
            return;
          }
          const anyTransitioned = [...byId.values()].some((updated) => updated.status !== "analyzing");
          if (anyTransitioned) {
            // 一旦状态脱离 analyzing（如进入 ready_for_review 或 failed），重取当前查询摘要以同步筛选归属、失败清单与统计
            await refreshLatest();
          }
        })
        .catch(() => undefined)
        .finally(() => { inFlight = false; });
    };
    const timer = window.setInterval(poll, ANALYZING_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [failedRegrade?.running, hasAnalyzingReviews, refreshLatest]);

  const stats = summaryPage.stats;
  const totalCount = stats.total;
  const backfillPendingCount = isQuerySettled ? (summaryPage.summaryBackfillPending ?? 0) : 0;
  const exportableReviewedIds = isQuerySettled && backfillPendingCount === 0 ? summaryPage.exportableReviewedIds : [];
  const failedInView = isQuerySettled ? summaryPage.matchingFailed : [];
  const totalPages = Math.max(1, Math.ceil(summaryPage.totalFiltered / summaryPage.pageSize));

  const selectedVisibleCount = visibleReviews.filter(({ id }) => selectedReviewIds.has(id)).length;
  const hiddenSelectedCount = selectedReviewIds.size - selectedVisibleCount;
  const allVisibleSelected = isQuerySettled && visibleReviews.length > 0 && selectedVisibleCount === visibleReviews.length;
  const selectedExportableIds = useMemo(
    () => [...selectedReviewIds].filter((id) => {
      const known = knownItemsById.get(id);
      return Boolean(known && exportEligibility(known).eligible);
    }),
    [knownItemsById, selectedReviewIds],
  );
  const reanalysisBusy = reanalysisLoading || reanalysisSubmitting || failedRegrade?.running === true;

  function changeClassFilter(nextClass: string | null) {
    latestQueryParamsRef.current = { ...latestQueryParamsRef.current, page: 1, classFilter: nextClass };
    setPage(1);
    setClassFilter(nextClass);
  }

  function changeTitleFilter(nextTitle: string | null) {
    latestQueryParamsRef.current = { ...latestQueryParamsRef.current, page: 1, titleFilter: nextTitle };
    setPage(1);
    setTitleFilter(nextTitle);
  }

  function openRosterDialog(preferredClass?: string) {
    const candidate = preferredClass !== undefined
      ? preferredClass
      : (classFilter && classFilter.length > 0 ? classFilter : (summaryPage.classes[0] ?? ""));
    setRosterDialogSession((prev) => ({
      key: (prev?.key ?? 0) + 1,
      initialClassName: candidate,
    }));
  }

  async function saveClassRoster(payload: RosterSavePayload) {
    const updated = await apiFetch<ClassRosterView[]>("/api/class-rosters", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    setLegacyRosters(updated);
    if (!isLegacyModeRef.current) {
      setServerPage((prev) => ({
        ...prev,
        rosters: updated,
        classes: [...new Set([...prev.classes, ...updated.map((item) => item.className)].filter(Boolean))]
          .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true })),
      }));
      await refreshLatest();
    }
  }

  async function deleteClassRoster(targetClassName: string) {
    await apiFetch(`/api/class-rosters?class=${encodeURIComponent(targetClassName)}`, {
      method: "DELETE",
    });
    setLegacyRosters((prev) => prev.filter((item) => item.className !== targetClassName));
    if (!isLegacyModeRef.current) {
      setServerPage((prev) => ({
        ...prev,
        rosters: (prev.rosters ?? []).filter((item) => item.className !== targetClassName),
      }));
      await refreshLatest();
    }
  }

  function changeStudentSearch(nextQuery: string) {
    latestQueryParamsRef.current = { ...latestQueryParamsRef.current, page: 1, studentSearch: nextQuery };
    setPage(1);
    setStudentSearch(nextQuery);
  }

  function changeStatusFilter(nextStatus: HistoryStatusFilter) {
    latestQueryParamsRef.current = { ...latestQueryParamsRef.current, page: 1, statusFilter: nextStatus };
    setPage(1);
    setStatusFilter(nextStatus);
  }

  function changePage(nextPage: number) {
    const safeNext = Math.max(1, nextPage);
    latestQueryParamsRef.current = { ...latestQueryParamsRef.current, page: safeNext };
    setPage(safeNext);
  }

  async function remove(review: ReviewSummaryView) {
    if (!window.confirm(`确认永久删除《${review.config.title}》？删除后不可恢复。`)) return;
    setDeleting(review.id);
    setActionError("");
    try {
      await apiFetch(`/api/reviews/${encodeURIComponent(review.id)}`, { method: "DELETE" });
      setKnownItemsById((previous) => {
        const next = new Map(previous);
        next.delete(review.id);
        return next;
      });
      setSelectedReviewIds((current) => {
        const next = new Set(current);
        next.delete(review.id);
        selectedReviewIdsRef.current = next;
        return next;
      });
      if (isLegacyModeRef.current) {
        setLegacySummaries((current) => (current ? current.filter(({ id }) => id !== review.id) : current));
      } else {
        // 服务端模式删除后重取当前查询，自动采纳服务端校正后的页码（如删完第 2 页最后 1 篇自动回退第 1 页），并保留其余跨页选择
        await refreshLatest();
      }
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setDeleting(null);
    }
  }

  async function exportReview(review: ReviewSummaryView, format: ExportFormat) {
    if (exporting || batchExporting) return;
    setExporting(review.id);
    setActionError("");
    try {
      await downloadReview(review.id, format);
      await refreshLatest();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setExporting(null);
    }
  }

  async function downloadLegacyPdf(review: ReviewSummaryView) {
    if (exporting || batchExporting) return;
    setExporting(review.id);
    setActionError("");
    try {
      await downloadLegacyCachedPdf(review);
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setExporting(null);
    }
  }

  function toggleReviewSelection(reviewId: string) {
    if (batchExporting || exporting !== null || reanalysisBusy) return;
    setSelectedReviewIds((current) => {
      const next = new Set(current);
      if (next.has(reviewId)) next.delete(reviewId);
      else next.add(reviewId);
      selectedReviewIdsRef.current = next;
      return next;
    });
  }

  function toggleAllReviews() {
    if (!isQuerySettled || visibleReviews.length === 0 || batchExporting || exporting !== null || reanalysisBusy) return;
    setSelectedReviewIds((current) => {
      const next = new Set(current);
      if (visibleReviews.every(({ id }) => next.has(id))) {
        visibleReviews.forEach(({ id }) => next.delete(id));
      } else {
        visibleReviews.forEach(({ id }) => next.add(id));
      }
      selectedReviewIdsRef.current = next;
      return next;
    });
  }

  async function exportSelected(format: ExportFormat) {
    if (!isQuerySettled || selectedExportableIds.length === 0 || batchExporting || exporting || reanalysisBusy) return;
    setBatchExporting(true);
    setActionError("");
    try {
      let targetIds: string[] = [];
      if (isLegacyModeRef.current) {
        targetIds = selectedExportableIds;
      } else {
        const selectedIds = [...selectedReviewIdsRef.current];
        const snapshotParams = latestQueryParamsRef.current;
        fetchControllerRef.current?.abort();
        const seq = ++requestSeqRef.current;
        setLoading(false);
        const freshRaw = await apiFetch<ReviewSummaryPageView | ReviewView[]>(buildSummaryUrl(snapshotParams));
        if (Array.isArray(freshRaw)) {
          throw new Error("历史分页摘要响应格式异常，已停止导出以免使用旧集合");
        }
        if (!mountedRef.current || seq !== requestSeqRef.current || buildSummaryUrl(latestQueryParamsRef.current) !== buildSummaryUrl(snapshotParams)) {
          if (mountedRef.current) {
            setActionError("列表或筛选状态已更新，已取消过期导出，请按最新结果重新操作");
          }
          return;
        }
        ingestPayload(freshRaw, snapshotParams);
        const freshItemMap = new Map(freshRaw.items.map((item) => [item.id, item]));
        const freshExportableSet = (freshRaw.summaryBackfillPending ?? 0) === 0
          ? new Set(freshRaw.exportableReviewedIds)
          : new Set<string>();
        const unresolvedIds = selectedIds.filter((id) => !freshItemMap.has(id) && !freshExportableSet.has(id));
        const extraEligibleSet = new Set<string>();
        if (unresolvedIds.length > 0) {
          for (const chunk of chunkItems(unresolvedIds)) {
            const idQuery = `/api/reviews?summary=1&ids=${chunk.map((id) => encodeURIComponent(id)).join(",")}`;
            const loaded = await apiFetch<Array<ReviewSummaryView | ReviewView> | ReviewSummaryPageView>(idQuery);
            if (!mountedRef.current || seq !== requestSeqRef.current || buildSummaryUrl(latestQueryParamsRef.current) !== buildSummaryUrl(snapshotParams)) {
              if (mountedRef.current) {
                setActionError("列表或筛选状态已更新，已取消过期导出，请按最新结果重新操作");
              }
              return;
            }
            if (Array.isArray(loaded)) {
              const normalized = loaded.map((entry) => ("hasReport" in entry ? entry : toReviewSummary(entry)));
              setKnownItemsById((previous) => {
                const next = new Map(previous);
                normalized.forEach((item) => next.set(item.id, item));
                return next;
              });
              normalized.forEach((item) => {
                if (exportEligibility(item).eligible) extraEligibleSet.add(item.id);
              });
            } else if ((loaded.summaryBackfillPending ?? 0) === 0) {
              loaded.items.forEach((item) => {
                if (exportEligibility(item).eligible) extraEligibleSet.add(item.id);
              });
              loaded.exportableReviewedIds.forEach((id) => extraEligibleSet.add(id));
            }
          }
        }
        targetIds = selectedIds.filter((id) => {
          const onPage = freshItemMap.get(id);
          if (onPage) return exportEligibility(onPage).eligible;
          if (freshExportableSet.has(id)) return true;
          return extraEligibleSet.has(id);
        });
      }
      targetIds = intersectLiveSelectedExportTargets(targetIds, selectedReviewIdsRef.current);
      if (targetIds.length === 0) {
        setActionError("所选记录当前已无可导出的新格式作文");
        return;
      }
      await downloadReviewArchive(targetIds, format);
      await refreshLatest();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBatchExporting(false);
    }
  }

  async function exportReviewed(format: ExportFormat) {
    if (!isQuerySettled || exportableReviewedIds.length === 0 || batchExporting || exporting || reanalysisBusy) return;
    setBatchExporting(true);
    setActionError("");
    try {
      let targetIds: string[] = [];
      if (isLegacyModeRef.current) {
        targetIds = exportableReviewedIds;
      } else {
        // 服务端分页模式下，一键导出前实时重取当前筛选下的最新可导出 ID 集合；重取期间若列表/筛选已变更或响应异常，立即中止导出（归档调用 0 次）
        const snapshotParams = latestQueryParamsRef.current;
        fetchControllerRef.current?.abort();
        const seq = ++requestSeqRef.current;
        setLoading(false);
        const freshRaw = await apiFetch<ReviewSummaryPageView | ReviewView[]>(buildSummaryUrl(snapshotParams));
        if (Array.isArray(freshRaw)) {
          throw new Error("历史分页摘要响应格式异常，已停止导出以免使用旧集合");
        }
        if (!mountedRef.current || seq !== requestSeqRef.current || buildSummaryUrl(latestQueryParamsRef.current) !== buildSummaryUrl(snapshotParams)) {
          if (mountedRef.current) {
            setActionError("列表或筛选状态已更新，已取消过期导出，请按最新结果重新操作");
          }
          return;
        }
        ingestPayload(freshRaw, snapshotParams);
        if ((freshRaw.summaryBackfillPending ?? 0) > 0) {
          setActionError(`尚有 ${freshRaw.summaryBackfillPending} 篇历史记录正在同步导出资格，请刷新完成后再一键导出`);
          return;
        }
        targetIds = freshRaw.exportableReviewedIds;
      }
      if (targetIds.length === 0) {
        setActionError("当前筛选下没有可导出的已复核作文");
        return;
      }
      await downloadReviewArchive(targetIds, format);
      await refreshLatest();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBatchExporting(false);
    }
  }

  async function openBatchReanalysis() {
    if (!isQuerySettled || selectedReviewIds.size === 0 || selectedReviewIds.size > BATCH_REANALYSIS_LIMIT || reanalysisBusy || batchExporting || exporting) return;
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

  async function submitBatchReanalysis(items: BatchReanalysisCommitItem[], options: { applyCurrentFramework: boolean }) {
    if (reanalysisSubmitting || items.length === 0) return;
    setReanalysisSubmitting(true);
    setReanalysisError("");
    try {
      const result = await apiFetch<BatchReanalysisCommitResult>("/api/reviews/batch-reanalysis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items, applyCurrentFramework: options.applyCurrentFramework }),
      });
      setReanalysisResult(result);
      setSelectedReviewIds((current) => {
        const next = new Set(current);
        result.submitted.forEach(({ reviewId }) => next.delete(reviewId));
        selectedReviewIdsRef.current = next;
        return next;
      });
      await refreshLatest();
    } catch (caught) {
      setReanalysisError(errorMessage(caught));
    } finally {
      setReanalysisSubmitting(false);
    }
  }

  async function regradeFailed() {
    if (!isQuerySettled || failedInView.length === 0 || reanalysisBusy || batchExporting || exporting) return;
    const ids = failedInView.map(({ id }) => id);
    const names = new Map(failedInView.map((item) => [item.id, item.studentName || "未填写"]));
    const chunks = chunkItems(ids);
    const skipped: BatchReanalysisPreview["skipped"] = [];
    const failures: Array<{ reviewId: string; studentName: string; summary: string }> = [];
    const submittedJobs: Array<{ reviewId: string; jobId: string }> = [];
    let submitted = 0;
    let completed = 0;
    regradeControllerRef.current?.abort();
    const regradeController = new AbortController();
    regradeControllerRef.current = regradeController;
    setFailedRegrade({ running: true, completed: 0, total: ids.length, submitted: 0, skipped: [], failures: [], error: "" });
    setActionError("");
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
            selectedReviewIdsRef.current = next;
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
          while (nextPollIndex < submittedJobs.length && !regradeController.signal.aborted) {
            const index = nextPollIndex;
            nextPollIndex += 1;
            const item = submittedJobs[index]!;
            pollOutcomes[index] = await pollRegradeJob(item.reviewId, item.jobId, regradeController.signal);
          }
        }),
      );
      if (!mountedRef.current || regradeController.signal.aborted) return;
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
      await refreshLatest();
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
      if (!mountedRef.current || regradeController.signal.aborted) return;
      setFailedRegrade({
        running: false,
        completed,
        total: ids.length,
        submitted,
        skipped,
        failures,
        error: errorMessage(caught),
      });
    } finally {
      if (regradeControllerRef.current === regradeController) {
        regradeControllerRef.current = null;
      }
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
            <div className="section-heading-meta">
              <span className="count-pill">共 {totalCount} 篇</span>
              <span className="muted">长期保留，可手动永久删除</span>
            </div>
          </div>
          <div className="history-toolbar">
            <div className="history-tools">
              <div className="history-filters">
                <ClassFilter options={summaryPage.classes} value={classFilter} onChange={changeClassFilter} />
                <TitleFilter options={summaryPage.titles ?? []} value={titleFilter} onChange={changeTitleFilter} />
                <label className="history-search">搜索学生姓名<input type="search" aria-label="搜索学生姓名" placeholder="输入姓名筛选…" value={studentSearch} onChange={(event) => changeStudentSearch(event.target.value)} /></label>
                <label className="history-search history-status-filter">批改状态
                  <select aria-label="筛选批改状态" value={statusFilter} onChange={(event) => changeStatusFilter(event.target.value as HistoryStatusFilter)}>
                    <option value="">全部</option>
                    <option value="draft">草稿</option>
                    <option value="review">待复核</option>
                    <option value="failed">审核失败</option>
                    <option value="reviewed">已复核</option>
                    <option value="exported">已导出</option>
                    <option value="rejected">审核不通过</option>
                  </select>
                </label>
              </div>
              <div className="history-tool-actions">
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => openRosterDialog()}
                >
                  {(summaryPage.rosters?.length ?? 0) > 0 ? `班级名单（${summaryPage.rosters!.length}班）` : "班级名单"}
                </button>
                <Link className="button button--primary" href="/reviews/batch">开始批量审核</Link>
              </div>
            </div>
            {totalCount > 0 || selectedReviewIds.size > 0 ? (
              <div className="history-batch-actions">
                <div className="history-selection-summary">
                  <label><input type="checkbox" checked={allVisibleSelected} disabled={!isQuerySettled || visibleReviews.length === 0 || batchExporting || exporting !== null || reanalysisBusy} onChange={toggleAllReviews} /> 全选当前结果</label>
                  <span className="selection-count-badge">已选择 {selectedReviewIds.size} 篇</span>
                  {hiddenSelectedCount > 0 ? <span className="muted">其中 {hiddenSelectedCount} 篇未显示</span> : null}
                </div>
                <div className="history-batch-commands">
                  <div className="history-export-command"><span>一键导出已复核（{exportableReviewedIds.length}）</span><ExportMenu ariaLabel="导出全部已复核" disabled={!isQuerySettled || backfillPendingCount > 0 || exportableReviewedIds.length === 0 || batchExporting || exporting !== null || reanalysisBusy} disabledReason={backfillPendingCount > 0 ? `尚有 ${backfillPendingCount} 篇历史记录正在同步导出资格，请刷新完成后再一键导出` : undefined} busy={batchExporting} busyLabel="正在打包…" onExport={exportReviewed} /></div>
                  <div className="history-export-command"><span>导出所选（{selectedExportableIds.length}）</span><ExportMenu ariaLabel="导出所选记录" disabled={!isQuerySettled || selectedExportableIds.length === 0 || batchExporting || exporting !== null || reanalysisBusy} disabledReason={selectedReviewIds.size > 0 && selectedExportableIds.length === 0 ? "所选记录没有可导出的新格式" : undefined} busy={batchExporting} busyLabel="正在打包…" onExport={exportSelected} /></div>
                  <button className="button button--quiet" type="button" disabled={!isQuerySettled || selectedReviewIds.size === 0 || selectedReviewIds.size > BATCH_REANALYSIS_LIMIT || batchExporting || exporting !== null || reanalysisBusy} onClick={() => void openBatchReanalysis()}>
                    {reanalysisLoading ? "正在预览…" : "按最新框架重新分析"}
                  </button>
                  <button className="button button--quiet" type="button" disabled={!isQuerySettled || failedInView.length === 0 || batchExporting || exporting !== null || reanalysisBusy} onClick={() => void regradeFailed()}>
                    {failedRegrade?.running ? "正在重新批改…" : `一键重新批改失败作文（${failedInView.length}）`}
                  </button>
                </div>
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
          </div>
          <MissingSubmissionPanel
            classFilter={classFilter}
            titleFilter={titleFilter}
            titles={summaryPage.titles ?? []}
            rosters={summaryPage.rosters ?? []}
            titleSubmissions={summaryPage.titleSubmissions ?? []}
            titleSubmissionsTruncated={summaryPage.titleSubmissionsTruncated}
            isQuerySettled={isQuerySettled}
            onSelectClass={changeClassFilter}
            onSelectTitle={changeTitleFilter}
            onOpenRosterDialog={openRosterDialog}
          />
          {queryError ? <ErrorBanner message={queryError} onRetry={refreshLatest} /> : null}
          {actionError ? <ErrorBanner message={actionError} /> : null}
          {loading ? <p className="loading-note" role="status">正在翻阅批改记录…</p> : null}
          {!loading && !queryError && totalCount === 0 ? (
            <div className="empty-state">
              <span className="empty-seal" aria-hidden="true">空</span>
              <h3>还没有作文批改记录</h3>
              <p>从一篇作文开始，批注与报告会整齐保存在这里。</p>
              <Link className="button button--primary" href="/new">新建作文批改</Link>
            </div>
          ) : null}
          <div className="history-list">
            {isQuerySettled && totalCount > 0 && visibleReviews.length === 0 ? <p className="muted history-empty-filter">没有找到该学生的作文</p> : null}
            {visibleReviews.map((review) => (
              <article className={`history-card ${selectedReviewIds.has(review.id) ? "history-card--selected" : ""}`} key={review.id}>
                <label className="history-select"><input type="checkbox" aria-label={`选择《${review.config.title}》`} checked={selectedReviewIds.has(review.id)} disabled={batchExporting || exporting !== null || reanalysisBusy} onChange={() => toggleReviewSelection(review.id)} /></label>
                <div className="history-main">
                  <div className="history-meta">
                    <StatusBadge status={reviewDisplayStatus(review)} />
                    <span className="meta-chip">学生：{review.studentName || "未填写"}</span>
                    <span className="meta-chip">班级：{review.className || "未分类"}</span>
                    <time>{reviewDate(review.updatedAt ?? review.createdAt)}</time>
                  </div>
                  <div className="history-title-row">
                    <h3><Link href={`/reviews?id=${encodeURIComponent(review.id)}`}>{review.config.title}</Link></h3>
                    <p className="history-grade-tag">{review.hasReport && review.grade ? `${review.grade}${review.grade === "C" ? " · 需要重写" : " · 已完成四维诊断"}` : "尚未生成等级评定"}</p>
                  </div>
                  {review.status === "failed" && review.analysisFailure ? <div className="history-failure-box">
                    <p>{review.analysisFailure.summary}</p>
                    {review.analysisFailure.detail ? <details><summary>查看原始信息</summary><p>{review.analysisFailure.detail}</p></details> : null}
                  </div> : null}
                </div>
                <div className="card-actions">
                  <Link className="button button--quiet" href={`/reviews?id=${encodeURIComponent(review.id)}`}>进入复核</Link>
                  {review.hasReport && review.isLegacyReport ? review.hasPdf && review.pdfFilename?.trim() ? <button className="button button--quiet" type="button" disabled={exporting !== null || batchExporting} onClick={() => void downloadLegacyPdf(review)}>{exporting === review.id ? "正在下载…" : "下载已生成的旧版 PDF"}</button> : <Link className="button button--quiet" href={`/reviews?id=${encodeURIComponent(review.id)}`}>完整重新分析</Link> : (() => { const eligibility = exportEligibility(review); return <ExportMenu ariaLabel={`导出《${review.config.title}》`} disabled={!eligibility.eligible || exporting !== null || batchExporting} disabledReason={!eligibility.eligible ? eligibility.reason : undefined} busy={exporting === review.id} onExport={(format) => exportReview(review, format)} />; })()}
                  {review.hasReport && review.isLegacyReport ? <span className="export-menu-reason">旧版示范段落报告需要完整重新分析后才能导出新格式</span> : null}
                  <button className="button button--danger-quiet" type="button" disabled={deleting === review.id || batchExporting || reanalysisBusy} onClick={() => void remove(review)} aria-label={`删除《${review.config.title}》`}>
                    {deleting === review.id ? "删除中…" : "删除"}
                  </button>
                </div>
              </article>
            ))}
          </div>
          {isQuerySettled && summaryPage.totalFiltered > summaryPage.pageSize ? (
            <nav className="history-pagination form-actions" aria-label="批改历史分页">
              <button
                type="button"
                className="button button--quiet"
                disabled={loading || summaryPage.page <= 1}
                onClick={() => changePage(summaryPage.page - 1)}
              >
                上一页
              </button>
              <span className="muted">
                第 {summaryPage.page} / {totalPages} 页（当前筛选共 {summaryPage.totalFiltered} 篇）
              </span>
              <button
                type="button"
                className="button button--quiet"
                disabled={loading || summaryPage.page >= totalPages}
                onClick={() => changePage(summaryPage.page + 1)}
              >
                下一页
              </button>
            </nav>
          ) : null}
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
        onConfirm={(items, options) => { void submitBatchReanalysis(items, options); }}
      />
      {rosterDialogSession ? (
        <ClassRosterDialog
          key={rosterDialogSession.key}
          open
          initialClassName={rosterDialogSession.initialClassName}
          knownClasses={summaryPage.classes}
          rosters={summaryPage.rosters ?? []}
          onClose={() => setRosterDialogSession(null)}
          onSave={saveClassRoster}
          onDelete={deleteClassRoster}
        />
      ) : null}
    </div>
  );
}
