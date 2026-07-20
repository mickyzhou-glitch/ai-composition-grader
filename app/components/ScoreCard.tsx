import type { ScoreBreakdown } from "@/src/domain/contracts";

export function ScoreCard({ scores }: { scores: ScoreBreakdown }) {
  return (
    <aside className={`score-card score-card--${scores.level === "优秀作文" ? "excellent" : scores.level === "二类作文" ? "second" : "rewrite"}`} aria-label="作文总分">
      <div><strong>{scores.total}</strong><span>/ 40 分</span></div>
      <b>{scores.level}</b>
    </aside>
  );
}
