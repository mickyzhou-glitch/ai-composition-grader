import type { StructureAudit } from "@/src/domain/structure-audit";

/** 范文结构复核自动返修后仍未通过时，提示老师逐段核对（分析结果照常保存）。 */
export function StructureAuditBanner({ audit }: { audit: StructureAudit | undefined }) {
  if (!audit || audit.passed) return null;
  const last = audit.rounds.at(-1);
  const failing = last?.paragraphs.filter((item) => !item.pass) ?? [];
  return (
    <div className="stale-report-banner" role="alert">
      <span>
        范文结构复核未完全通过{audit.repairAttempts ? `（已自动返修 ${audit.repairAttempts} 次）` : ""}，请核对后再审核
        {failing.length ? `：${failing.map((item) => `第${item.paragraph}段`).join("、")}` : ""}
        <details>
          <summary>查看复核意见</summary>
          {audit.note ? <p>{audit.note}</p> : null}
          {failing.map((item) => (
            <p key={item.paragraph}>第{item.paragraph}段：{item.failures.join("；")}</p>
          ))}
        </details>
      </span>
    </div>
  );
}
