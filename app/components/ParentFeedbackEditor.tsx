"use client";

import { useState } from "react";

import type { ParentFeedback, ParentFeedbackStyle } from "@/src/domain/contracts";

export interface ParentFeedbackEditorProps {
  feedbacks: ParentFeedback[];
  savedFeedbacks: ParentFeedback[];
  disabled: boolean;
  onChange: (feedbacks: ParentFeedback[]) => void;
  onCopySuccess: () => void;
  onCopyError: () => void;
}

function tabId(style: ParentFeedbackStyle) {
  return `parent-feedback-tab-${style}`;
}

function panelId(style: ParentFeedbackStyle) {
  return `parent-feedback-panel-${style}`;
}

export function ParentFeedbackEditor({
  feedbacks,
  savedFeedbacks,
  disabled,
  onChange,
  onCopySuccess,
  onCopyError,
}: ParentFeedbackEditorProps) {
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
    <section aria-labelledby="parent-feedback-heading">
      <h2 id="parent-feedback-heading">给家长的反馈</h2>
      {feedbacks.length === 0 ? <p>暂无家长反馈，请重新分析作文后生成。</p> : (
        <>
          <p>已生成 3 份，可选择后修改</p>
          <div role="tablist" aria-label="家长反馈版本">
            {feedbacks.map((feedback) => (
              <button
                key={feedback.style}
                type="button"
                role="tab"
                id={tabId(feedback.style)}
                aria-selected={feedback.style === activeFeedback.style}
                aria-controls={panelId(feedback.style)}
                onClick={() => setActiveStyle(feedback.style)}
              >
                {feedback.title}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={panelId(activeFeedback.style)}
            aria-labelledby={tabId(activeFeedback.style)}
          >
            <label htmlFor={`parent-feedback-content-${activeFeedback.style}`}>
              {`${activeFeedback.title}家长反馈`}
            </label>
            <textarea
              id={`parent-feedback-content-${activeFeedback.style}`}
              aria-label={`${activeFeedback.title}家长反馈`}
              value={activeFeedback.content}
              disabled={disabled}
              onChange={(event) => updateActiveContent(event.target.value)}
            />
            <div>
              <button
                type="button"
                disabled={disabled || !savedActiveFeedback || savedActiveFeedback.content === activeFeedback.content}
                onClick={() => updateActiveContent(savedActiveFeedback?.content ?? activeFeedback.content)}
              >
                恢复原文
              </button>
              <button
                type="button"
                disabled={disabled || !activeFeedback.content.trim()}
                onClick={() => void copyActiveFeedback()}
              >
                复制反馈
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
