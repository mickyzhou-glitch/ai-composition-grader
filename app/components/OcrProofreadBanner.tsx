import { assessOcrProofreading } from "@/src/ocr/ocr-quality";

import type { ReviewView } from "../lib/types";

/** Shown at the top of the review page when the recognized text is likely unreliable. */
export function OcrProofreadBanner({ ocr, onOpenOcr }: { ocr: ReviewView["ocr"]; onOpenOcr?: () => void }) {
  const assessment = assessOcrProofreading(ocr);
  if (!assessment.needsProofread) return null;
  return (
    <div className="stale-report-banner ocr-proofread-banner" role="alert" aria-label="请先校对识别原文">
      <div>
        <b>请先校对识别原文</b>
        <ul>{assessment.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        <span>识别可能有误或有看不清的字（「□」），请先对照原图改正，再审核或重新生成批改。</span>
      </div>
      {onOpenOcr ? <button type="button" className="button button--primary" onClick={onOpenOcr}>去校对识别原文</button> : null}
    </div>
  );
}
