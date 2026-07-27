"use client";

import { useState } from "react";

import type { EvaluationReport, ScoreBreakdown, ScoreLevel } from "@/src/domain/contracts";
import { ScoreCard } from "./ScoreCard";

export function scoreSummary(values: readonly number[]): { total: number; level: ScoreLevel } {
  const total = values.reduce((sum, value) => sum + value, 0);
  return { total, level: total <= 29 ? "重写" : total <= 35 ? "二类作文" : "优秀作文" };
}

interface ReportEditorProps {
  report: EvaluationReport;
  onChange: (report: EvaluationReport) => void;
  onRewriteFeedback?: (section: FeedbackSection) => Promise<void>;
  rewritingFeedbackSection?: FeedbackSection | null;
  onRewriteSample?: (index: number, instruction?: string) => Promise<void>;
  rewritingSampleIndex?: number | null;
  onRewriteAllSamples?: (instruction?: string) => Promise<void>;
  rewritingAllSamples?: boolean;
}

export type FeedbackSection = "strengths" | "improvements";

const scoreFields = [
  ["themeIntent", "主题立意", 10],
  ["contentSelection", "选材内容", 10],
  ["structure", "篇章结构", 8],
  ["languageExpression", "语言表达", 8],
  ["writingConventions", "书写规范", 4],
] as const;

const pointLabels = ["一", "二", "三", "四", "五", "六"] as const;
const MAX_FEEDBACK_POINTS = pointLabels.length;

function normalisedScores(scores: ScoreBreakdown, themeFit: EvaluationReport["themeFit"]): ScoreBreakdown {
  const next = { ...scores };
  if (themeFit === "off_topic") {
    let excess = Math.max(0, scoreFields.reduce((sum, [field]) => sum + next[field], 0) - 29);
    for (const [field] of [...scoreFields].reverse()) {
      const deduction = Math.min(excess, next[field]);
      next[field] -= deduction;
      excess -= deduction;
    }
  }
  return { ...next, ...scoreSummary(scoreFields.map(([field]) => next[field])) };
}

