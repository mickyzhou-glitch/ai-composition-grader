"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

const MAX_FIELD_CHARS = 500;

/** 只追加整条原话，保留老师手写的空白；已存在的相同规则不重复追加。 */
export function appendRuleText(text: string, rule: string): string {
  if (`\n${text}\n`.includes(`\n${rule}\n`)) return text;
  return text ? `${text}${text.endsWith("\n") ? "" : "\n"}${rule}` : rule;
}

export interface RevisionRequestDialogProps {
  /** 当前题目下已审批通过的长期规则。 */
  standingRules?: string[];
  /** 当前作文曾提交过的本篇退回建议（scope = 'essay'）。 */
  essayOpinions?: string[];
  standingRulesLoading?: boolean;
  standingRulesError?: string;
  open: boolean;
  submitting: boolean;
  error: string;
  onClose(): void;
  onSubmit(input: { commonIssue: string; contentSuggestion: string; commonIssueScope?: "essay" | "standing" }): void;
  onReject(input: { commonIssue: string; contentSuggestion: string; commonIssueScope?: "essay" | "standing" }): void;
}

export function RevisionRequestDialog({
  standingRules = [],
  essayOpinions = [],
  standingRulesLoading = false,
  standingRulesError = "",
  open,
  submitting,
  error,
  onClose,
  onSubmit,
  onReject,
}: RevisionRequestDialogProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const commonIssueRef = useRef<HTMLTextAreaElement>(null);
  const contentSuggestionRef = useRef<HTMLTextAreaElement>(null);
  const [commonIssueScope, setCommonIssueScope] = useState<"essay" | "standing">("essay");
  const [commonIssue, setCommonIssue] = useState("");
  const [contentSuggestion, setContentSuggestion] = useState("");
  const [appendError, setAppendError] = useState("");

  function appendRule(rule: string) {
    const next = appendRuleText(commonIssue, rule);
    if (next.length > MAX_FIELD_CHARS) {
      setAppendError(`追加后超过 ${MAX_FIELD_CHARS} 字，未追加此规则。请先精简框内内容或手动输入需要的部分。`);
      return;
    }
    setCommonIssue(next);
    setAppendError("");
    commonIssueRef.current?.focus();
  }

  function appendEssayOpinion(opinion: string) {
    const next = appendRuleText(contentSuggestion, opinion);
    if (next.length > MAX_FIELD_CHARS) {
      setAppendError(`追加后超过 ${MAX_FIELD_CHARS} 字，未追加此建议。请先精简框内内容或手动输入需要的部分。`);
      return;
    }
    setContentSuggestion(next);
    setAppendError("");
    contentSuggestionRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    // Portal places the backdrop beside the page, outside its stacking and scrolling contexts.
    const background = Array.from(document.body.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== backdropRef.current,
    ).map((element) => ({ element, wasInert: element.hasAttribute("inert") }));
    background.forEach(({ element }) => element.setAttribute("inert", ""));
    document.body.style.overflow = "hidden";
    commonIssueRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      background.forEach(({ element, wasInert }) => { if (!wasInert) element.removeAttribute("inert"); });
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  const withinLimit = commonIssue.length <= MAX_FIELD_CHARS && contentSuggestion.length <= MAX_FIELD_CHARS;
  const valid = withinLimit && (commonIssue.trim().length > 0 || contentSuggestion.trim().length > 0);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !submitting) {
      event.preventDefault();
      onClose();
    }
    if (event.key === "Tab") {
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>("button, textarea") ?? [])
        .filter((element) => !element.disabled);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialogRef.current?.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || submitting) return;
    onSubmit({ commonIssue, contentSuggestion, ...(commonIssueScope === "standing" ? { commonIssueScope } : {}) });
  }

  return createPortal(
    <div ref={backdropRef} className="revision-dialog-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="revision-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="revision-request-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <form className="revision-dialog-form" onSubmit={submit}>
          <div className="revision-dialog-heading">
            <div>
              <p className="eyebrow">重新分析</p>
              <h2 id="revision-request-title">退回后台修改</h2>
            </div>
          </div>
          <div className="revision-dialog-body">
            <div className="revision-dialog-field">
              <label htmlFor="revision-common-issue">结构问题 / 共性问题（仅同名作文）</label>
              <label>共性意见生效范围
                <select aria-label="共性意见生效范围" value={commonIssueScope} disabled={submitting} onChange={(event) => setCommonIssueScope(event.target.value as "essay" | "standing")}>
                  <option value="essay">仅本篇</option><option value="standing">本题长期（提交后对同名作文生效）</option>
                </select>
              </label>
              {standingRulesLoading ? <p className="revision-dialog-scope" role="status">正在读取同题规则，可先手写。</p> : null}
              {standingRulesError ? <p className="revision-dialog-scope" role="status">{standingRulesError}</p> : null}
              {standingRules.length > 0 ? <div className="revision-rule-options" role="group" aria-label="已通过的长期规则">
                {[...new Set(standingRules)].map((rule) => <button
                    key={rule}
                    type="button"
                    className="revision-rule-option"
                    aria-label={`追加规则：${rule}`}
                    disabled={submitting}
                    onClick={() => appendRule(rule)}
                  >
                  <span>{rule}</span>
                  <span className="revision-rule-add" aria-hidden="true">＋ 追加</span>
                </button>)}
              </div> : null}
              <textarea
                id="revision-common-issue"
                ref={commonIssueRef}
                aria-describedby="revision-common-scope revision-common-count"
                maxLength={MAX_FIELD_CHARS}
                value={commonIssue}
                disabled={submitting}
                onChange={(event) => { setCommonIssue(event.target.value); setAppendError(""); }}
              />
              {appendError ? <p className="revision-dialog-error" role="alert">{appendError}</p> : null}
              <p id="revision-common-scope" className="revision-dialog-scope">本篇重新分析会用到。点选同题已通过规则可追加原话，框内可继续手改；新写或改过的内容会按老师原话提交审批，在「长期批改规则」里审批通过后才对同名作文生效。</p>
              <small id="revision-common-count">{commonIssue.length} / {MAX_FIELD_CHARS}</small>
            </div>
            <div className="revision-dialog-field">
              <label htmlFor="revision-content-suggestion">内容建议（仅当前文章）</label>
              {essayOpinions.length > 0 ? <div className="revision-rule-options" role="group" aria-label="本篇历史退回意见">
                {[...new Set(essayOpinions)].map((opinion) => <button
                    key={opinion}
                    type="button"
                    className="revision-rule-option"
                    aria-label={`追加本篇意见：${opinion}`}
                    disabled={submitting}
                    onClick={() => appendEssayOpinion(opinion)}
                  >
                  <span>{opinion}</span>
                  <span className="revision-rule-add" aria-hidden="true">＋ 追加</span>
                </button>)}
              </div> : null}
              <textarea
                id="revision-content-suggestion"
                ref={contentSuggestionRef}
                aria-describedby="revision-content-scope revision-content-count"
                maxLength={MAX_FIELD_CHARS}
                value={contentSuggestion}
                disabled={submitting}
                onChange={(event) => {
                  setContentSuggestion(event.target.value);
                }}
              />
              <p id="revision-content-scope" className="revision-dialog-scope">只用于本篇重新分析，不进入长期规则；仍记在这篇作文下，供统计。</p>
              <small id="revision-content-count">{contentSuggestion.length} / {MAX_FIELD_CHARS}</small>
            </div>
            {error ? <p className="revision-dialog-error" role="alert">{error}</p> : null}
          </div>
          <div className="revision-dialog-actions">
            <button type="button" className="button button--quiet" disabled={submitting} onClick={onClose}>取消</button>
            <button
              type="button"
              className="button button--danger"
              disabled={submitting || !withinLimit}
              aria-busy={submitting}
              onClick={() => {
                if (submitting || !withinLimit) return;
                onReject({ commonIssue, contentSuggestion });
              }}
            >完全不能用</button>
            <button type="submit" className="button button--primary" disabled={!valid || submitting} aria-busy={submitting}>提交后台修改并继续</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
