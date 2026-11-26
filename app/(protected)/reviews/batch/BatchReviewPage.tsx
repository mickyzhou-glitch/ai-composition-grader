"use client";

/* eslint-disable @next/next/no-img-element -- Protected review images use runtime API URLs. */

import { syncEssayBeforeApproval } from "@/src/domain/essay-paragraph-sync";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  expectedSampleParagraphCount,
  isLegacyEvaluationReport,
  type EvaluationReport,
  type ParagraphEvaluationReport,
} from "@/src/domain/contracts";
import { deliveryReadiness } from "@/src/delivery/readiness";
import { ClassFilter } from "../../../components/ClassFilter";
import { filterReviewsByClass } from "../../../lib/classification";
import { AppHeader } from "../../../components/AppHeader";
import { BatchReviewReportEditor } from "../../../components/BatchReviewReportEditor";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { ExportMenu } from "../../../components/ExportMenu";
import { usePendingRules } from "../../../components/PendingRulesContext";
import { RevisionRequestDialog } from "../../../components/RevisionRequestDialog";
import { ReviewExportList } from "../../../components/ReviewExportList";
import { apiFetch, errorMessage } from "../../../lib/api";
import { downloadReviewArchive, type ExportFormat } from "../../../lib/review-export";
import { exportEligibility, filterReviewsByStudentName, isReviewedPendingExport, reviewPrefetchWindow, toReviewSummary } from "../../../lib/review-queue";
import type { PublicAnalysisJobView, ReviewSummaryView, RevisionRequestResult, ReviewView } from "../../../lib/types";

export interface ReviewQueueItemView {
  id: string;
  studentName: string;
  className?: string;
  title: string;
  status: ReviewView["status"];
  revision: number;
  createdAt: string;
}

function cacheKey(id: string, revision: number) {
  return `${id}:${revision}`;
}

function isParagraphReportDraft(
  report: EvaluationReport,
): report is ParagraphEvaluationReport {
  return "paragraphReviews" in report && Array.isArray(report.paragraphReviews);
}

interface RevisionJobTracker {
  reviewId: string;
  jobId: string;
}

function filterVisibleQueue(
  items: ReviewQueueItemView[],
  classFilter: string | null,
  search: string,
): ReviewQueueItemView[] {
  return filterReviewsByStudentName(filterReviewsByClass(items, classFilter), search);
}

function normalizePendingExportItems(items: Array<ReviewSummaryView | ReviewView>): Array<ReviewSummaryView | ReviewView> {
  return items
    .map((item) => ("hasReport" in item ? item : toReviewSummary(item)))
    .filter((item) => isReviewedPendingExport(item));
}

