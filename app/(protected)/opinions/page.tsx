"use client";

import { useEffect, useState } from "react";

import { AppHeader } from "../../components/AppHeader";
import { AsyncButton } from "../../components/AsyncButton";
import { ErrorBanner } from "../../components/ErrorBanner";
import { apiFetch, errorMessage } from "../../lib/api";

interface GradingOpinion {
  id: string;
  body: string;
  sourceStudentName: string;
  sourceClassName: string;
  sourceTitle: string;
  createdAt: string;
  updatedAt: string;
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

export default function GradingOpinionsPage() {
  const [opinions, setOpinions] = useState<GradingOpinion[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void apiFetch<GradingOpinion[]>("/api/grading-opinions")
      .then((loaded) => {
        if (!active) return;
        setOpinions(loaded);
        setDrafts(Object.fromEntries(loaded.map((opinion) => [opinion.id, opinion.body])));
      })
      .catch((caught) => { if (active) setError(errorMessage(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function save(opinion: GradingOpinion) {
    const body = drafts[opinion.id]?.trim() ?? "";
    if (!body || body === opinion.body) return;
    setBusyId(opinion.id);
    setError("");
    try {
      const updated = await apiFetch<GradingOpinion>(`/api/grading-opinions/${encodeURIComponent(opinion.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      setOpinions((current) => current.map((item) => item.id === opinion.id ? updated : item));
      setDrafts((current) => ({ ...current, [opinion.id]: updated.body }));
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
          <h1>批改意见存档</h1>
          <p>批量审核里提交「不合适」或「完全不能用」时写下的说明会留在这里。之后这位老师的新批改和重新批改都会带上这些意见。</p>
        </div>
        {error ? <ErrorBanner message={error} /> : null}
        {loading ? <p className="loading-note" role="status">正在读取批改意见…</p> : null}
        {!loading && opinions.length === 0 ? <p className="muted">还没有存档的批改意见。</p> : null}
        <div className="opinion-list">
          {opinions.map((opinion) => {
            const draft = drafts[opinion.id] ?? opinion.body;
            const unchanged = draft.trim() === opinion.body || draft.trim() === "";
            return (
              <article className="opinion-card" key={opinion.id}>
                <p className="opinion-card-meta muted">{formatTime(opinion.createdAt)} · {sourceLabel(opinion)}</p>
                <label>
                  批改意见
                  <textarea
                    aria-label={`编辑${sourceLabel(opinion)}的批改意见`}
                    value={draft}
                    onChange={(event) => setDrafts((current) => ({ ...current, [opinion.id]: event.target.value }))}
                  />
                </label>
                <div className="opinion-card-actions">
                  <AsyncButton
                    type="button"
                    className="button button--primary"
                    busy={busyId === opinion.id}
                    busyLabel="正在保存…"
                    disabled={unchanged || busyId !== null}
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
