"use client";

import { useId, useState } from "react";

import type { ParentFeedback, ParentFeedbackStyle } from "@/src/domain/contracts";

export interface ParentFeedbackEditorProps {
  feedbacks: ParentFeedback[];
  savedFeedbacks: ParentFeedback[];
  disabled: boolean;
  onChange: (feedbacks: ParentFeedback[]) => void;
  onCopySuccess: () => void;
  onCopyError: () => void;
}

function tabId(instanceId: string, style: ParentFeedbackStyle) {
  return `${instanceId}-tab-${style}`;
}

function panelId(instanceId: string, style: ParentFeedbackStyle) {
  return `${instanceId}-panel-${style}`;
}

export function ParentFeedbackEditor({
  feedbacks,
  savedFeedbacks,
  disabled,
  onChange,
  onCopySuccess,
  onCopyError,
}: ParentFeedbackEditorProps) {
  const instanceId = useId();
  const [activeStyle, setActiveStyle] = useState<ParentFeedbackStyle>("warm");
  const activeFeedback = feedbacks.find((feedback) => feedback.style === activeStyle) ?? feedbacks[0];
  const savedActiveFeedback = activeFeedback
    ? savedFeedbacks.find((feedback) => feedback.style === activeFeedback.style)
    : undefined;

  function updateActiveContent(content: string) {
    if (!activeFeedback) return;
    onChange(feedbacks.map((feedback) => (
      feedback.style === activeFeedback.style ? { ...feedback, content } : feedback
    )));
  }

  async function copyActiveFeedback() {
    if (!activeFeedback || !activeFeedback.content.trim()) return;

    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API is unavailable");
      await navigator.clipboard.writeText(activeFeedback.content);
      onCopySuccess();
    } catch {
      onCopyError();
    }
  }

  return (
    <section className="parent-feedback-panel" aria-labelledby={`${instanceId}-heading`}>
      <div className="parent-feedback-heading">
        <div>
          <p className="eyebrow">家校沟通</p>
          <h2 id={`${instanceId}-heading`}>给家长的反馈</h2>
        </div>
        {feedbacks.length > 0 ? <p>已生成 3 份，可选择后修改</p> : null}
      </div>
      {feedbacks.length === 0 ? <p className="parent-feedback-empty">暂无家长反馈，请重新分析作文后生成。</p> : (
        <>
          <div className="parent-feedback-tabs" role="tablist" aria-label="家长反馈版本">
            {feedbacks.map((feedback) => (
              <button
                className="parent-feedback-tab"
                key={feedback.style}
                type="button"
                role="tab"
                id={tabId(instanceId, feedback.style)}
                aria-selected={feedback.style === activeFeedback.style}
                aria-controls={panelId(instanceId, feedback.style)}
                onClick={() => setActiveStyle(feedback.style)}
              >
                {feedback.title}
              </button>
            ))}
          </div>
          {feedbacks.map((feedback) => {
            const isActive = feedback.style === activeFeedback.style;
            return (
              <div
                className="parent-feedback-editor"
                key={feedback.style}
                role="tabpanel"
                id={panelId(instanceId, feedback.style)}
                aria-labelledby={tabId(instanceId, feedback.style)}
                hidden={!isActive}
              >
                {isActive ? (
                  <>
                    <label htmlFor={`${instanceId}-content-${feedback.style}`}>
                      {`${feedback.title}家长反馈`}
                    </label>
                    <textarea
                      id={`${instanceId}-content-${feedback.style}`}
                      aria-label={`${feedback.title}家长反馈`}
                      value={feedback.content}
                      disabled={disabled}
                      onChange={(event) => updateActiveContent(event.target.value)}
                    />
                    <div className="parent-feedback-actions">
                      <button
                        className="button button--quiet"
                        type="button"
                        disabled={disabled || !savedActiveFeedback || savedActiveFeedback.content === feedback.content}
                        onClick={() => updateActiveContent(savedActiveFeedback?.content ?? feedback.content)}
                      >
                        恢复原文
                      </button>
                      <button
                        className="button button--primary"
                        type="button"
                        disabled={disabled || !feedback.content.trim()}
                        onClick={() => void copyActiveFeedback()}
                      >
                        复制反馈
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}
