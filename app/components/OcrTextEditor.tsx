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
  const [texts, setTexts] = useState(() => ocr.pages.map(({ text }) => text));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = texts.some((text, index) => text !== ocr.pages[index]?.text);

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
          pages: texts.map((text, pageIndex) => ({ pageIndex, text })),
        }),
      });
      onSaved(review);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="ocr-editor" aria-label="识别原文编辑器">
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      <div className="ocr-page-grid">
        {ocr.pages.map((page, index) => (
          <label className="ocr-page" key={page.pageIndex}>
            <span>第 {page.pageIndex + 1} 页</span>
            <textarea
              aria-label={`第 ${page.pageIndex + 1} 页识别原文`}
              value={texts[index] ?? ""}
              disabled={disabled || saving}
              onChange={(event) => setTexts((current) =>
                current.map((text, textIndex) => textIndex === index ? event.target.value : text))}
            />
            {page.warnings.length > 0 ? <small>{page.warnings.join("；")}</small> : null}
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
