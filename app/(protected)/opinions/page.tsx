"use client";

import { useEffect, useState } from "react";

import { AppHeader } from "../../components/AppHeader";
import { AsyncButton } from "../../components/AsyncButton";
import { ErrorBanner } from "../../components/ErrorBanner";
import { apiFetch, errorMessage } from "../../lib/api";

const categories = ["结构", "内容", "语言", "字数", "其他"] as const;
type OpinionCategory = (typeof categories)[number];
type OpinionScope = "standing" | "essay";

interface GradingOpinion {
  id: string;
  text: string;
  scope: OpinionScope | string;
  paragraphLabel: string | null;
  category: OpinionCategory | string;
  sourceStudentName: string;
  sourceClassName: string;
  sourceTitle: string;
  createdAt: string;
}

interface OpinionDraft {
  text: string;
  category: OpinionCategory;
}

function sourceLabel(opinion: GradingOpinion): string {
  return [
    opinion.sourceStudentName || "未填写学生",
    opinion.sourceClassName || "未分类",
    opinion.sourceTitle || "未填写题目",
  ].join(" · ");
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function asCategory(value: string): OpinionCategory {
  return categories.includes(value as OpinionCategory) ? value as OpinionCategory : "其他";
}

function categoryCounts(opinions: GradingOpinion[]): Array<{ category: OpinionCategory; count: number }> {
  return categories.flatMap((category) => {
    const count = opinions.filter((opinion) => asCategory(opinion.category) === category).length;
    return count > 0 ? [{ category, count }] : [];
  });
}

function repeatedTexts(opinions: GradingOpinion[]): Array<{ text: string; count: number }> {
  const counts = new Map<string, { text: string; count: number }>();
  for (const opinion of opinions) {
    const text = opinion.text.trim().replace(/\s+/gu, " ");
    if (!text) continue;
    const key = text.toLocaleLowerCase("zh-CN");
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { text, count: 1 });
  }
  return [...counts.values()].filter((item) => item.count > 1);
}

function OpinionStats({
  label,
  opinions,
}: {
  label: string;
  opinions: GradingOpinion[];
}) {
  const counts = categoryCounts(opinions);
  const repeats = repeatedTexts(opinions);
  return (
    <section className="opinion-stats" aria-label={label}>
      <h2>{label}</h2>
      <span>共 {opinions.length} 条</span>
      {counts.map(({ category, count }) => <span key={category}>{category} {count} 次</span>)}
      {repeats.map((item) => <span key={item.text}>相同内容「{item.text}」{item.count} 次</span>)}
    </section>
  );
}

export default function GradingOpinionsPage() {
  const [opinions, setOpinions] = useState<GradingOpinion[]>([]);
  const [drafts, setDrafts] = useState<Record<string, OpinionDraft>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void apiFetch<GradingOpinion[]>("/api/grading-opinions")
      .then((loaded) => {
        if (!active) return;
        setOpinions(loaded);
        setDrafts(Object.fromEntries(loaded.filter((opinion) => opinion.scope === "standing").map((opinion) => [opinion.id, {
          text: opinion.text,
          category: asCategory(opinion.category),
        }])));
      })
      .catch((caught) => { if (active) setError(errorMessage(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const standing = opinions.filter((opinion) => opinion.scope === "standing");
  const essay = opinions.filter((opinion) => opinion.scope !== "standing");

  function draftOf(opinion: GradingOpinion): OpinionDraft {
    return drafts[opinion.id] ?? {
      text: opinion.text,
      category: asCategory(opinion.category),
    };
  }

  async function save(opinion: GradingOpinion) {
    const draft = draftOf(opinion);
    const text = draft.text.trim();
    if (!text) return;
    if (text === opinion.text && draft.category === asCategory(opinion.category)) return;
    setBusyId(opinion.id);
    setError("");
    try {
      const updated = await apiFetch<GradingOpinion>(`/api/grading-opinions/${encodeURIComponent(opinion.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, category: draft.category }),
      });
      setOpinions((current) => current.map((item) => item.id === opinion.id ? updated : item));
      setDrafts((current) => ({
        ...current,
        [opinion.id]: { text: updated.text, category: asCategory(updated.category) },
      }));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(opinion: GradingOpinion) {
    setBusyId(opinion.id);
    setError("");
    try {
      await apiFetch<{ deleted: boolean }>(`/api/grading-opinions/${encodeURIComponent(opinion.id)}`, { method: "DELETE" });
      setOpinions((current) => current.filter((item) => item.id !== opinion.id));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader compact />
      <main className="narrow-page">
        <div className="page-title">
          <p className="eyebrow">长期批改要求</p>
          <h1>长期批改规则</h1>
          <p>这里只管理退回弹窗第一框「结构问题 / 共性问题」。这些规则对之后所有作文的批改和重新批改生效。第二框「内容建议」只留在对应作文下，不在这里修改。</p>
        </div>
        {error ? <ErrorBanner message={error} /> : null}
        {loading ? <p className="loading-note" role="status">正在读取批改规则…</p> : null}
        {!loading ? <OpinionStats label="长期规则统计" opinions={standing} /> : null}
        {!loading ? <OpinionStats label="仅当前文章统计" opinions={essay} /> : null}
        {!loading && standing.length === 0 ? <p className="muted">还没有长期批改规则。</p> : null}
        <div className="opinion-list">
          {standing.map((opinion) => {
            const draft = draftOf(opinion);
            const unchanged = draft.text.trim() === opinion.text && draft.category === asCategory(opinion.category);
            const incomplete = draft.text.trim() === "";
            return (
              <article className="opinion-card" key={opinion.id}>
                <p className="opinion-card-meta muted">
                  {formatTime(opinion.createdAt)} · {sourceLabel(opinion)}
                  {opinion.paragraphLabel ? ` · ${opinion.paragraphLabel}` : ""}
                </p>
                <label>
                  结构问题 / 共性问题
                  <textarea
                    aria-label={`编辑${sourceLabel(opinion)}的长期规则`}
                    value={draft.text}
                    onChange={(event) => setDrafts((current) => ({
                      ...current,
                      [opinion.id]: { ...draft, text: event.target.value },
                    }))}
                  />
                </label>
                <label>
                  类别
                  <select
                    aria-label={`编辑${sourceLabel(opinion)}的类别`}
                    value={draft.category}
                    onChange={(event) => setDrafts((current) => ({
                      ...current,
                      [opinion.id]: { ...draft, category: asCategory(event.target.value) },
                    }))}
                  >
                    {categories.map((category) => <option key={category} value={category}>{category}</option>)}
                  </select>
                </label>
                <div className="opinion-card-actions">
                  <AsyncButton
                    type="button"
                    className="button button--primary"
                    busy={busyId === opinion.id}
                    busyLabel="正在保存…"
                    disabled={unchanged || incomplete || busyId !== null}
                    onClick={() => void save(opinion)}
                  >
                    保存修改
                  </AsyncButton>
                  <button
                    type="button"
                    className="button button--danger-quiet"
                    disabled={busyId !== null}
                    onClick={() => void remove(opinion)}
                  >
                    删除
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </main>
    </div>
  );
}
