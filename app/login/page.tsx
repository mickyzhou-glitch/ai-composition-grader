"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { apiFetch, errorMessage } from "../lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const user = await apiFetch<{ mustChangePassword: boolean }>("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      router.replace(user.mustChangePassword ? "/change-password" : "/");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="paper-card auth-card" aria-labelledby="login-title">
        <p className="eyebrow">青藤未来作文批改助手 · 工作台</p>
        <h1 id="login-title">登录</h1>
        <p className="muted">使用管理员为你创建的账号进入批改工作台。</p>
        {error ? <p className="error-banner" role="alert">{error}</p> : null}
        <form className="form-stack" onSubmit={(event) => void submit(event)}>
          <label className="field" htmlFor="username">用户名<input id="username" name="username" autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label className="field" htmlFor="password">密码<input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <button className="button button--primary" type="submit" disabled={busy}>{busy ? "登录中…" : "登录"}</button>
        </form>
      </section>
    </main>
  );
}
