"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

import { apiFetch, errorMessage } from "../lib/api";

export default function ChangePasswordPage() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void apiFetch<{ id: string }>("/api/auth/me").catch(() => router.replace("/login"));
  }, [router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword !== confirmation) { setError("两次输入的新密码不一致"); return; }
    setBusy(true);
    setError("");
    try {
      await apiFetch("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      router.replace("/");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="paper-card auth-card" aria-labelledby="change-password-title">
        <p className="eyebrow">首次登录</p>
        <h1 id="change-password-title">设置新密码</h1>
        <p className="muted">为了保护批改记录，请先设置一个新的登录密码。</p>
        {error ? <p className="error-banner" role="alert">{error}</p> : null}
        <form className="form-stack" onSubmit={(event) => void submit(event)}>
          <label className="field" htmlFor="current-password">当前密码<input id="current-password" type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
          <label className="field" htmlFor="new-password">新密码<input id="new-password" type="password" autoComplete="new-password" minLength={8} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
          <label className="field" htmlFor="confirm-password">确认新密码<input id="confirm-password" type="password" autoComplete="new-password" minLength={8} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
          <button className="button button--primary" type="submit" disabled={busy}>{busy ? "保存中…" : "保存新密码"}</button>
        </form>
      </section>
    </main>
  );
}