export function ReportEditor({
  report,
  onChange,
  onRewriteFeedback,
  rewritingFeedbackSection = null,
  onRewriteSample,
  rewritingSampleIndex = null,
  onRewriteAllSamples,
  rewritingAllSamples = false,
}: ReportEditorProps) {
  const [rewriteInstructions, setRewriteInstructions] = useState<string[]>([]);
  const [rewriteAllInstruction, setRewriteAllInstruction] = useState("");
  function update<K extends keyof EvaluationReport>(key: K, value: EvaluationReport[K]) {
    onChange({ ...report, [key]: value });
  }

  function updateScore(key: (typeof scoreFields)[number][0], raw: string, maximum: number) {
    const value = Math.max(0, Math.min(maximum, Math.trunc(Number(raw) || 0)));
    const items = { ...report.scores, [key]: value };
    onChange({ ...report, scores: normalisedScores(items, report.themeFit) });
  }

  function updateSample(index: number, change: Partial<EvaluationReport["sampleParagraphs"][number]>) {
    const sampleParagraphs = report.sampleParagraphs.map((sample, sampleIndex) =>
      sampleIndex === index ? { ...sample, ...change } : sample,
    );
    update("sampleParagraphs", sampleParagraphs);
  }

  function updateThemeFit(themeFit: EvaluationReport["themeFit"]) {
    onChange({ ...report, themeFit, scores: normalisedScores(report.scores, themeFit) });
  }

  const strengths = report.personalizedComment.split(/\r?\n/u).slice(0, MAX_FEEDBACK_POINTS);
  const improvements = (report.painPoints.length > 0 ? report.painPoints : [""]).slice(0, MAX_FEEDBACK_POINTS);

  function updateStrengths(items: string[]) {
    update("personalizedComment", items.join("\n"));
  }

  function updateImprovements(items: string[]) {
    update("painPoints", items);
  }

  return (
    <div className="report-editor">
      <section className="report-section report-theme" aria-labelledby="theme-report-heading">
        <div className="report-section-heading"><div><p className="eyebrow">审题诊断</p><h2 id="theme-report-heading">主题判断</h2></div><select aria-label="主题判断" value={report.themeFit} onChange={(event) => updateThemeFit(event.target.value as EvaluationReport["themeFit"])}><option value="fits">切合题意</option><option value="partial">部分切题</option><option value="off_topic">偏离题意</option></select></div>
        <label>判断依据<textarea aria-label="主题判断依据" value={report.themeReason} onChange={(event) => update("themeReason", event.target.value)} /></label>
      </section>

      <section className="report-section summary-points-editor" aria-labelledby="strengths-heading">
        <div className="summary-editor-heading">
          <h2 id="strengths-heading">优点</h2>
          {onRewriteFeedback ? <button type="button" disabled={rewritingFeedbackSection !== null} onClick={() => void onRewriteFeedback("strengths")}>{rewritingFeedbackSection === "strengths" ? "AI 正在生成…" : "AI 重新生成优点"}</button> : null}
        </div>
        <div className="summary-point-list">
          {strengths.map((item, index) => (
            <div className="summary-point-row" key={`strength-${index}`}>
              <span>{pointLabels[index]}、</span>
              <input
                aria-label={`优点${pointLabels[index]}`}
                minLength={10}
                maxLength={20}
                value={item}
                onChange={(event) => {
                  const next = [...strengths];
                  next[index] = event.target.value;
                  updateStrengths(next);
                }}
              />
              <button type="button" className="summary-point-delete" aria-label={`删除优点${pointLabels[index]}`} disabled={strengths.length <= 1} onClick={() => updateStrengths(strengths.filter((_, itemIndex) => itemIndex !== index))}>删除</button>
            </div>
          ))}
        </div>
        <div className="summary-point-actions"><button type="button" aria-label="新增优点" disabled={strengths.length >= MAX_FEEDBACK_POINTS} onClick={() => updateStrengths([...strengths, ""])}>＋ 新增优点</button></div>
      </section>

      <section className="report-section summary-points-editor" aria-labelledby="improvements-heading">
        <div className="summary-editor-heading">
          <h2 id="improvements-heading">需要修改</h2>
          {onRewriteFeedback ? <button type="button" disabled={rewritingFeedbackSection !== null} onClick={() => void onRewriteFeedback("improvements")}>{rewritingFeedbackSection === "improvements" ? "AI 正在生成…" : "AI 重新生成需要修改"}</button> : null}
        </div>
        <div className="summary-point-list">
          {improvements.map((item, index) => (
            <div className="summary-point-row" key={`improvement-${index}`}>
              <span>{pointLabels[index]}、</span>
              <input
                aria-label={`需要修改${pointLabels[index]}`}
                minLength={10}
                maxLength={20}
                value={item}
                onChange={(event) => {
                  const next = [...improvements];
                  next[index] = event.target.value;
                  update("painPoints", next);
                }}
              />
              <button type="button" className="summary-point-delete" aria-label={`删除需要修改${pointLabels[index]}`} disabled={improvements.length <= 1} onClick={() => updateImprovements(improvements.filter((_, itemIndex) => itemIndex !== index))}>删除</button>
            </div>
          ))}
        </div>
        <div className="summary-point-actions"><button type="button" aria-label="新增需要修改" disabled={improvements.length >= MAX_FEEDBACK_POINTS} onClick={() => updateImprovements([...improvements, ""])}>＋ 新增需要修改</button></div>
      </section>

      <section className="report-section" aria-labelledby="score-heading">
        <div className="score-layout"><div><p className="eyebrow">五项评分</p><h2 id="score-heading">分项得分</h2><div className="score-inputs">{scoreFields.map(([field, label, max]) => <label key={field}>{label}（0-{max}）<input aria-label={`${label}（0-${max}）`} type="number" min={0} max={max} value={report.scores[field]} onChange={(event) => updateScore(field, event.target.value, max)} /></label>)}</div></div><ScoreCard scores={report.scores} /></div>
      </section>

      <section className="report-section" aria-labelledby="samples-heading">
        <p className="eyebrow">可直接借鉴</p><h2 id="samples-heading">示范段落</h2><p className="muted">每段保留示范正文和对应的修改建议；内置题目固定为五段。</p>
        {onRewriteAllSamples ? <div className="sample-ai-all-actions">
          <div><b>AI 整体优化</b><small>一次重写五段示范文，统一人物、事件、转折和结尾。</small></div>
          <label>AI 整体修改要求（可选）<input aria-label="AI 整体修改要求" value={rewriteAllInstruction} placeholder="例如：让礼物线索贯穿全文，删去无关人物" onChange={(event) => setRewriteAllInstruction(event.target.value)} /></label>
          <div className="sample-ai-all-buttons">
            <button type="button" disabled={rewritingAllSamples || rewritingSampleIndex !== null} onClick={() => void onRewriteAllSamples()}>AI 全文重新生成</button>
            <button type="button" disabled={rewritingAllSamples || rewritingSampleIndex !== null || !rewriteAllInstruction.trim()} onClick={() => void onRewriteAllSamples(rewriteAllInstruction)}>{rewritingAllSamples ? "AI 正在生成…" : "AI 按整体要求修改"}</button>
          </div>
        </div> : null}
        <div className="sample-list">{report.sampleParagraphs.map((sample, index) => (
          <fieldset className="sample-card" key={index}><legend>第 {index + 1} 段</legend><label>标题<input value={sample.title} onChange={(event) => updateSample(index, { title: event.target.value })} /></label><label>示范正文<textarea value={sample.text} onChange={(event) => updateSample(index, { text: event.target.value })} /></label>{onRewriteSample ? <div className="sample-ai-actions"><label>AI 修改要求（可选）<input aria-label={`第 ${index + 1} 段 AI 修改要求`} value={rewriteInstructions[index] ?? ""} placeholder="例如：把开头写得更紧张" onChange={(event) => setRewriteInstructions((current) => { const next = [...current]; next[index] = event.target.value; return next; })} /></label><div><button type="button" disabled={rewritingAllSamples || rewritingSampleIndex !== null} onClick={() => void onRewriteSample(index)}>AI 重新生成</button><button type="button" disabled={rewritingAllSamples || rewritingSampleIndex !== null || !(rewriteInstructions[index] ?? "").trim()} onClick={() => void onRewriteSample(index, rewriteInstructions[index])}>{rewritingSampleIndex === index ? "AI 正在修改…" : "AI 按要求修改"}</button></div></div> : null}<label>修改建议<textarea value={sample.suggestion} onChange={(event) => updateSample(index, { suggestion: event.target.value })} /></label></fieldset>
        ))}</div>
      </section>
    </div>
  );
}
