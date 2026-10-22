"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

const MAX_FIELD_CHARS = 500;

export interface RevisionRequestDialogProps {
  open: boolean;
  submitting: boolean;
  error: string;
  onClose(): void;
  onSubmit(input: { commonIssue: string; contentSuggestion: string }): void;
  onReject(input: { commonIssue: string; contentSuggestion: string }): void;
}

export function RevisionRequestDialog({
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
            <label className="revision-dialog-field">
              <span>结构问题 / 共性问题（仅同名作文）</span>
              <textarea
                ref={commonIssueRef}
                aria-label="结构问题 / 共性问题（仅同名作文）"
                maxLength={MAX_FIELD_CHARS}
                value={commonIssue}
                disabled={submitting}
                onChange={(event) => setCommonIssue(event.target.value)}
              />
              <p className="revision-dialog-scope">永久存档为这个题目的长期批改规则，只对题目相同的作文生效，本篇重新分析也会用到。</p>
              <small>{commonIssue.length} / {MAX_FIELD_CHARS}</small>
            </label>
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
