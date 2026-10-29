import { guidanceWithStandingOpinions, STANDING_GUIDANCE_HEADER, type StandingOpinionInput } from "./standing-guidance";

interface GuidanceLayers { current: string; history: string; standing: string }
const PREFIX = "review-guidance-v1:";

/** Only the most recent revision round remains active; previous rounds stay in the archive. */
export function composeReviewGuidance(
  current: string | null | undefined,
  standing: readonly StandingOpinionInput[],
  history: readonly StandingOpinionInput[],
): string | null {
  const latest = Math.max(...history.map((item) => item.createdAt));
  const layers: GuidanceLayers = {
    current: current?.trim() ?? "",
    history: history.filter((item) => item.createdAt === latest).map((item) => item.text).join("\n"),
    standing: guidanceWithStandingOpinions(null, standing) ?? "",
  };
  if (!layers.current && !layers.history && !layers.standing) return null;
  // Budget whole fields without cutting serialized JSON. Drop lowest priority characters first.
  for (const key of ["standing", "history"] as const) {
    while ((PREFIX + JSON.stringify(layers)).length > 4000 && layers[key]) {
      layers[key] = layers[key].slice(0, -1);
    }
  }
  return (PREFIX + JSON.stringify(layers)).length <= 4000 ? PREFIX + JSON.stringify(layers) : layers.current;
}

export function readReviewGuidance(raw?: string | null): GuidanceLayers & { constraints: string } {
  // Treat malformed/ordinary text as a direct submission, even if it starts with our marker.
  const index = raw?.indexOf(STANDING_GUIDANCE_HEADER) ?? -1;
  let layers: GuidanceLayers = { current: (index >= 0 ? raw!.slice(0, index) : raw ?? "").trim(), history: "", standing: index >= 0 ? raw!.slice(index) : "" };
  if (raw?.startsWith(PREFIX)) {
    try {
      const parsed: unknown = JSON.parse(raw.slice(PREFIX.length));
      if (parsed && typeof parsed === "object" && "current" in parsed && "history" in parsed && "standing" in parsed
        && typeof parsed.current === "string" && typeof parsed.history === "string" && typeof parsed.standing === "string") {
        layers = { current: parsed.current, history: parsed.history, standing: parsed.standing };
      }
    } catch { /* A teacher's literal text need not be JSON. */ }
  }
  return { ...layers, constraints: layers.current };
}

export function guidanceForPrompt(raw?: string | null): string {
  const { current, history, standing } = readReviewGuidance(raw);
  return [
    standing ? `[本题长期规则；仅作上下文，与本轮或当前框架冲突时已被替代]\n${standing}` : "",
    history ? `[最近一次本篇要求；仅作上下文，与本轮或当前框架冲突时已被替代，之前轮次已归档不再生效]\n${history}` : "",
    current ? `[本轮要求，最高优先级]\n${current}` : "",
  ].filter(Boolean).join("\n\n");
}
