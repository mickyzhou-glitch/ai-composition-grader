"use client";

import { useEffect, useState } from "react";

import { AppHeader } from "../../components/AppHeader";
import { AsyncButton } from "../../components/AsyncButton";
import { ErrorBanner } from "../../components/ErrorBanner";
import { apiFetch, errorMessage } from "../../lib/api";

const categories = ["结构", "内容", "语言", "字数", "其他"] as const;
type OpinionCategory = (typeof categories)[number];

interface GradingOpinion {
  id: string;
  reason: string;
  changeRequest: string;
  paragraphLabel: string | null;
  category: OpinionCategory | string;
  sourceStudentName: string;
  sourceClassName: string;
  sourceTitle: string;
  createdAt: string;
}

interface OpinionDraft {
  reason: string;
  changeRequest: string;
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

function repeatedChanges(opinions: GradingOpinion[]): Array<{ text: string; count: number }> {
  const counts = new Map<string, { text: string; count: number }>();
  for (const opinion of opinions) {
    const text = opinion.changeRequest.trim().replace(/\s+/gu, " ");
    if (!text) continue;
    const key = text.toLocaleLowerCase("zh-CN");
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { text, count: 1 });
  }
  return [...counts.values()].filter((item) => item.count > 1);
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
        setDrafts(Object.fromEntries(loaded.map((opinion) => [opinion.id, {
          reason: opinion.reason,
          changeRequest: opinion.changeRequest,
          category: asCategory(opinion.category),
        }])));
      })
      .catch((caught) => { if (active) setError(errorMessage(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  function draftOf(opinion: GradingOpinion): OpinionDraft {
    return drafts[opinion.id] ?? {
      reason: opinion.reason,
      changeRequest: opinion.changeRequest,
      category: asCategory(opinion.category),
    };
  }

  async function save(opinion: GradingOpinion) {
    const draft = draftOf(opinion);
    const reason = draft.reason.trim();
    const changeRequest = draft.changeRequest.trim();
    if (!reason || !changeRequest) return;
    if (
      reason === opinion.reason
      && changeRequest === opinion.changeRequest
      && draft.category === asCategory(opinion.category)
    ) return;
    setBusyId(opinion.id);
    setError("");
    try {
      const updated = await apiFetch<GradingOpinion>(`/api/grading-opinions/${encodeURIComponent(opinion.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason, changeRequest, category: draft.category }),
      });
      setOpinions((current) => current.map((item) => item.id === opinion.id ? updated : item));
      setDrafts((current) => ({
        ...current,
        [opinion.id]: {
          reason: updated.reason,
          changeRequest: updated.changeRequest,
          category: asCategory(updated.category),
        },
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

  const counts = categoryCounts(opinions);
  const repeats = repeatedChanges(opinions);

  return (
    <div className="app-shell">
      <AppHeader compact />
      <main className="narrow-page">
        <div className="page-title">
          <p className="eyebrow">长期批改要求</p>
          <h1>批改意见存档</h1>
          <p>批量审核里点「不合适」后，按「提交后台修改并继续」写下的两项说明会留在这里。之后这位老师的新批改和重新批改都会带上归纳后的规则。</p>
        </div>
        {error ? <ErrorBanner message={error} /> : null}
        {loading ? <p className="loading-note" role="status">正在读取批改意见…</p> : null}
        {!loading && opinions.length === 0 ? <p className="muted">还没有存档的批改意见。</p> : null}
        {!loading && opinions.length > 0 ? (
          <section className="opinion-stats" aria-label="批改意见统计">
            <span>共 {opinions.length} 条</span>
            {counts.map(({ category, count }) => <span key={category}>{category} {count} 次</span>)}
            {repeats.map((item) => <span key={item.text}>相同改法「{item.text}」{item.count} 次</span>)}
          </section>
        ) : null}
        <div className="opinion-list">
          {opinions.map((opinion) => {
            const draft = draftOf(opinion);
            const unchanged = draft.reason.trim() === opinion.reason
              && draft.changeRequest.trim() === opinion.changeRequest
              && draft.category === asCategory(opinion.category);
            const incomplete = draft.reason.trim() === "" || draft.changeRequest.trim() === "";
            return (
              <article className="opinion-card" key={opinion.id}>
                <p className="opinion-card-meta muted">
                  {formatTime(opinion.createdAt)} · {sourceLabel(opinion)}
                  {opinion.paragraphLabel ? ` · ${opinion.paragraphLabel}` : ""}
                </p>
                <label>
                  为什么不合适
                  <textarea
                    aria-label={`编辑${sourceLabel(opinion)}的为什么不合适`}
                    value={draft.reason}
                    onChange={(event) => setDrafts((current) => ({
                      ...current,
                      [opinion.id]: { ...draft, reason: event.target.value },
                    }))}
                  />
                </label>
                <label>
                  应该怎么改
                  <textarea
                    aria-label={`编辑${sourceLabel(opinion)}的应该怎么改`}
                    value={draft.changeRequest}
                    onChange={(event) => setDrafts((current) => ({
                      ...current,
                      [opinion.id]: { ...draft, changeRequest: event.target.value },
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
