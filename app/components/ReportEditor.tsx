"use client";

import type { EvaluationReport, ScoreLevel } from "@/src/domain/contracts";
import { ScoreCard } from "./ScoreCard";

export function scoreSummary(values: readonly number[]): { total: number; level: ScoreLevel } {
  const total = values.reduce((sum, value) => sum + value, 0);
  return { total, level: total <= 29 ? "重写" : total <= 35 ? "二类作文" : "优秀作文" };
}

interface ReportEditorProps {
  report: EvaluationReport;
  onChange: (report: EvaluationReport) => void;
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

interface SampleParts { title: string; body: string; suggestion: string }

function sampleParts(value: string, index: number): SampleParts {
  const match = value.match(/^【标题】([^\n]*)\n【正文】([\s\S]*?)\n【修改建议】([\s\S]*)$/);
  return match
    ? { title: match[1], body: match[2], suggestion: match[3] }
    : { title: `第 ${index + 1} 段`, body: value, suggestion: "" };
}

function encodeSample(parts: SampleParts) {
  return `【标题】${parts.title}\n【正文】${parts.body}\n【修改建议】${parts.suggestion}`;
}

export function ReportEditor({ report, onChange }: ReportEditorProps) {
  function update<K extends keyof EvaluationReport>(key: K, value: EvaluationReport[K]) {
    onChange({ ...report, [key]: value });
  }

  function updateScore(key: (typeof scoreFields)[number][0], raw: string, maximum: number) {
    const value = Math.max(0, Math.min(maximum, Number(raw) || 0));
    const items = { ...report.scores, [key]: value };
    const summary = scoreSummary(scoreFields.map(([field]) => items[field]));
    onChange({ ...report, scores: { ...items, ...summary } });
  }

  function updateSample(index: number, change: Partial<SampleParts>) {
    const sampleParagraphs = report.sampleParagraphs.map((sample, sampleIndex) =>
      sampleIndex === index ? encodeSample({ ...sampleParts(sample, index), ...change }) : sample,
    );
    update("sampleParagraphs", sampleParagraphs);
  }

  return (
    <div className="report-editor">
      <section className="report-section report-theme" aria-labelledby="theme-report-heading">
        <div className="report-section-heading"><div><p className="eyebrow">审题诊断</p><h2 id="theme-report-heading">主题判断</h2></div><select aria-label="主题判断" value={report.themeFit} onChange={(event) => update("themeFit", event.target.value as EvaluationReport["themeFit"])}><option value="fits">切合题意</option><option value="partial">部分切题</option><option value="off_topic">偏离题意</option></select></div>
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
        <div className="sample-list">{report.sampleParagraphs.map((sample, index) => {
          const parts = sampleParts(sample, index);
          return <fieldset className="sample-card" key={index}><legend>第 {index + 1} 段</legend><label>标题<input value={parts.title} onChange={(event) => updateSample(index, { title: event.target.value })} /></label><label>示范正文<textarea value={parts.body} onChange={(event) => updateSample(index, { body: event.target.value })} /></label><label>修改建议<textarea value={parts.suggestion} onChange={(event) => updateSample(index, { suggestion: event.target.value })} /></label></fieldset>;
        })}</div>
      </section>
    </div>
  );
}
