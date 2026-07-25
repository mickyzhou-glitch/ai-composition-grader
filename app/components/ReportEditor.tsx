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
  onRewriteSample?: (index: number, instruction?: string) => Promise<void>;
  rewritingSampleIndex?: number | null;
}

const scoreFields = [
  ["themeIntent", "主题立意", 10],
  ["contentSelection", "选材内容", 10],
  ["structure", "篇章结构", 8],
  ["languageExpression", "语言表达", 8],
  ["writingConventions", "书写规范", 4],
] as const;

function lines(value: string[]) { return value.join("\n"); }
function asLines(value: string) { return value.split("\n").map((item) => item.trim()).filter(Boolean); }

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

export function ReportEditor({ report, onChange, onRewriteSample, rewritingSampleIndex = null }: ReportEditorProps) {
  const [rewriteInstructions, setRewriteInstructions] = useState<string[]>([]);
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

  return (
    <div className="report-editor">
      <section className="report-section report-theme" aria-labelledby="theme-report-heading">
        <div className="report-section-heading"><div><p className="eyebrow">审题诊断</p><h2 id="theme-report-heading">主题判断</h2></div><select aria-label="主题判断" value={report.themeFit} onChange={(event) => updateThemeFit(event.target.value as EvaluationReport["themeFit"])}><option value="fits">切合题意</option><option value="partial">部分切题</option><option value="off_topic">偏离题意</option></select></div>
        <label>判断依据<textarea aria-label="主题判断依据" value={report.themeReason} onChange={(event) => update("themeReason", event.target.value)} /></label>
      </section>

      <section className="report-section">
        <p className="eyebrow">写给学生</p><h2 id="comment-heading">个性评语</h2>
        <label className="visually-hidden" htmlFor="personalized-comment">个性评语</label>
        <textarea id="personalized-comment" aria-label="个性评语" value={report.personalizedComment} onChange={(event) => update("personalizedComment", event.target.value)} />
      </section>

      <section className="report-section report-arrays" aria-label="问题与建议">
        {(["painPoints", "commonIssues", "revisionSuggestions"] as const).map((field) => {
          const labels = { painPoints: "关键痛点", commonIssues: "共性问题", revisionSuggestions: "修改建议" };
          return <label key={field}>{labels[field]}<small>每行一项</small><textarea value={lines(report[field])} onChange={(event) => update(field, asLines(event.target.value))} /></label>;
        })}
      </section>

      <section className="report-section" aria-labelledby="score-heading">
        <div className="score-layout"><div><p className="eyebrow">五项评分</p><h2 id="score-heading">分项得分</h2><div className="score-inputs">{scoreFields.map(([field, label, max]) => <label key={field}>{label}（0-{max}）<input aria-label={`${label}（0-${max}）`} type="number" min={0} max={max} value={report.scores[field]} onChange={(event) => updateScore(field, event.target.value, max)} /></label>)}</div></div><ScoreCard scores={report.scores} /></div>
      </section>

      <section className="report-section" aria-labelledby="samples-heading">
        <p className="eyebrow">可直接借鉴</p><h2 id="samples-heading">示范段落</h2><p className="muted">每段保留示范正文和对应的修改建议；内置题目固定为五段。</p>
        <div className="sample-list">{report.sampleParagraphs.map((sample, index) => (
          <fieldset className="sample-card" key={index}><legend>第 {index + 1} 段</legend><label>标题<input value={sample.title} onChange={(event) => updateSample(index, { title: event.target.value })} /></label><label>示范正文<textarea value={sample.text} onChange={(event) => updateSample(index, { text: event.target.value })} /></label>{onRewriteSample ? <div className="sample-ai-actions"><label>AI 修改要求（可选）<input aria-label={`第 ${index + 1} 段 AI 修改要求`} value={rewriteInstructions[index] ?? ""} placeholder="例如：把开头写得更紧张" onChange={(event) => setRewriteInstructions((current) => { const next = [...current]; next[index] = event.target.value; return next; })} /></label><div><button type="button" disabled={rewritingSampleIndex !== null} onClick={() => void onRewriteSample(index)}>AI 重新生成</button><button type="button" disabled={rewritingSampleIndex !== null || !(rewriteInstructions[index] ?? "").trim()} onClick={() => void onRewriteSample(index, rewriteInstructions[index])}>{rewritingSampleIndex === index ? "AI 正在修改…" : "AI 按要求修改"}</button></div></div> : null}<label>修改建议<textarea value={sample.suggestion} onChange={(event) => updateSample(index, { suggestion: event.target.value })} /></label></fieldset>
        ))}</div>
      </section>
    </div>
  );
}