export function BatchReviewPage() {
  const pendingRules = usePendingRules();
  const [queue, setQueue] = useState<ReviewQueueItemView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [returningItem, setReturningItem] = useState<ReviewQueueItemView | null>(null);
  const [review, setReview] = useState<ReviewView | null>(null);
  const [reviewed, setReviewed] = useState<Array<ReviewSummaryView | ReviewView>>([]);
  const [selectedExportIds, setSelectedExportIds] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [view, setView] = useState<"review" | "export">("review");
  const [loading, setLoading] = useState(true);
  const [failedDetailKey, setFailedDetailKey] = useState<string | null>(null);
  const [detailRetryNonce, setDetailRetryNonce] = useState(0);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportListLoading, setExportListLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [revisionDialogOpen, setRevisionDialogOpen] = useState(false);
  const [standingRules, setStandingRules] = useState<string[]>([]);
  const [essayRules, setEssayRules] = useState<string[]>([]);
  const [standingRulesLoading, setStandingRulesLoading] = useState(false);
  const [standingRulesError, setStandingRulesError] = useState("");
  const [revisionSubmitting, setRevisionSubmitting] = useState(false);
  const [revisionError, setRevisionError] = useState("");
  const [revisionNotice, setRevisionNotice] = useState("");
  const [revisionJobs, setRevisionJobs] = useState<RevisionJobTracker[]>([]);
  const cacheRef = useRef(new Map<string, ReviewView>());
  const requestsRef = useRef(new Map<string, { controller: AbortController; promise: Promise<ReviewView> }>());
  const revisionButtonRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  const detailRequestSeqRef = useRef(0);
  const pendingExportSeqRef = useRef(0);
  const consumedForceNonceRef = useRef(0);
  const queueRef = useRef<ReviewQueueItemView[]>(queue);
  const activeIdRef = useRef<string | null>(activeId);
  const reviewRef = useRef<ReviewView | null>(review);
  const classFilterRef = useRef<string | null>(classFilter);
  const searchRef = useRef<string>(search);
  const returningItemRef = useRef<ReviewQueueItemView | null>(returningItem);
  const selectedExportIdsRef = useRef<Set<string>>(selectedExportIds);

  const visibleQueue = useMemo(() => filterVisibleQueue(queue, classFilter, search), [queue, search, classFilter]);
  const visibleQueueRef = useRef<ReviewQueueItemView[]>(visibleQueue);
  useEffect(() => {
    queueRef.current = queue;
    activeIdRef.current = activeId;
    reviewRef.current = review;
    classFilterRef.current = classFilter;
    searchRef.current = search;
    returningItemRef.current = returningItem;
    selectedExportIdsRef.current = selectedExportIds;
    visibleQueueRef.current = visibleQueue;
  }, [activeId, classFilter, queue, returningItem, review, search, selectedExportIds, visibleQueue]);

  // 严格门禁：队列项必须命中当前班级与姓名筛选（visibleQueue），或来自当前班级下显式点击「返回修改」的已审核记录，绝不允许筛选外学生成为当前审核对象
  const visibleActiveQueueItem = useMemo(
    () => visibleQueue.find(({ id }) => id === activeId) ?? null,
    [visibleQueue, activeId],
  );
  const activeReturningItem = useMemo(() => {
    if (!returningItem || returningItem.id !== activeId) return null;
    if (filterReviewsByClass([returningItem], classFilter).length === 0) return null;
    return returningItem;
  }, [returningItem, activeId, classFilter]);
  const activeItem = visibleActiveQueueItem ?? activeReturningItem;
  const isReturningEdit = Boolean(activeReturningItem && !visibleActiveQueueItem);

  const currentReview = useMemo(() => {
    if (!review || !activeId || !activeItem) return null;
    if (review.id !== activeId || review.id !== activeItem.id) return null;
    if (review.revision !== activeItem.revision) return null;
    // 二次核验已加载详情自身的班级（及队列搜索名）仍符合当前筛选，防止跨标签页转班后通过旧摘要继续提交
    if (filterReviewsByClass([{ className: review.className ?? "" }], classFilter).length === 0) return null;
    if (!isReturningEdit && filterReviewsByStudentName([{ studentName: review.studentName ?? "" }], search).length === 0) return null;
    return review;
  }, [review, activeId, activeItem, classFilter, isReturningEdit, search]);
  const activeCacheKey = activeItem ? cacheKey(activeItem.id, activeItem.revision) : null;
  const detailLoading = Boolean(activeItem && !currentReview && failedDetailKey !== activeCacheKey);

  const filteredReviewed = useMemo(
    () => filterReviewsByClass(reviewed, classFilter),
    [reviewed, classFilter],
  );
  const pendingExportSyncing = useMemo(
    () => filteredReviewed.some((item) => "summarySyncPending" in item && Boolean(item.summarySyncPending)),
    [filteredReviewed],
  );
  const exportableReviewed = useMemo(
    () => filteredReviewed.filter((item) => exportEligibility(item).eligible),
    [filteredReviewed],
  );
  const selectedExportable = useMemo(
    () => exportableReviewed.filter(({ id }) => selectedExportIds.has(id)),
    [exportableReviewed, selectedExportIds],
  );
  const sampleParagraphCountMismatch = Boolean(
    currentReview?.report &&
    isLegacyEvaluationReport(currentReview.report) &&
    currentReview.report.sampleParagraphs.length !== expectedSampleParagraphCount(currentReview.config),
  );
  const paragraphReadiness = useMemo(() => {
    if (!currentReview?.report || !isParagraphReportDraft(currentReview.report)) return null;
    return deliveryReadiness({
      ...currentReview,
      teacherReviewedAt: currentReview.teacherReviewedAt ?? "pending-teacher-review",
    });
  }, [currentReview]);

  const loadDetail = useCallback((item: ReviewQueueItemView, options?: { forceFresh?: boolean }): Promise<ReviewView> => {
    const requestedKey = cacheKey(item.id, item.revision);
    if (!options?.forceFresh) {
      const cached = cacheRef.current.get(requestedKey);
      if (cached) return Promise.resolve(cached);
      const pending = requestsRef.current.get(item.id);
      if (pending) return pending.promise;
    } else {
      for (const key of cacheRef.current.keys()) {
        if (key.startsWith(`${item.id}:`)) cacheRef.current.delete(key);
      }
      const existing = requestsRef.current.get(item.id);
      if (existing) {
        existing.controller.abort();
        requestsRef.current.delete(item.id);
      }
    }
    const controller = new AbortController();
    const promise = apiFetch<ReviewView>(`/api/reviews/${encodeURIComponent(item.id)}`, { signal: controller.signal })
      .then((loaded) => {
        if (controller.signal.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        // 严格按响应实际返回的 revision 写入缓存，避免跨标签页更新后把新版本绑到旧缓存键上
        cacheRef.current.set(cacheKey(loaded.id, loaded.revision), loaded);
        const firstImage = loaded.images[0];
        if (firstImage && typeof Image !== "undefined") {
          const image = new Image();
          image.src = `/api/reviews/${encodeURIComponent(loaded.id)}/files?imageId=${firstImage.id}&variant=annotation`;
        }
        return loaded;
      })
      .finally(() => {
        if (requestsRef.current.get(item.id)?.controller === controller) {
          requestsRef.current.delete(item.id);
        }
      });
    requestsRef.current.set(item.id, { controller, promise });
    return promise;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    const requests = requestsRef.current;
    const pendingSeq = ++pendingExportSeqRef.current;
    void Promise.all([
      apiFetch<ReviewQueueItemView[]>("/api/reviews/review-queue"),
      apiFetch<Array<ReviewSummaryView | ReviewView>>("/api/reviews?summary=1&scope=pending-export"),
    ])
      .then(([loadedQueue, loadedReviews]) => {
        if (!active) return;
        const initialVisible = filterVisibleQueue(loadedQueue, classFilterRef.current, searchRef.current);
        const initialId = initialVisible[0]?.id ?? null;
        queueRef.current = loadedQueue;
        activeIdRef.current = initialId;
        setQueue(loadedQueue);
        if (pendingSeq === pendingExportSeqRef.current) {
          setReviewed(normalizePendingExportItems(loadedReviews));
        }
        setActiveId(initialId);
      })
      .catch((caught) => { if (active) setError(errorMessage(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      mountedRef.current = false;
      active = false;
      requests.forEach(({ controller }) => controller.abort());
    };
  }, []);

  useEffect(() => {
    if (!activeItem) return;
    let active = true;
    const requestSeq = ++detailRequestSeqRef.current;
    const forceFresh = detailRetryNonce > 0 && consumedForceNonceRef.current !== detailRetryNonce;
    if (forceFresh) consumedForceNonceRef.current = detailRetryNonce;
    const current = activeItem;
    const currentIsReturning = isReturningEdit;
    const currentKey = cacheKey(current.id, current.revision);
    void loadDetail(current, { forceFresh }).then(async (loaded) => {
      if (!active || requestSeq !== detailRequestSeqRef.current || loaded.id !== current.id) return;
      setFailedDetailKey((previous) => (previous === currentKey ? null : previous));
      if (currentIsReturning) {
        const loadedMeta: ReviewQueueItemView = {
          id: loaded.id,
          studentName: loaded.studentName,
          className: loaded.className ?? "",
          title: loaded.config.title,
          status: loaded.status,
          revision: loaded.revision,
          createdAt: loaded.createdAt,
        };
        const stillMatchesClass = filterReviewsByClass([loadedMeta], classFilterRef.current).length > 0;
        const stillEditableReviewed = isReviewedPendingExport(loaded);
        if (!stillMatchesClass || !stillEditableReviewed) {
          // 另一标签页已将该生转入其他班级或变更导出/退回状态：立即退出返回修改、刷新双清单并回退到当前筛选可见队列
          try {
            const pendingSeq = ++pendingExportSeqRef.current;
            setExportListLoading(false);
            const [refreshedQueue, refreshedPending] = await Promise.all([
              apiFetch<ReviewQueueItemView[]>("/api/reviews/review-queue"),
              apiFetch<Array<ReviewSummaryView | ReviewView>>("/api/reviews?summary=1&scope=pending-export"),
            ]);
            if (!active) return;
            const refreshedVisible = filterVisibleQueue(refreshedQueue, classFilterRef.current, searchRef.current);
            const fallback = refreshedVisible[0] ?? null;
            const fallbackReview = fallback ? cacheRef.current.get(cacheKey(fallback.id, fallback.revision)) ?? null : null;
            queueRef.current = refreshedQueue;
            returningItemRef.current = null;
            activeIdRef.current = fallback?.id ?? null;
            reviewRef.current = fallbackReview;
            setQueue(refreshedQueue);
            if (pendingSeq === pendingExportSeqRef.current) {
              setReviewed(normalizePendingExportItems(refreshedPending));
            }
            setReturningItem(null);
            setActiveId(fallback?.id ?? null);
            setReview(fallbackReview);
            setDirty(false);
          } catch (caught) {
            if (active) {
              returningItemRef.current = null;
              activeIdRef.current = null;
              reviewRef.current = null;
              setReturningItem(null);
              setActiveId(null);
              setReview(null);
              setDirty(false);
              setError(errorMessage(caught));
            }
          }
          return;
        }
        // 仅当元数据字段实际变化时才更新 returningItem 引用，且同一 (id, revision) 只初始化一次草稿，绝不覆盖教师已输入内容
        setReturningItem((previous) => (
          previous
          && previous.id === loadedMeta.id
          && previous.revision === loadedMeta.revision
          && (previous.className ?? "") === (loadedMeta.className ?? "")
          && previous.studentName === loadedMeta.studentName
          && previous.title === loadedMeta.title
          && previous.status === loadedMeta.status
            ? previous
            : loadedMeta
        ));
        if (reviewRef.current?.id !== loaded.id || reviewRef.current?.revision !== loaded.revision) {
          reviewRef.current = loaded;
          setReview(loaded);
          setDirty(false);
        }
        return;
      }
      // 若另一标签页已更新该篇版本或审核状态，立即并发重取最新审核队列与待导出清单，并在「当前筛选可见队列」内对齐或切下一篇
      if (loaded.revision !== current.revision || Boolean(loaded.teacherReviewedAt) || (loaded.status !== "ready_for_review" && loaded.status !== "exported")) {
        try {
          const pendingSeq = ++pendingExportSeqRef.current;
          setExportListLoading(false);
          const [refreshedQueue, refreshedPending] = await Promise.all([
            apiFetch<ReviewQueueItemView[]>("/api/reviews/review-queue"),
            apiFetch<Array<ReviewSummaryView | ReviewView>>("/api/reviews?summary=1&scope=pending-export"),
          ]);
          if (!active) return;
          const prevVisibleIndex = visibleQueueRef.current.findIndex(({ id }) => id === current.id);
          const refreshedVisible = filterVisibleQueue(refreshedQueue, classFilterRef.current, searchRef.current);
          queueRef.current = refreshedQueue;
          setQueue(refreshedQueue);
          if (pendingSeq === pendingExportSeqRef.current) {
            setReviewed(normalizePendingExportItems(refreshedPending));
          }
          const updatedItem = refreshedVisible.find(({ id }) => id === loaded.id);
          if (updatedItem && !loaded.teacherReviewedAt && (loaded.status === "ready_for_review" || loaded.status === "exported")) {
            if (updatedItem.revision === loaded.revision && (reviewRef.current?.id !== loaded.id || reviewRef.current?.revision !== loaded.revision)) {
              reviewRef.current = loaded;
              setReview(loaded);
              setDirty(false);
            }
          } else {
            const fallback = (prevVisibleIndex >= 0 ? refreshedVisible[Math.min(prevVisibleIndex, refreshedVisible.length - 1)] : null)
              ?? refreshedVisible[0]
              ?? null;
            const fallbackReview = fallback ? cacheRef.current.get(cacheKey(fallback.id, fallback.revision)) ?? null : null;
            returningItemRef.current = null;
            activeIdRef.current = fallback?.id ?? null;
            reviewRef.current = fallbackReview;
            setReturningItem(null);
            setActiveId(fallback?.id ?? null);
            setReview(fallbackReview);
            setDirty(false);
          }
          return;
        } catch (caught) {
          if (active) {
            setFailedDetailKey(currentKey);
            setError(errorMessage(caught));
          }
          return;
        }
      }
      if (reviewRef.current?.id !== loaded.id || reviewRef.current?.revision !== loaded.revision) {
        reviewRef.current = loaded;
        setReview(loaded);
        setDirty(false);
      }
    }).catch((caught) => {
      if (active && requestSeq === detailRequestSeqRef.current && !(caught instanceof DOMException && caught.name === "AbortError")) {
        setFailedDetailKey(currentKey);
        if (reviewRef.current?.id !== current.id || reviewRef.current?.revision !== current.revision) {
          reviewRef.current = null;
          setReview(null);
        }
        setDirty(false);
        setError(errorMessage(caught));
      }
    });
    return () => { active = false; };
  }, [activeItem, detailRetryNonce, isReturningEdit, loadDetail]);

  const revisionTitle = currentReview?.config.title.trim();
  const revisionReviewId = currentReview?.id;
  useEffect(() => {
    if (!revisionDialogOpen || !revisionTitle || !revisionReviewId) return;
    const controller = new AbortController();
    void apiFetch<Array<{ text: string; scope: string; sourceTitle: string; sourceReviewId?: string | null }>>("/api/grading-opinions", { signal: controller.signal })
      .then((opinions) => {
        if (controller.signal.aborted || !Array.isArray(opinions)) return;
        const rules = opinions
          .filter((item) => item.scope === "standing" && item.sourceTitle.trim() === revisionTitle && item.text.trim())
          .map((item) => item.text);
        const currentEssayRules = opinions
          .filter((item) => item.scope === "essay" && item.sourceReviewId === revisionReviewId && item.text.trim())
          .map((item) => item.text);
        setStandingRules([...new Set(rules)]);
        setEssayRules([...new Set(currentEssayRules)]);
      })
      .catch(() => {
        if (!controller.signal.aborted) setStandingRulesError("同题规则读取失败，可继续手写，或关闭后重试。");
      })
      .finally(() => { if (!controller.signal.aborted) setStandingRulesLoading(false); });
    return () => controller.abort();
  }, [revisionDialogOpen, revisionReviewId, revisionTitle]);

  useEffect(() => {
    if (!activeId) return;
    const ids = visibleQueue.map(({ id }) => id);
    const windowIds = reviewPrefetchWindow(ids, activeId);
    windowIds.slice(1).forEach((id) => {
      const item = visibleQueue.find((candidate) => candidate.id === id);
      if (item) void loadDetail(item).catch(() => undefined);
    });
  }, [activeId, loadDetail, visibleQueue]);

  useEffect(() => {
    if (revisionJobs.length === 0) return;
    let active = true;
    let inFlight = false;

    async function pollRevisionJobs() {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
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
        if (!mountedRef.current) return;
        if (failedReviewIds.length > 0) {
          const failedSet = new Set(failedReviewIds);
          setRevisionJobs((current) => current.filter(({ reviewId }) => !failedSet.has(reviewId)));
          setRevisionNotice("退回后的重新分析失败，作文未加入待审核队列。");
        }
        if (succeededReviewIds.length === 0) return;
        try {
          // 先完成队列重取并落入页面状态，最后才从 revisionJobs 移除已完成项，避免提前触发 effect cleanup 丢弃延迟返回的队列响应
          const loaded = await apiFetch<ReviewQueueItemView[]>("/api/reviews/review-queue");
          if (!mountedRef.current) return;
          const nextVisible = filterVisibleQueue(loaded, classFilterRef.current, searchRef.current);
          queueRef.current = loaded;
          setQueue(loaded);
          setActiveId((current) => {
            if (current && (nextVisible.some(({ id }) => id === current) || returningItemRef.current?.id === current)) {
              activeIdRef.current = current;
              return current;
            }
            const nextId = nextVisible[0]?.id ?? null;
            activeIdRef.current = nextId;
            return nextId;
          });
          const succeededSet = new Set(succeededReviewIds);
          setRevisionJobs((current) => current.filter(({ reviewId }) => !succeededSet.has(reviewId)));
        } catch {
          if (mountedRef.current) setRevisionNotice("待审核队列暂时无法刷新，请稍后重试。");
        }
      } finally {
        inFlight = false;
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void pollRevisionJobs();
    };
    void pollRevisionJobs();
    const timer = window.setInterval(() => { void pollRevisionJobs(); }, 2000);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [revisionJobs]);

  function retryCurrentDetail() {
    if (!activeId || detailLoading || saving || revisionSubmitting) return;
    setFailedDetailKey(null);
    setError("");
    setDetailRetryNonce((current) => current + 1);
  }

  function choose(id: string) {
    if (saving || revisionSubmitting) return;
    if (id === activeId) {
      if (!currentReview && !detailLoading) {
        retryCurrentDetail();
      }
      return;
    }
    if (dirty && !window.confirm("当前修改尚未审核保存，确认切换作文？")) return;
    const nextItem = visibleQueue.find((item) => item.id === id) ?? null;
    if (!nextItem) return;
    const cached = cacheRef.current.get(cacheKey(nextItem.id, nextItem.revision)) ?? null;
    returningItemRef.current = null;
    activeIdRef.current = id;
    reviewRef.current = cached;
    setReturningItem(null);
    setFailedDetailKey(null);
    setActiveId(id);
    setReview(cached);
    setDirty(false);
    setError("");
    setRevisionDialogOpen(false);
  }

  function updateSearch(value: string, nextClass = classFilter) {
    const nextVisible = filterVisibleQueue(queueRef.current, nextClass, value);
    const keepReturning = returningItem && returningItem.id === activeId && filterReviewsByClass([returningItem], nextClass).length > 0;
    if (activeId && !keepReturning && !nextVisible.some(({ id }) => id === activeId)) {
      if (dirty && !window.confirm("当前修改尚未审核保存，确认切换作文？")) return;
      const next = nextVisible[0] ?? null;
      const cached = next ? cacheRef.current.get(cacheKey(next.id, next.revision)) ?? null : null;
      returningItemRef.current = null;
      activeIdRef.current = next?.id ?? null;
      reviewRef.current = cached;
      setReturningItem(null);
      setFailedDetailKey(null);
      setActiveId(next?.id ?? null);
      setReview(cached);
      setDirty(false);
      setRevisionDialogOpen(false);
    }
    classFilterRef.current = nextClass;
    searchRef.current = value;
    setSearch(value);
    if (nextClass !== classFilter) {
      const empty = new Set<string>();
      selectedExportIdsRef.current = empty;
      setSelectedExportIds(empty);
    }
    setClassFilter(nextClass);
  }

  function advanceAfterQueueRemoval(reviewId: string) {
    const liveQueue = queueRef.current;
    const nextQueue = liveQueue.filter(({ id }) => id !== reviewId);
    queueRef.current = nextQueue;
    setQueue(nextQueue);
    // 若异步提交响应前教师已切班/搜索切换到另一位学生，仅移出已完成项，绝不用旧队列闭包覆盖当前已展示的新学生
    if (activeIdRef.current !== reviewId) return;
    const liveVisible = filterVisibleQueue(liveQueue, classFilterRef.current, searchRef.current);
    const currentIndex = liveVisible.findIndex(({ id }) => id === reviewId);
    const next = currentIndex >= 0
      ? liveVisible[currentIndex + 1] ?? liveVisible[currentIndex - 1] ?? null
      : liveVisible.find(({ id }) => id !== reviewId) ?? null;
    const cached = next ? cacheRef.current.get(cacheKey(next.id, next.revision)) ?? null : null;
    returningItemRef.current = null;
    activeIdRef.current = next?.id ?? null;
    reviewRef.current = cached;
    setReturningItem(null);
    setFailedDetailKey(null);
    setActiveId(next?.id ?? null);
    setReview(cached);
    setDirty(false);
  }

  async function completeReview() {
    if (!currentReview?.report || !activeId || !activeItem || currentReview.id !== activeId || currentReview.id !== activeItem.id || currentReview.revision !== activeItem.revision || detailLoading || saving || revisionSubmitting) return;
    if (paragraphReadiness && !paragraphReadiness.ready) {
      setError(paragraphReadiness.message);
      return;
    }
    const targetReview = currentReview;
    // 与「同步到逐段」相同：以完整范文为准覆盖改后全段，一致时不改。
    const report = syncEssayBeforeApproval(targetReview.report!, targetReview.ocr?.version === 2 ? targetReview.ocr : null);
    if (report !== targetReview.report) {
      const synced = { ...targetReview, report };
      reviewRef.current = synced;
      setReview(synced);
    }
    setSaving(true);
    setError("");
    try {
      const saved = await apiFetch<ReviewView>(`/api/reviews/${encodeURIComponent(targetReview.id)}/teacher-review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: targetReview.revision,
          studentName: targetReview.studentName,
          report,
          annotations: targetReview.annotations,
        }),
      });
      cacheRef.current.set(cacheKey(saved.id, saved.revision), saved);
      pendingExportSeqRef.current += 1;
      setExportListLoading(false);
      setReviewed((current) => [...current.filter(({ id }) => id !== saved.id), toReviewSummary(saved)]);
      setSelectedExportIds((current) => {
        const next = new Set(current).add(saved.id);
        selectedExportIdsRef.current = next;
        return next;
      });
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
    if (!currentReview || !activeId || !activeItem || currentReview.id !== activeId || currentReview.id !== activeItem.id || currentReview.revision !== activeItem.revision || detailLoading || revisionSubmitting || saving) return;
    if (dirty && !window.confirm("当前修改尚未审核保存，确认切换作文？")) return;
    setRevisionError("");
    setRevisionNotice("");
    setStandingRules([]);
    setEssayRules([]);
    setStandingRulesLoading(Boolean(currentReview.config.title.trim()));
    setStandingRulesError("");
    setRevisionDialogOpen(true);
  }

  async function rejectReview(input: { commonIssue: string; contentSuggestion: string; commonIssueScope?: "essay" | "standing" }) {
    if (!currentReview || !activeId || !activeItem || currentReview.id !== activeId || currentReview.id !== activeItem.id || currentReview.revision !== activeItem.revision || revisionSubmitting) return;
    const targetReview = currentReview;
    setRevisionSubmitting(true);
    setRevisionError("");
    setRevisionNotice("");
    try {
      await apiFetch(`/api/reviews/${encodeURIComponent(targetReview.id)}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: targetReview.revision,
          reason: input.commonIssue,
          changeRequest: input.contentSuggestion,
        }),
      });
      for (const key of cacheRef.current.keys()) {
        if (key.startsWith(`${targetReview.id}:`)) cacheRef.current.delete(key);
      }
      pendingExportSeqRef.current += 1;
      setExportListLoading(false);
      setReviewed((current) => current.filter(({ id }) => id !== targetReview.id));
      setRevisionDialogOpen(false);
      pendingRules?.refresh();
      advanceAfterQueueRemoval(targetReview.id);
    } catch (caught) {
      setRevisionError(errorMessage(caught));
    } finally {
      setRevisionSubmitting(false);
    }
  }

  async function requestRevision(input: { commonIssue: string; contentSuggestion: string; commonIssueScope?: "essay" | "standing" }) {
    if (!currentReview || !activeId || !activeItem || currentReview.id !== activeId || currentReview.id !== activeItem.id || currentReview.revision !== activeItem.revision || revisionSubmitting) return;
    const targetReview = currentReview;
    setRevisionSubmitting(true);
    setRevisionError("");
    setRevisionNotice("");
    try {
      const result = await apiFetch<RevisionRequestResult>(`/api/reviews/${encodeURIComponent(targetReview.id)}/revision-request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: targetReview.revision,
          commonIssue: input.commonIssue,
          ...(input.commonIssueScope ? { commonIssueScope: input.commonIssueScope } : {}),
          contentSuggestion: input.contentSuggestion,
        }),
      });
      for (const key of cacheRef.current.keys()) {
        if (key.startsWith(`${targetReview.id}:`)) cacheRef.current.delete(key);
      }
      pendingExportSeqRef.current += 1;
      setExportListLoading(false);
      setReviewed((current) => current.filter(({ id }) => id !== targetReview.id));
      if (result.job.status === "queued" || result.job.status === "running") {
        setRevisionJobs((current) => [...current.filter(({ reviewId }) => reviewId !== result.job.reviewId), { reviewId: result.job.reviewId, jobId: result.job.id }]);
      }
      setRevisionDialogOpen(false);
      pendingRules?.refresh();
      advanceAfterQueueRemoval(targetReview.id);
    } catch (caught) {
      setRevisionError(errorMessage(caught));
    } finally {
      setRevisionSubmitting(false);
    }
  }

  function openExportView() {
    if (view === "review" && dirty) {
      if (!window.confirm("当前修改尚未审核保存，直接切回待导出清单不会导出最新改动。确认放弃当前修改并切换吗？")) {
        return;
      }
      const clean = activeItem ? cacheRef.current.get(cacheKey(activeItem.id, activeItem.revision)) ?? null : null;
      reviewRef.current = clean;
      setReview(clean);
      setDirty(false);
    }
    setView("export");
    const seq = ++pendingExportSeqRef.current;
    setExportListLoading(true);
    setError("");
    void apiFetch<Array<ReviewSummaryView | ReviewView>>("/api/reviews?summary=1&scope=pending-export")
      .then((latest) => {
        if (!mountedRef.current || seq !== pendingExportSeqRef.current) return;
        setReviewed(normalizePendingExportItems(latest));
      })
      .catch((caught) => {
        if (mountedRef.current && seq === pendingExportSeqRef.current) {
          setError(errorMessage(caught));
        }
      })
      .finally(() => {
        if (mountedRef.current && seq === pendingExportSeqRef.current) {
          setExportListLoading(false);
        }
      });
  }

  async function exportSelected(format: ExportFormat) {
    if (selectedExportIds.size === 0 || exporting || exportListLoading) return;
    const targetClass = classFilterRef.current;
    const targetSelected = new Set(selectedExportIds);
    const seqBefore = ++pendingExportSeqRef.current;
    let downloadStarted = false;
    setExportListLoading(false);
    setExporting(true);
    setError("");
    try {
      const latestBefore = await apiFetch<Array<ReviewSummaryView | ReviewView>>("/api/reviews?summary=1&scope=pending-export");
      if (!mountedRef.current || seqBefore !== pendingExportSeqRef.current || classFilterRef.current !== targetClass) {
        if (mountedRef.current) {
          setError("待导出清单或筛选状态已更新，已取消过期导出，请按最新清单重新操作");
        }
        return;
      }
      const normalizedBefore = normalizePendingExportItems(latestBefore);
      setReviewed(normalizedBefore);
      const liveSelected = selectedExportIdsRef.current;
      const filteredBefore = filterReviewsByClass(normalizedBefore, targetClass);
      const selectedItems = filteredBefore.filter(({ id }) => targetSelected.has(id) && liveSelected.has(id));
      if (selectedItems.some((item) => "summarySyncPending" in item && Boolean(item.summarySyncPending))) {
        setError("历史批改摘要正在同步导出资格，请刷新页面后再导出所选作文");
        return;
      }
      const freshIds = selectedItems
        .filter((item) => exportEligibility(item).eligible)
        .map(({ id }) => id);
      if (freshIds.length === 0) {
        setError("所选记录当前已无可导出的已复核作文");
        return;
      }
      downloadStarted = true;
      await downloadReviewArchive(freshIds, format);
      const seqAfter = ++pendingExportSeqRef.current;
      setExportListLoading(false);
      const latestAfter = await apiFetch<Array<ReviewSummaryView | ReviewView>>("/api/reviews?summary=1&scope=pending-export");
      if (mountedRef.current && seqAfter === pendingExportSeqRef.current) {
        setReviewed(normalizePendingExportItems(latestAfter));
      }
      const emptySelected = new Set<string>();
      selectedExportIdsRef.current = emptySelected;
      setSelectedExportIds(emptySelected);
    } catch (caught) {
      if (mountedRef.current && (downloadStarted || seqBefore === pendingExportSeqRef.current)) {
        setError(errorMessage(caught));
      }
    } finally {
      if (mountedRef.current) {
        setExporting(false);
      }
    }
  }

  async function exportAllReviewed(format: ExportFormat) {
    if (exporting || exportListLoading) return;
    const targetClass = classFilterRef.current;
    const seqBefore = ++pendingExportSeqRef.current;
    let downloadStarted = false;
    setExportListLoading(false);
    setExporting(true);
    setError("");
    try {
      // 一键导出前强制拉取服务端最新待导出集合；若重取期间清单已刷新变更或请求失败，立即中止导出（归档调用 0 次）
      const latestBefore = await apiFetch<Array<ReviewSummaryView | ReviewView>>("/api/reviews?summary=1&scope=pending-export");
      if (!mountedRef.current || seqBefore !== pendingExportSeqRef.current || classFilterRef.current !== targetClass) {
        if (mountedRef.current) {
          setError("待导出清单或筛选状态已更新，已取消过期导出，请按最新清单重新操作");
        }
        return;
      }
      const normalizedBefore = normalizePendingExportItems(latestBefore);
      setReviewed(normalizedBefore);
      const filteredBefore = filterReviewsByClass(normalizedBefore, targetClass);
      if (filteredBefore.some((item) => "summarySyncPending" in item && Boolean(item.summarySyncPending))) {
        setError("历史批改摘要正在同步导出资格，请刷新页面后再一键导出");
        return;
      }
      const freshIds = filteredBefore
        .filter((item) => exportEligibility(item).eligible)
        .map(({ id }) => id);
      if (freshIds.length === 0) {
        setError("当前筛选下没有可导出的已复核作文");
        return;
      }
      downloadStarted = true;
      await downloadReviewArchive(freshIds, format);
      const seqAfter = ++pendingExportSeqRef.current;
      setExportListLoading(false);
      const latestAfter = await apiFetch<Array<ReviewSummaryView | ReviewView>>("/api/reviews?summary=1&scope=pending-export");
      if (mountedRef.current && seqAfter === pendingExportSeqRef.current) {
        setReviewed(normalizePendingExportItems(latestAfter));
      }
      const emptySelected = new Set<string>();
      selectedExportIdsRef.current = emptySelected;
      setSelectedExportIds(emptySelected);
    } catch (caught) {
      if (mountedRef.current && (downloadStarted || seqBefore === pendingExportSeqRef.current)) {
        setError(errorMessage(caught));
      }
    } finally {
      if (mountedRef.current) {
        setExporting(false);
      }
    }
  }

  return <div className="app-shell batch-review-shell">
    <AppHeader />
    <main className="batch-review-page">
      <header className="batch-review-topbar">
        <div><p className="eyebrow">教师审核</p><h1>批量作文审核</h1></div>
        <div className="segmented-control" aria-label="批量审核视图">
          <button type="button" aria-pressed={view === "review"} onClick={() => setView("review")}>连续审核</button>
          <button type="button" aria-pressed={view === "export"} onClick={openExportView}>已复核待导出清单 ({reviewed.length})</button>
        </div>
        <div className="batch-review-topbar-actions">
          <Link className="button button--quiet" href="/opinions">长期批改规则</Link>
          <Link className="button button--quiet" href="/">返回历史</Link>
        </div>
      </header>
      {error ? <ErrorBanner message={error} /> : null}
      {revisionNotice ? <div className="revision-job-notice" role="status">{revisionNotice}</div> : null}
      {view === "export" ? <section className="batch-export-view">
        <ClassFilter items={[...queue, ...reviewed]} value={classFilter} onChange={(value) => updateSearch(search, value)} />
        <div className="batch-export-actions"><span>已选择 {selectedExportIds.size} 篇</span><div className="batch-export-action-buttons"><div className="batch-export-command"><span>导出所选作文</span><ExportMenu ariaLabel="导出所选作文" disabled={selectedExportable.length === 0 || exporting || exportListLoading} disabledReason={selectedExportIds.size > 0 && selectedExportable.length === 0 ? "所选记录没有可导出的新格式" : undefined} busy={exporting} onExport={exportSelected} /></div><div className="batch-export-command"><span>一键导出已复核（{pendingExportSyncing ? 0 : exportableReviewed.length}）</span><ExportMenu ariaLabel="导出全部已复核" disabled={exportableReviewed.length === 0 || exporting || exportListLoading || pendingExportSyncing} disabledReason={pendingExportSyncing ? "历史批改摘要正在同步导出资格，请刷新页面后再一键导出" : undefined} busy={exporting} onExport={exportAllReviewed} /></div></div></div>
        <ReviewExportList reviews={filteredReviewed} selectedIds={selectedExportIds} disabled={exporting || exportListLoading} onToggle={(id) => { if (exporting || exportListLoading) return; setSelectedExportIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); selectedExportIdsRef.current = next; return next; }); }} onReturnToReview={(id) => { if (exporting || exportListLoading) return; const target = reviewed.find((item) => item.id === id); if (!target) return; if (dirty && !window.confirm("当前修改尚未审核保存，确认切换作文？")) return; const meta: ReviewQueueItemView = { id: target.id, studentName: target.studentName, className: target.className ?? "", title: target.config.title, status: target.status, revision: target.revision, createdAt: target.createdAt }; for (const key of cacheRef.current.keys()) { if (key.startsWith(`${id}:`)) cacheRef.current.delete(key); } const pending = requestsRef.current.get(id); if (pending) { pending.controller.abort(); requestsRef.current.delete(id); } returningItemRef.current = meta; activeIdRef.current = id; reviewRef.current = null; setFailedDetailKey(null); setReturningItem(meta); setActiveId(id); setReview(null); setDirty(false); setError(""); setDetailRetryNonce((current) => current + 1); setView("review"); }} />
      </section> : <div className="batch-review-layout">
        <div className="batch-review-actionbar" role="toolbar" aria-label="审核操作"><span>{paragraphReadiness && !paragraphReadiness.ready ? paragraphReadiness.message : sampleParagraphCountMismatch && currentReview ? <>示范作文段落数不符合题目要求。<Link href={`/reviews?id=${encodeURIComponent(currentReview.id)}`}>前往单篇复核</Link></> : dirty ? "有未确认的修改" : currentReview ? "修改将在审核确认时保存" : ""}</span><div className="batch-review-actionbar-actions"><button ref={revisionButtonRef} type="button" className="button button--danger-quiet" disabled={!currentReview || detailLoading || saving || revisionSubmitting} onClick={openRevisionDialog}>不合适</button><button type="button" className="button button--primary" disabled={!currentReview?.report || detailLoading || saving || revisionSubmitting || sampleParagraphCountMismatch || Boolean(paragraphReadiness && !paragraphReadiness.ready)} onClick={() => void completeReview()}>{saving ? "正在保存并切换…" : "审核通过并进入下一篇"}</button></div></div>
        <aside className="batch-queue" aria-label="待审核作文队列">
          <ClassFilter items={[...queue, ...reviewed]} value={classFilter} onChange={(value) => updateSearch(search, value)} />
          <label>搜索学生姓名<input type="search" aria-label="搜索待审核学生姓名" value={search} onChange={(event) => updateSearch(event.target.value)} /></label>
          <p className="muted">待审核 {queue.length} 篇</p>
          <div className="batch-queue-list">{visibleQueue.map((item, index) => <button type="button" className={item.id === activeId ? "is-active" : ""} key={item.id} disabled={saving || revisionSubmitting} onClick={() => choose(item.id)}><span>{index + 1}</span><b>{item.studentName || "未填写学生"}</b><small>{item.className || "未分类"} · {item.title}</small></button>)}</div>
        </aside>
        <section className="batch-essay-pane">
          {loading || detailLoading ? <p className="loading-note" role="status">正在展开作文与批改报告…</p> : !activeId ? <div className="batch-empty"><h2>待审核队列已完成</h2><p>可以前往待导出清单核对并导出作文。</p></div> : currentReview ? <>
            <div className="batch-pane-heading"><div><p className="eyebrow">当前学生</p><h2>{currentReview.studentName || "未填写学生"}</h2></div><span>{currentReview.className || "未分类"} · {currentReview.config.title}</span></div>
            <div className="batch-essay-content">{currentReview.images.map((image, index) => <figure key={image.id}><img src={`/api/reviews/${encodeURIComponent(currentReview.id)}/files?imageId=${image.id}&variant=annotation`} alt={`学生作文原文第 ${index + 1} 页`} /><figcaption>原文第 {index + 1} 页</figcaption></figure>)}</div>
          </> : <div className="batch-empty"><h2>当前作文详情尚未加载成功</h2><p>请核对上方提示，或重新点击左侧学生重试。</p><button type="button" className="button button--quiet" onClick={retryCurrentDetail}>重新加载当前作文</button></div>}
        </section>
        <section className="batch-report-pane">
          {currentReview?.report ? <BatchReviewReportEditor
            report={currentReview.report}
            reviewId={currentReview.id}
            ocr={currentReview.ocr}
            images={currentReview.images}
            disabled={saving || revisionSubmitting || currentReview.reportStale || (isParagraphReportDraft(currentReview.report) && currentReview.ocr?.version !== 2)}
            onChange={(report) => { const next = { ...currentReview, report }; reviewRef.current = next; setReview(next); setDirty(true); }}
          /> : <p className="muted">{detailLoading ? "正在加载当前学生的批改报告…" : "选择一篇作文开始审核"}</p>}
        </section>
      </div>}
    </main>
    {revisionDialogOpen ? <RevisionRequestDialog open standingRules={standingRules} essayOpinions={essayRules} standingRulesLoading={standingRulesLoading} standingRulesError={standingRulesError} submitting={revisionSubmitting} error={revisionError} onClose={closeRevisionDialog} onSubmit={(input) => { void requestRevision(input); }} onReject={(input) => { void rejectReview(input); }} /> : null}
  </div>;
}
