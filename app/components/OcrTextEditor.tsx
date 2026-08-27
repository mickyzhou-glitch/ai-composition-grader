"use client";

import { useState } from "react";

import type { ReviewView } from "../lib/types";
import { apiFetch, errorMessage } from "../lib/api";
import { AsyncButton } from "./AsyncButton";

type OcrView = NonNullable<ReviewView["ocr"]>;

export function OcrTextEditor({
  reviewId,
  ocr,
  disabled,
  onSaved,
}: {
  reviewId: string;
  ocr: OcrView;
  disabled: boolean;
  onSaved: (review: ReviewView) => void;
}) {
  const paragraphs = ocr.version === 2 ? ocr.paragraphs : [];
  const [texts, setTexts] = useState(() => paragraphs.map(({ text }) => text));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = texts.some((text, index) => text !== paragraphs[index]?.text);

  async function save() {
    if (!dirty || disabled || saving) return;
    setSaving(true);
    setError("");
    try {
      const review = await apiFetch<ReviewView>(`/api/reviews/${encodeURIComponent(reviewId)}/ocr`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedOcrRevision: ocr.ocrRevision,
          paragraphs: texts.map((text, index) => ({
            paragraphId: paragraphs[index].id,
            text,
          })),
        }),
      });
      onSaved(review);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  if (ocr.version === 1) {
    return (
      <section className="ocr-editor" aria-label="识别原文编辑器">
        <p><strong>需要完整重新识别</strong></p>
        <p>该识别原文是旧版逐页结构，重新识别后才能按自然段复核。</p>
        {ocr.pages.map((page) => <p key={page.pageIndex}>{page.text}</p>)}
      </section>
    );
  }

  return (
    <section className="ocr-editor" aria-label="识别原文编辑器">
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      <div className="ocr-page-grid">
        {paragraphs.map((paragraph, index) => (
          <label className="ocr-page" key={paragraph.id}>
            <span>第 {paragraph.paragraphIndex + 1} 段</span>
            <textarea
              aria-label={`第 ${paragraph.paragraphIndex + 1} 段识别原文`}
              value={texts[index] ?? ""}
              disabled={disabled || saving}
              onChange={(event) => setTexts((current) =>
                current.map((text, textIndex) => textIndex === index ? event.target.value : text))}
            />
          </label>
        ))}
      </div>
      <div className="form-actions">
        <AsyncButton
          className="button button--primary"
          busy={saving}
          busyLabel="保存中…"
          disabled={!dirty || disabled || saving}
          onClick={() => void save()}
        >保存识别原文</AsyncButton>
      </div>
    </section>
  );
}
