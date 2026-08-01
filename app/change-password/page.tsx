"use client";

import { FormEvent, useEffect, useState, useSyncExternalStore } from "react";

import { ApiError, apiFetch, errorMessage } from "../lib/api";
import { replaceDocument } from "../lib/document-navigation";
import { isPasswordProofModuleLoadError } from "../lib/password-proof-errors";
import { toBase64Url } from "../../src/auth/password-proof";

const SECURE_SETTINGS_UNAVAILABLE = "当前浏览器无法完成安全设置，请使用最新版系统浏览器后重试";
const SECURE_SETTINGS_LOAD_FAILED = "安全设置组件加载失败，请检查网络后刷新页面重试";
const subscribeToHydration = () => () => undefined;
const browserIsReady = () => true;
const serverIsNotReady = () => false;

export default function ChangePasswordPage() {
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [authState, setAuthState] = useState<"checking" | "ready" | "failed">("checking");
  const hydrated = useSyncExternalStore(subscribeToHydration, browserIsReady, serverIsNotReady);
  const ready = hydrated && authState === "ready";

  useEffect(() => {
    let active = true;
    void apiFetch<{ id: string }>("/api/auth/me")
      .then(() => { if (active) setAuthState("ready"); })
      .catch((caught: unknown) => {
        if (!active) return;
        if (caught instanceof ApiError && caught.code === "UNAUTHENTICATED") {
          replaceDocument("/login");
          return;
        }
        setAuthState("failed");
      });
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy) return;
    if (newPassword !== confirmation) { setError("两次输入的新密码不一致"); return; }
    setBusy(true);
    setError("");
    try {
      const salt = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
      const verifier = toBase64Url(await deriveNewPasswordVerifier(newPassword, salt));
      await apiFetch("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ salt, verifier }),
      });
      replaceDocument("/");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (authState === "failed") {
    return <main className="auth-page"><p className="error-banner" role="alert">认证服务暂时不可用，请稍后重试。</p></main>;
  }

  return (
    <main className="auth-page">
      <section className="paper-card auth-card" aria-labelledby="change-password-title">
        <p className="eyebrow">首次登录</p>
        <h1 id="change-password-title">设置新密码</h1>
        <p className="muted">为了保护批改记录，请先设置一个新的登录密码。</p>
        {error ? <p className="error-banner" role="alert">{error}</p> : null}
        <form className="form-stack" method="post" onSubmit={(event) => void submit(event)}>
          <label className="field" htmlFor="new-password">新密码<input id="new-password" type="password" autoComplete="new-password" minLength={8} required disabled={!ready || busy} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
          <label className="field" htmlFor="confirm-password">确认新密码<input id="confirm-password" type="password" autoComplete="new-password" minLength={8} required disabled={!ready || busy} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
          <button className="button button--primary" type="submit" disabled={!ready || busy}>{!ready ? "正在验证登录…" : busy ? "保存中…" : "保存新密码"}</button>
        </form>
      </section>
    </main>
  );
}

async function deriveNewPasswordVerifier(password: string, salt: string): Promise<Uint8Array> {
  try {
    const { deriveBrowserPasswordVerifier } = await import("../../src/auth/password-proof-browser");
    return await deriveBrowserPasswordVerifier(password, salt);
  } catch (cause) {
    throw new Error(isPasswordProofModuleLoadError(cause) ? SECURE_SETTINGS_LOAD_FAILED : SECURE_SETTINGS_UNAVAILABLE, { cause });
  }
}
