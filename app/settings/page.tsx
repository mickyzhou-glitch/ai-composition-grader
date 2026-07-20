"use client";

import { useCallback, useEffect, useState } from "react";

import { AppHeader } from "../components/AppHeader";
import { AsyncButton } from "../components/AsyncButton";
import { ErrorBanner } from "../components/ErrorBanner";
import { apiFetch, errorMessage } from "../lib/api";

interface SettingsView {
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
}

const emptySettings = { baseUrl: "https://api.openai.com/v1", model: "gpt-5", keyConfigured: false };

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsView>(emptySettings);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const loaded = await apiFetch<SettingsView | null>("/api/settings");
      setSettings(loaded ?? emptySettings);
      setApiKey("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void apiFetch<SettingsView | null>("/api/settings")
      .then((loaded) => { if (active) setSettings(loaded ?? emptySettings); })
      .catch((caught) => { if (active) setError(errorMessage(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function submit(kind: "test" | "save") {
    setBusy(kind);
    setError("");
    setSuccess("");
    const body = {
      baseUrl: settings.baseUrl,
      model: settings.model,
      ...(apiKey ? { apiKey } : {}),
    };
    try {
      const result = await apiFetch<SettingsView | { connected: true }>(
        kind === "test" ? "/api/settings/test" : "/api/settings",
        { method: kind === "test" ? "POST" : "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      );
      if (kind === "save") {
        setSettings(result as SettingsView);
        setApiKey("");
      }
      setSuccess(kind === "test" ? "连接成功，可以开始使用。" : "连接测试通过，设置已安全保存。");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader compact />
      <main className="narrow-page">
        <div className="page-title"><p className="eyebrow">模型连接</p><h1>设置</h1><p>密钥只保存在本机系统钥匙串中，页面不会读取或回显。</p></div>
        {error ? <ErrorBanner message={error} onRetry={loading ? undefined : load} /> : null}
        {success ? <div className="success-banner" role="status">{success}</div> : null}
        <form className="paper-card form-stack" onSubmit={(event) => { event.preventDefault(); void submit("save"); }}>
          <label>服务地址<input required type="url" value={settings.baseUrl} disabled={loading} onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })} /></label>
          <label>模型名称<input required value={settings.model} disabled={loading} onChange={(event) => setSettings({ ...settings, model: event.target.value })} /></label>
          <label>API Key<input type="password" autoComplete="new-password" value={apiKey} disabled={loading} placeholder={settings.keyConfigured ? "已配置，无需重复填写" : "请输入 API Key"} onChange={(event) => setApiKey(event.target.value)} /></label>
          <p className="field-help">{settings.keyConfigured ? "密钥已配置，留空将继续使用原密钥" : "尚未配置密钥"}</p>
          <div className="form-actions">
            <AsyncButton className="button button--quiet" type="button" busy={busy === "test"} busyLabel="测试中…" onClick={() => void submit("test")}>测试连接</AsyncButton>
            <AsyncButton className="button button--primary" type="submit" busy={busy === "save"} busyLabel="保存中…">测试并保存</AsyncButton>
          </div>
        </form>
      </main>
    </div>
  );
}
