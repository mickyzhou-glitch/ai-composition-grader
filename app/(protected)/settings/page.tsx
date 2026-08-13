"use client";

import { useEffect, useState } from "react";

import { AppHeader } from "../../components/AppHeader";
import { AsyncButton } from "../../components/AsyncButton";
import { ErrorBanner } from "../../components/ErrorBanner";
import { apiFetch, errorMessage } from "../../lib/api";

type ModelRole = "vision" | "content";
interface SettingsView { baseUrl: string; model: string; keyConfigured: boolean }
type SettingsByRole = Record<ModelRole, SettingsView>;

const defaults: SettingsByRole = {
  vision: { baseUrl: "https://api.openai.com/v1", model: "gpt-5", keyConfigured: false },
  content: { baseUrl: "https://api.openai.com/v1", model: "gpt-5", keyConfigured: false },
};
const labels = {
  vision: { title: "拍照识图模型", prefix: "拍照识图" },
  content: { title: "作文内容模型", prefix: "作文内容" },
} as const;

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsByRole>(defaults);
  const [apiKeys, setApiKeys] = useState<Record<ModelRole, string>>({ vision: "", content: "" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    let active = true;
    void apiFetch<SettingsByRole>("/api/settings")
      .then((loaded) => { if (active) setSettings({ ...defaults, ...loaded }); })
      .catch((caught) => { if (active) setError(errorMessage(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function submit(role: ModelRole, kind: "test" | "save") {
    setBusy(`${role}-${kind}`);
    setError("");
    setSuccess("");
    const body = {
      baseUrl: settings[role].baseUrl,
      model: settings[role].model,
      ...(apiKeys[role] ? { apiKey: apiKeys[role] } : {}),
    };
    try {
      const result = await apiFetch<SettingsView | { connected: true }>(
        `/api/settings/${role}${kind === "test" ? "/test" : ""}`,
        {
          method: kind === "test" ? "POST" : "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (kind === "save") {
        setSettings((current) => ({ ...current, [role]: result as SettingsView }));
        setApiKeys((current) => ({ ...current, [role]: "" }));
      }
      setSuccess(`${labels[role].title}${kind === "test" ? "连接成功" : "已保存"}`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  function update(role: ModelRole, next: Partial<SettingsView>) {
    setSettings((current) => ({ ...current, [role]: { ...current[role], ...next } }));
  }

  return (
    <div className="app-shell">
      <AppHeader compact />
      <main className="narrow-page">
        <div className="page-title"><p className="eyebrow">模型连接</p><h1>设置</h1><p>两个模型独立配置，密钥不会在页面回显。</p></div>
        {error ? <ErrorBanner message={error} /> : null}
        {success ? <div className="success-banner" role="status">{success}</div> : null}
        <div className="model-settings-grid">
          {(["vision", "content"] as const).map((role) => {
            const label = labels[role];
            const value = settings[role];
            return <form className="paper-card form-stack" key={role} onSubmit={(event) => {
              event.preventDefault();
              void submit(role, "save");
            }}>
              <h2>{label.title}</h2>
              <label>{label.prefix}服务地址<input aria-label={`${label.prefix}服务地址`} required type="url" value={value.baseUrl} disabled={loading} onChange={(event) => update(role, { baseUrl: event.target.value })} /></label>
              <label>{label.prefix}模型名称<input aria-label={`${label.prefix}模型名称`} required value={value.model} disabled={loading} onChange={(event) => update(role, { model: event.target.value })} /></label>
              <label>{label.prefix} API Key<input aria-label={`${label.prefix} API Key`} type="password" autoComplete="new-password" value={apiKeys[role]} disabled={loading} placeholder={value.keyConfigured ? "已配置，无需重复填写" : "请输入 API Key"} onChange={(event) => setApiKeys((current) => ({ ...current, [role]: event.target.value }))} /></label>
              <p className="field-help">{value.keyConfigured ? "密钥已配置，留空将继续使用原密钥" : "尚未配置密钥"}</p>
              <div className="form-actions">
                <AsyncButton className="button button--quiet" type="button" busy={busy === `${role}-test`} busyLabel="测试中…" disabled={busy !== null} onClick={() => void submit(role, "test")}>测试{label.title}</AsyncButton>
                <AsyncButton className="button button--primary" type="submit" busy={busy === `${role}-save`} busyLabel="保存中…" disabled={busy !== null}>保存{label.title}</AsyncButton>
              </div>
            </form>;
          })}
        </div>
      </main>
    </div>
  );
}
