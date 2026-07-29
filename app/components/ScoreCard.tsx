import type { CompositionGrade } from "@/src/domain/contracts";

export function ScoreCard({ grade }: { grade: CompositionGrade }) {
  const tone = grade === "C" ? "rewrite" : grade.startsWith("A") ? "excellent" : "second";
  return (
    <aside className={`score-card score-card--${tone}`} aria-label="作文等级">
      <div><strong>{grade}</strong><span>{grade === "C" ? "需要重写" : "作文等级"}</span></div>
      <b>{grade === "C" ? "重写后再评" : "已完成诊断"}</b>
    </aside>
  );
}
