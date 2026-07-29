"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { ApiError, apiFetch, errorMessage } from "../lib/api";
import { createBrowserLoginProof } from "../../src/auth/password-proof-browser";
import { createLegacyPasswordLogin, type LegacyPasswordParameters } from "../../src/auth/legacy-password-proof-browser";

import { shouldUsePasswordProofLogin } from "./login-mode";

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
      const user = shouldUsePasswordProofLogin(window.location.hostname)
        ? await loginWithProof(username, password)
        : await apiFetch<{ mustChangePassword: boolean }>("/api/auth/login", {
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
        <p className="muted">使用管理员为你创建的账号进入批改工作台。首次云端登录会安全升级登录验证。</p>
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

async function loginWithProof(username: string, password: string): Promise<{ mustChangePassword: boolean }> {
  const challenge = await apiFetch<{ id: string; salt: string; nonce: string }>("/api/auth/login/challenge", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }),
  });
  const proof = await createBrowserLoginProof({ password, salt: challenge.salt, challengeId: challenge.id, nonce: challenge.nonce });
  try {
    return await apiFetch<{ mustChangePassword: boolean }>("/api/auth/login/complete", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: challenge.id, proof }),
    });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    return loginWithLegacyPassword(username, password);
  }
}

async function loginWithLegacyPassword(username: string, password: string): Promise<{ mustChangePassword: boolean }> {
  const challenge = await apiFetch<{ id: string; nonce: string; legacy: LegacyPasswordParameters }>("/api/auth/login/legacy/challenge", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }),
  });
  const login = await createLegacyPasswordLogin({ password, challengeId: challenge.id, nonce: challenge.nonce, legacy: challenge.legacy });
  return apiFetch<{ mustChangePassword: boolean }>("/api/auth/login/legacy/complete", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: challenge.id, ...login }),
  });
}
