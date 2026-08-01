"use client";

import { FormEvent, useState, useSyncExternalStore } from "react";

import { ApiError, apiFetch, errorMessage } from "../lib/api";
import { replaceDocument } from "../lib/document-navigation";
import { isPasswordProofModuleLoadError } from "../lib/password-proof-errors";
import type { LegacyPasswordParameters } from "../../src/auth/legacy-password-proof-browser";

import { shouldUsePasswordProofLogin } from "./login-mode";

interface LoginChallenge {
  id: string;
  salt: string;
  nonce: string;
  expiresAt?: string;
  mode?: "proof" | "legacy";
  legacy?: LegacyPasswordParameters;
}

const SECURE_LOGIN_UNAVAILABLE = "当前浏览器无法完成安全登录，请使用最新版系统浏览器后重试";
const SECURE_LOGIN_LOAD_FAILED = "安全登录组件加载失败，请检查网络后刷新页面重试";
const subscribeToHydration = () => () => undefined;
const browserIsReady = () => true;
const serverIsNotReady = () => false;

class SecureLoginUnavailableError extends Error {
  constructor(cause: unknown) {
    super(SECURE_LOGIN_UNAVAILABLE, { cause });
    this.name = "SecureLoginUnavailableError";
  }
}

class SecureLoginLoadError extends Error {
  constructor(cause: unknown) {
    super(SECURE_LOGIN_LOAD_FAILED, { cause });
    this.name = "SecureLoginLoadError";
  }
}

function secureLoginError(cause: unknown): Error {
  return isPasswordProofModuleLoadError(cause)
    ? new SecureLoginLoadError(cause)
    : new SecureLoginUnavailableError(cause);
}

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = useSyncExternalStore(subscribeToHydration, browserIsReady, serverIsNotReady);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy) return;
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
      replaceDocument(user.mustChangePassword ? "/change-password" : "/");
    } catch (caught) {
      setError(caught instanceof SecureLoginUnavailableError ? caught.message : errorMessage(caught));
    } finally {
      setPassword("");
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
        <form className="form-stack" method="post" onSubmit={(event) => void submit(event)}>
          <label className="field" htmlFor="username">用户名<input id="username" name="username" autoComplete="username" required disabled={!ready || busy} value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label className="field" htmlFor="password">密码<input id="password" name="password" type="password" autoComplete="current-password" required disabled={!ready || busy} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <button className="button button--primary" type="submit" disabled={!ready || busy}>{!ready ? "正在加载安全登录…" : busy ? "登录中…" : "登录"}</button>
        </form>
      </section>
    </main>
  );
}

async function loginWithProof(username: string, password: string): Promise<{ mustChangePassword: boolean }> {
  const challenge = await apiFetch<LoginChallenge>("/api/auth/login/challenge", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }),
  });
  if (challenge.mode === "legacy" && challenge.legacy) {
    return completeLegacyPasswordLogin(password, { ...challenge, legacy: challenge.legacy });
  }
  const proof = await createModernPasswordProof(password, challenge);
  try {
    return await apiFetch<{ mustChangePassword: boolean }>("/api/auth/login/complete", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: challenge.id, proof }),
    });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401 || challenge.mode === "proof") throw error;
    return loginWithLegacyPassword(username, password);
  }
}

async function loginWithLegacyPassword(username: string, password: string): Promise<{ mustChangePassword: boolean }> {
  const challenge = await apiFetch<LoginChallenge & { legacy: LegacyPasswordParameters }>("/api/auth/login/legacy/challenge", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }),
  });
  return completeLegacyPasswordLogin(password, challenge);
}

async function createModernPasswordProof(password: string, challenge: LoginChallenge): Promise<string> {
  try {
    const { createBrowserLoginProof } = await import("../../src/auth/password-proof-browser");
    return await createBrowserLoginProof({ password, salt: challenge.salt, challengeId: challenge.id, nonce: challenge.nonce });
  } catch (error) {
    throw secureLoginError(error);
  }
}

async function completeLegacyPasswordLogin(
  password: string,
  challenge: LoginChallenge & { legacy: LegacyPasswordParameters },
): Promise<{ mustChangePassword: boolean }> {
  let login: { proof: string; verifier: string };
  try {
    const { createLegacyPasswordLogin } = await import("../../src/auth/legacy-password-proof-browser");
    login = await createLegacyPasswordLogin({ password, challengeId: challenge.id, nonce: challenge.nonce, legacy: challenge.legacy });
  } catch (error) {
    throw secureLoginError(error);
  }
  return apiFetch<{ mustChangePassword: boolean }>("/api/auth/login/legacy/complete", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: challenge.id, ...login }),
  });
}
