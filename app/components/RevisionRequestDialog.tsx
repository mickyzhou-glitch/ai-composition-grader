"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

const MAX_FIELD_CHARS = 500;

/** 选中已有规则：追加为新的一行。 */
export function appendRuleText(text: string, rule: string): string {
  const current = text.replace(/\s+$/u, "");
  return current ? `${current}\n${rule}` : rule;
}

/** 取消选中：删掉与该规则完全相同的一行；老师改过的行保留。 */
export function removeRuleText(text: string, rule: string): string {
  const lines = text.split(/\r?\n/u);
  const index = lines.findIndex((line) => line.trim() === rule.trim());
  if (index < 0) return text;
  lines.splice(index, 1);
  return lines.join("\n").replace(/\n{2,}/gu, "\n").replace(/^\n+|\n+$/gu, "");
}

export interface RevisionRequestDialogProps {
  /** 当前题目下已审批通过的长期规则。 */
  standingRules?: string[];
  open: boolean;
  submitting: boolean;
  error: string;
  onClose(): void;
  onSubmit(input: { commonIssue: string; contentSuggestion: string }): void;
  onReject(input: { commonIssue: string; contentSuggestion: string }): void;
}

export function RevisionRequestDialog({
  standingRules = [],
  open,
  submitting,
  error,
  onClose,
  onSubmit,
  onReject,
}: RevisionRequestDialogProps) {
  const commonIssueRef = useRef<HTMLTextAreaElement>(null);
  const [commonIssue, setCommonIssue] = useState("");
  const [contentSuggestion, setContentSuggestion] = useState("");
  const [selectedRules, setSelectedRules] = useState<string[]>([]);

  function toggleRule(rule: string, checked: boolean) {
    setSelectedRules((current) => checked ? [...current, rule] : current.filter((item) => item !== rule));
    setCommonIssue((current) => {
      const next = checked ? appendRuleText(current, rule) : removeRuleText(current, rule);
      return next.slice(0, MAX_FIELD_CHARS);
    });
  }

  useEffect(() => {
    if (open) commonIssueRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const withinLimit = commonIssue.length <= MAX_FIELD_CHARS && contentSuggestion.length <= MAX_FIELD_CHARS;
  const valid = withinLimit && (commonIssue.trim().length > 0 || contentSuggestion.trim().length > 0);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !submitting) {
      event.preventDefault();
      onClose();
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || submitting) return;
    onSubmit({ commonIssue: commonIssue.trim(), contentSuggestion: contentSuggestion.trim() });
  }

  return (
    <div className="revision-dialog-backdrop" role="presentation">
      <div
        className="revision-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="revision-request-title"
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
              <span>结构问题 / 共性问题（仅同名作文）</span>
              {standingRules.length > 0 ? <span className="revision-rule-options" role="group" aria-label="已通过的长期规则">
                {standingRules.map((rule) => <label key={rule}>
                  <input
                    type="checkbox"
                    checked={selectedRules.includes(rule)}
                    disabled={submitting}
                    onChange={(event) => toggleRule(rule, event.target.checked)}
                  />
                  <span>{rule}</span>
                </label>)}
              </span> : null}
              <textarea
                ref={commonIssueRef}
                aria-label="结构问题 / 共性问题（仅同名作文）"
                maxLength={MAX_FIELD_CHARS}
                value={commonIssue}
                disabled={submitting}
                onChange={(event) => setCommonIssue(event.target.value)}
              />
              <p className="revision-dialog-scope">本篇重新分析会用到。可勾选已有规则后再编辑；新写或改过的内容会由 AI 归纳成候选规则，在「长期批改规则」里审批通过后才对同名作文生效。</p>
              <small>{commonIssue.length} / {MAX_FIELD_CHARS}</small>
            </div>
            <label className="revision-dialog-field">
              <span>内容建议（仅当前文章）</span>
              <textarea
                aria-label="内容建议（仅当前文章）"
                maxLength={MAX_FIELD_CHARS}
                value={contentSuggestion}
                disabled={submitting}
                onChange={(event) => setContentSuggestion(event.target.value)}
              />
              <p className="revision-dialog-scope">只用于本篇重新分析，不进入长期规则；仍记在这篇作文下，供统计。</p>
              <small>{contentSuggestion.length} / {MAX_FIELD_CHARS}</small>
            </label>
            {error ? <p className="revision-dialog-error" role="alert">{error}</p> : null}
          </div>
          <div className="revision-dialog-actions">
            <button type="button" className="button button--quiet" disabled={submitting} onClick={onClose}>取消</button>
            <button
              type="button"
              className="button button--danger"
              disabled={submitting}
              aria-busy={submitting}
              onClick={() => {
                if (submitting) return;
                onReject({ commonIssue: commonIssue.trim(), contentSuggestion: contentSuggestion.trim() });
              }}
            >完全不能用</button>
            <button type="submit" className="button button--primary" disabled={!valid || submitting} aria-busy={submitting}>提交后台修改并继续</button>
          </div>
        </form>
      </div>
    </div>
  );
}
