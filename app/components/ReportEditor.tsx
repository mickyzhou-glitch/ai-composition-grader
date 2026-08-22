"use client";

import { useState } from "react";

import { gradeFromLegacyTotal, type CompositionGrade, type Diagnostics, type EvaluationReport } from "@/src/domain/contracts";
import { ScoreCard } from "./ScoreCard";

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

const gradeOptions: Array<{ value: CompositionGrade; label: string }> = [
  { value: "A+", label: "A+ 卓越" },
  { value: "A", label: "A 优秀" },
  { value: "A-", label: "A- 良好" },
  { value: "B+", label: "B+ 有潜力" },
  { value: "B", label: "B 基础达标" },
  { value: "B-", label: "B- 需要重点修改" },
  { value: "C", label: "C 重写" },
];

const diagnosticLabels: Array<[keyof Diagnostics, string, string]> = [
  ["authenticityAndRelevance", "生活常识与真实度", "事件是否符合生活常识，是否有原文证据支撑"],
  ["materialAndDetails", "素材与细节", "素材是否恰当，关键场景是否写出动作、心理和画面"],
  ["structure", "前后逻辑与结构", "事件顺序、因果和段落衔接是否完整清楚"],
  ["language", "语言流畅度", "句子和段落是否自然，是否摆脱时间词开头的流水账"],
];

const pointLabels = ["一", "二", "三", "四", "五", "六"] as const;
const MAX_FEEDBACK_POINTS = pointLabels.length;

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
  const grade = report.grade ?? gradeFromLegacyTotal(report.scores?.total ?? 0);
  const diagnostics: Diagnostics = report.diagnostics ?? {
    authenticityAndRelevance: { finding: report.themeReason, action: "围绕题目补写一处真实经历，让正文能支撑结尾感悟。" },
    materialAndDetails: { finding: "历史报告未保留细节诊断。", action: "选一个关键场景，补写动作、心理和环境中的具体细节。" },
    structure: { finding: "历史报告未保留结构诊断。", action: "按五段式检查开篇、发展、转折、行动和感悟。" },
    language: { finding: "历史报告未保留语言诊断。", action: "把段首时间词改成承接上一段动作或情绪的句子。" },
  };
  const [rewriteInstructions, setRewriteInstructions] = useState<string[]>([]);
  const [rewriteAllInstruction, setRewriteAllInstruction] = useState("");
  function update<K extends keyof EvaluationReport>(key: K, value: EvaluationReport[K]) {
    onChange({ ...report, [key]: value });
  }

  function updateSample(index: number, change: Partial<EvaluationReport["sampleParagraphs"][number]>) {
    const sampleParagraphs = report.sampleParagraphs.map((sample, sampleIndex) =>
      sampleIndex === index ? { ...sample, ...change } : sample,
    );
    update("sampleParagraphs", sampleParagraphs);
  }

  function updateThemeFit(themeFit: EvaluationReport["themeFit"]) {
    onChange({ ...report, themeFit, grade: themeFit === "off_topic" ? "C" : grade, diagnostics });
  }

  function updateGrade(grade: CompositionGrade) {
    onChange({ ...report, grade: report.themeFit === "off_topic" ? "C" : grade, diagnostics });
  }

  function updateDiagnostic<K extends keyof Diagnostics>(key: K, field: "finding" | "action", value: string) {
    onChange({
      ...report,
      grade,
      diagnostics: {
        ...diagnostics,
        [key]: { ...diagnostics[key], [field]: value },
      },
    });
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

      <section className="report-section" aria-labelledby="grade-heading">
        <div className="score-layout"><div><p className="eyebrow">等级评定</p><h2 id="grade-heading">最终等级</h2><label className="grade-select" htmlFor="composition-grade">根据四维诊断评定<select id="composition-grade" aria-label="作文等级" value={grade} onChange={(event) => updateGrade(event.target.value as CompositionGrade)}>{gradeOptions.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></label></div><ScoreCard grade={grade} /></div>
        <div className="diagnostic-grid">{diagnosticLabels.map(([key, label, hint]) => (
          <fieldset className="diagnostic-card" key={key}><legend>{label}</legend><p className="muted">{hint}</p><label>精准定位<textarea aria-label={`${label}精准定位`} value={diagnostics[key].finding} onChange={(event) => updateDiagnostic(key, "finding", event.target.value)} /></label><label>学生下一步怎么改<textarea aria-label={`${label}修改动作`} value={diagnostics[key].action} onChange={(event) => updateDiagnostic(key, "action", event.target.value)} /></label></fieldset>
        ))}</div>
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
