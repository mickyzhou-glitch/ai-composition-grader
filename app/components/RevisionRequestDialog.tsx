"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

const MAX_FIELD_CHARS = 500;

export interface RevisionRequestDialogProps {
  open: boolean;
  submitting: boolean;
  error: string;
  onClose(): void;
  onSubmit(input: { reason: string; changeRequest: string }): void;
}

export function RevisionRequestDialog({
  open,
  submitting,
  error,
  onClose,
  onSubmit,
}: RevisionRequestDialogProps) {
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState("");
  const [changeRequest, setChangeRequest] = useState("");

  useEffect(() => {
    if (open) reasonRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const valid = reason.trim().length > 0 &&
    changeRequest.trim().length > 0 &&
    reason.length <= MAX_FIELD_CHARS &&
    changeRequest.length <= MAX_FIELD_CHARS;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !submitting) {
      event.preventDefault();
      onClose();
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || submitting) return;
    onSubmit({ reason: reason.trim(), changeRequest: changeRequest.trim() });
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
              <span>为什么不合适</span>
              <textarea
                ref={reasonRef}
                aria-label="为什么不合适"
                aria-required="true"
                required
                maxLength={MAX_FIELD_CHARS}
                value={reason}
                disabled={submitting}
                onChange={(event) => setReason(event.target.value)}
              />
              <small>{reason.length} / {MAX_FIELD_CHARS}</small>
            </label>
            <label className="revision-dialog-field">
              <span>应该怎么改</span>
              <textarea
                aria-label="应该怎么改"
                aria-required="true"
                required
                maxLength={MAX_FIELD_CHARS}
                value={changeRequest}
                disabled={submitting}
                onChange={(event) => setChangeRequest(event.target.value)}
              />
              <small>{changeRequest.length} / {MAX_FIELD_CHARS}</small>
            </label>
            {error ? <p className="revision-dialog-error" role="alert">{error}</p> : null}
          </div>
          <div className="revision-dialog-actions">
            <button type="button" className="button button--quiet" disabled={submitting} onClick={onClose}>取消</button>
            <button type="submit" className="button button--primary" disabled={!valid || submitting} aria-busy={submitting}>提交后台修改并继续</button>
          </div>
        </form>
      </div>
    </div>
  );
}
