"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  computeClassSubmissionBreakdown,
  formatMissingRosterCopyText,
  type ClassRosterView,
  type ClassSubmissionBreakdown,
  type TitleSubmissionItemView,
} from "@/src/domain/class-roster";

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback to hidden textarea copy below if Clipboard API is restricted.
    }
  }
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }
  return copied;
}

export interface MissingSubmissionPanelProps {
  classFilter: string | null;
  titleFilter: string | null;
  titles: readonly string[];
  rosters: readonly ClassRosterView[];
  titleSubmissions: readonly TitleSubmissionItemView[];
  titleSubmissionsTruncated?: boolean;
  isQuerySettled: boolean;
  onSelectClass: (className: string | null) => void;
  onSelectTitle: (title: string | null) => void;
  onOpenRosterDialog: (className?: string) => void;
}

export function MissingSubmissionPanel({
  classFilter,
  titleFilter,
  titles,
  rosters,
  titleSubmissions,
  titleSubmissionsTruncated = false,
  isQuerySettled,
  onSelectClass,
  onSelectTitle,
  onOpenRosterDialog,
}: MissingSubmissionPanelProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [showSubmitted, setShowSubmitted] = useState(false);
  const [showZeroSubmissionClasses, setShowZeroSubmissionClasses] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
  }, []);

  const selectedRoster = useMemo(
    () => (classFilter ? rosters.find((item) => item.className === classFilter) ?? null : null),
    [classFilter, rosters],
  );

  const singleBreakdown = useMemo<ClassSubmissionBreakdown | null>(() => {
    if (!titleFilter || !classFilter || !selectedRoster) return null;
    return computeClassSubmissionBreakdown(classFilter, selectedRoster.students, titleSubmissions);
  }, [classFilter, selectedRoster, titleFilter, titleSubmissions]);

  const multiBreakdowns = useMemo<ClassSubmissionBreakdown[]>(() => {
    if (!titleFilter || classFilter !== null || rosters.length === 0) return [];
    return rosters.map((roster) =>
      computeClassSubmissionBreakdown(roster.className, roster.students, titleSubmissions),
    );
  }, [classFilter, rosters, titleFilter, titleSubmissions]);

  async function handleCopy(key: string, text: string) {
    if (!text) return;
    const ok = await copyTextToClipboard(text);
    if (!ok) return;
    setCopiedKey(key);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedKey((current) => (current === key ? null : current));
    }, 2_000);
  }

  if (!isQuerySettled) return null;

  // 场景 1：已选具体班级（非未分类），尚未选作文题目
  if (!titleFilter) {
    if (!classFilter) return null;
    return (
      <section className="roster-status-bar" aria-label="班级名单提示">
        {selectedRoster ? (
          <>
            <div className="roster-status-bar__main">
              <strong>{classFilter}</strong>
              <span>班级名单共 {selectedRoster.students.length} 人 · 选择上方「作文题目」即可直接生成未交名单</span>
              {titles.length > 0 ? (
                <div className="roster-quick-titles" role="group" aria-label="快速选择作文题目">
                  {titles.slice(0, 3).map((title) => (
                    <button
                      key={title}
                      type="button"
                      className="roster-quick-chip"
                      onClick={() => onSelectTitle(title)}
                    >
                      查看《{title}》
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="button button--quiet button--sm"
              onClick={() => onOpenRosterDialog(classFilter)}
            >
              编辑本班名单
            </button>
          </>
        ) : (
          <>
            <div className="roster-status-bar__main">
              <span>尚未录入「{classFilter}」整体学生名单，录入一次后按题目筛选即可自动生成未交名单。</span>
            </div>
            <button
              type="button"
              className="button button--quiet button--sm"
              onClick={() => onOpenRosterDialog(classFilter)}
            >
              录入{classFilter}名单
            </button>
          </>
        )}
      </section>
    );
  }

  // 场景 2：已选具体题目，但班级选了「未分类」
  if (classFilter === "") {
    return (
      <section className="roster-status-bar" aria-label="未交名单提示">
        <div className="roster-status-bar__main">
          <span>当前筛选为「未分类」班级；切换到具体班级即可比对班级名单生成《{titleFilter}》未交名单。</span>
        </div>
      </section>
    );
  }

  // 场景 3：已选具体班级 + 已选具体作文题目
  if (classFilter !== null) {
    if (!selectedRoster || !singleBreakdown) {
      return (
        <section className="roster-panel roster-panel--empty" aria-label="未交名单统计">
          <div className="roster-panel__header">
            <div>
              <strong>{classFilter} · 《{titleFilter}》</strong>
              <p className="muted">尚未录入「{classFilter}」整体学生名单，录入后立即生成本题未交名单。</p>
            </div>
            <button
              type="button"
              className="button button--primary button--sm"
              onClick={() => onOpenRosterDialog(classFilter)}
            >
              录入{classFilter}名单
            </button>
          </div>
        </section>
      );
    }

    const fullCopyText = formatMissingRosterCopyText({
      className: classFilter,
      title: titleFilter,
      missing: singleBreakdown.missing,
    });
    const namesOnlyText = formatMissingRosterCopyText({
      className: classFilter,
      title: titleFilter,
      missing: singleBreakdown.missing,
      namesOnly: true,
    });

    return (
      <section className="roster-panel" aria-label={`${classFilter}《${titleFilter}》交齐统计`}>
        <div className="roster-panel__header">
          <div className="roster-panel__title-group">
            <h3>{classFilter} · 《{titleFilter}》交齐统计</h3>
            <div className="roster-stat-pills">
              <span className="roster-pill">应交 {singleBreakdown.totalRoster} 人</span>
              <span className="roster-pill roster-pill--ok">已交 {singleBreakdown.submitted.length} 人</span>
              <span className={`roster-pill ${singleBreakdown.missing.length > 0 ? "roster-pill--missing" : "roster-pill--ok"}`}>
                未交 {singleBreakdown.missing.length} 人
              </span>
            </div>
          </div>
          <div className="roster-panel__actions">
            {singleBreakdown.missing.length > 0 ? (
              <>
                <button
                  type="button"
                  className="button button--primary button--sm"
                  onClick={() => void handleCopy("single-full", fullCopyText)}
                >
                  {copiedKey === "single-full" ? "已复制未交名单 ✓" : "一键复制未交名单"}
                </button>
                <button
                  type="button"
                  className="button button--quiet button--sm"
                  onClick={() => void handleCopy("single-names", namesOnlyText)}
                >
                  {copiedKey === "single-names" ? "已复制姓名 ✓" : "仅复制姓名"}
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="button button--quiet button--sm"
              onClick={() => onOpenRosterDialog(classFilter)}
            >
              编辑本班名单
            </button>
          </div>
        </div>

        {singleBreakdown.missing.length > 0 ? (
          <div className="roster-missing-block">
            <span className="roster-block-label">未交名单（{singleBreakdown.missing.length} 人）：</span>
            <ul className="roster-name-chips" aria-label="未交学生列表">
              {singleBreakdown.missing.map((name) => (
                <li key={name} className="roster-chip roster-chip--missing">{name}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="roster-all-submitted" role="status">
            全班 {singleBreakdown.totalRoster} 人已全部交齐！
          </p>
        )}

        {singleBreakdown.rejectedNames.length > 0 || singleBreakdown.draftNames.length > 0 ? (
          <p className="roster-subnote">
            已交记录中含
            {singleBreakdown.rejectedNames.length > 0 ? `审核不通过 ${singleBreakdown.rejectedNames.length} 人（${singleBreakdown.rejectedNames.join("、")}）` : ""}
            {singleBreakdown.rejectedNames.length > 0 && singleBreakdown.draftNames.length > 0 ? "，" : ""}
            {singleBreakdown.draftNames.length > 0 ? `草稿未提交分析 ${singleBreakdown.draftNames.length} 人（${singleBreakdown.draftNames.join("、")}）` : ""}
            。
          </p>
        ) : null}

        {singleBreakdown.unnamedSubmissionCount > 0 || singleBreakdown.unmatchedSubmissions.length > 0 ? (
          <p className="roster-warning-note" role="status">
            注意：本题下另有
            {singleBreakdown.unnamedSubmissionCount > 0 ? ` ${singleBreakdown.unnamedSubmissionCount} 篇未填写学生姓名` : ""}
            {singleBreakdown.unnamedSubmissionCount > 0 && singleBreakdown.unmatchedSubmissions.length > 0 ? "、" : ""}
            {singleBreakdown.unmatchedSubmissions.length > 0
              ? ` ${singleBreakdown.unmatchedSubmissions.length} 人不在本班名单中（${singleBreakdown.unmatchedSubmissions.map((item) => item.studentName).join("、")}）`
              : ""}
            ，请核对是否漏登或姓名输入有误。
          </p>
        ) : null}

        {titleSubmissionsTruncated ? (
          <p className="roster-subnote">当前题目记录超过 1000 篇，交齐统计仅基于最新 1000 篇计算。</p>
        ) : null}

        {singleBreakdown.submitted.length > 0 ? (
          <div className="roster-submitted-toggle">
            <button
              type="button"
              className="roster-text-btn"
              aria-expanded={showSubmitted}
              onClick={() => setShowSubmitted((prev) => !prev)}
            >
              {showSubmitted ? `收起已交名单（${singleBreakdown.submitted.length} 人）` : `展开查看已交名单（${singleBreakdown.submitted.length} 人）`}
            </button>
            {showSubmitted ? (
              <ul className="roster-name-chips roster-name-chips--submitted" aria-label="已交学生列表">
                {singleBreakdown.submitted.map((entry) => (
                  <li key={entry.name}>
                    <Link
                      href={`/reviews?id=${encodeURIComponent(entry.reviewId)}`}
                      className="roster-chip roster-chip--submitted"
                    >
                      {entry.name}
                      {entry.status === "rejected" ? "（不通过）" : entry.status === "draft" ? "（草稿）" : ""}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  }

  // 场景 4：班级为「全部班级」+ 已选具体作文题目
  if (rosters.length === 0) {
    return (
      <section className="roster-panel roster-panel--empty" aria-label="未交名单统计">
        <div className="roster-panel__header">
          <div>
            <strong>《{titleFilter}》未交名单</strong>
            <p className="muted">还没有录入班级整体学生名单。录入一次后即可自动比对生成各班未交名单。</p>
          </div>
          <button
            type="button"
            className="button button--primary button--sm"
            onClick={() => onOpenRosterDialog()}
          >
            录入班级名单
          </button>
        </div>
      </section>
    );
  }

  const activeBreakdowns = multiBreakdowns.filter(
    (item) => item.submitted.length > 0 || item.unmatchedSubmissions.length > 0 || item.unnamedSubmissionCount > 0,
  );
  const defaultVisible = activeBreakdowns.length > 0 ? activeBreakdowns : multiBreakdowns;
  const hiddenZeroCount = multiBreakdowns.length - defaultVisible.length;
  const visibleBreakdowns = showZeroSubmissionClasses ? multiBreakdowns : defaultVisible;

  const combinedMissingLines = visibleBreakdowns
    .filter((item) => item.missing.length > 0)
    .map((item) => formatMissingRosterCopyText({
      className: item.className,
      title: titleFilter,
      missing: item.missing,
    }));
  const combinedCopyText = combinedMissingLines.join("\n");

  return (
    <section className="roster-panel" aria-label={`《${titleFilter}》各班未交名单汇总`}>
      <div className="roster-panel__header">
        <div className="roster-panel__title-group">
          <h3>《{titleFilter}》未交名单汇总</h3>
          <span className="muted">点击任一班级可单独筛选该班记录</span>
        </div>
        <div className="roster-panel__actions">
          {combinedMissingLines.length > 0 ? (
            <button
              type="button"
              className="button button--primary button--sm"
              onClick={() => void handleCopy("multi-all", combinedCopyText)}
            >
              {copiedKey === "multi-all" ? "已复制汇总 ✓" : "一键复制未交汇总"}
            </button>
          ) : null}
          {hiddenZeroCount > 0 ? (
            <button
              type="button"
              className="button button--quiet button--sm"
              onClick={() => setShowZeroSubmissionClasses((prev) => !prev)}
            >
              {showZeroSubmissionClasses ? "收起无提交班级" : `展开其余 ${hiddenZeroCount} 个无提交班级`}
            </button>
          ) : null}
          <button
            type="button"
            className="button button--quiet button--sm"
            onClick={() => onOpenRosterDialog()}
          >
            管理班级名单
          </button>
        </div>
      </div>

      <div className="roster-multi-grid">
        {visibleBreakdowns.map((item) => {
          const itemCopyKey = `multi:${item.className}`;
          const itemCopyText = formatMissingRosterCopyText({
            className: item.className,
            title: titleFilter,
            missing: item.missing,
          });
          return (
            <div className="roster-class-card" key={item.className}>
              <div className="roster-class-card__head">
                <div className="roster-class-card__meta">
                  <strong>{item.className}</strong>
                  <span className="roster-pill">应交 {item.totalRoster}</span>
                  <span className="roster-pill roster-pill--ok">已交 {item.submitted.length}</span>
                  <span className={`roster-pill ${item.missing.length > 0 ? "roster-pill--missing" : "roster-pill--ok"}`}>
                    未交 {item.missing.length}
                  </span>
                </div>
                <div className="roster-class-card__btns">
                  {item.missing.length > 0 ? (
                    <button
                      type="button"
                      className="roster-text-btn"
                      onClick={() => void handleCopy(itemCopyKey, itemCopyText)}
                    >
                      {copiedKey === itemCopyKey ? "已复制 ✓" : "复制未交"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="roster-text-btn"
                    onClick={() => onSelectClass(item.className)}
                  >
                    只看本班
                  </button>
                </div>
              </div>
              {item.missing.length > 0 ? (
                <p className="roster-class-card__missing">
                  未交：{item.missing.join("、")}
                </p>
              ) : (
                <p className="roster-class-card__done">全班已交齐</p>
              )}
              {item.unnamedSubmissionCount > 0 || item.unmatchedSubmissions.length > 0 ? (
                <p className="roster-warning-note">
                  另有
                  {item.unnamedSubmissionCount > 0 ? ` ${item.unnamedSubmissionCount} 篇未填姓名` : ""}
                  {item.unnamedSubmissionCount > 0 && item.unmatchedSubmissions.length > 0 ? "、" : ""}
                  {item.unmatchedSubmissions.length > 0 ? `名单外（${item.unmatchedSubmissions.map((u) => u.studentName).join("、")}）` : ""}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
