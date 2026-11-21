"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import type {
  AccountActivityLevel,
  AdminAccountsOverview,
  AdminAccountView,
  AdminSecurityEventView,
} from "@/src/cloudflare/d1-admin-accounts";
import { toBase64Url } from "@/src/auth/password-proof";
import { AdminSubnav } from "../../../components/AdminSubnav";
import { AppHeader } from "../../../components/AppHeader";
import { AsyncButton } from "../../../components/AsyncButton";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { apiFetch, errorMessage } from "../../../lib/api";
import { isPasswordProofModuleLoadError } from "../../../lib/password-proof-errors";

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function generateRandomPassword(length = 14): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (value) => PASSWORD_ALPHABET[value % PASSWORD_ALPHABET.length]).join("");
}

async function deriveVerifierPayload(password: string): Promise<{ salt: string; verifier: string }> {
  const salt = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  try {
    const { deriveBrowserPasswordVerifier } = await import("../../../../src/auth/password-proof-browser");
    const verifier = toBase64Url(await deriveBrowserPasswordVerifier(password, salt));
    return { salt, verifier };
  } catch (cause) {
    throw new Error(
      isPasswordProofModuleLoadError(cause)
        ? "安全凭证组件加载失败，请检查网络后刷新页面重试"
        : "当前浏览器无法生成安全密码凭证，请使用最新版浏览器重试",
      { cause },
    );
  }
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "暂无记录";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatRelative(iso: string | null): string {
  if (!iso) return "从未活动";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return "";
  if (diffMs < 60_000) return "刚刚";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}

const activityLabels: Record<AccountActivityLevel, { text: string; className: string }> = {
  online: { text: "在线活跃", className: "activity-pill activity-pill--online" },
  today: { text: "今日活跃", className: "activity-pill activity-pill--today" },
  active_7d: { text: "近 7 天活跃", className: "activity-pill activity-pill--recent" },
  active_30d: { text: "近 30 天活跃", className: "activity-pill activity-pill--month" },
  inactive: { text: "超 30 天未活动", className: "activity-pill activity-pill--idle" },
  never: { text: "尚未使用", className: "activity-pill activity-pill--idle" },
};

function describeSecurityEvent(event: AdminSecurityEventView): string {
  const by = typeof event.metadata.by === "string" ? `（操作人：${event.metadata.by}）` : "";
  switch (event.eventType) {
    case "login_succeeded":
      return event.metadata.mode === "legacy_upgraded" ? "首次云端登录并完成安全凭证升级" : "登录工作台成功";
    case "password_changed":
      return "本人完成密码修改";
    case "account_created":
      return `创建账号${by}`;
    case "password_reset":
      return `重置登录密码${by}`;
    case "account_disabled":
      return `停用账号并清空会话${by}`;
    case "account_enabled":
      return `恢复启用账号${by}`;
    case "role_updated":
      return `权限变更为「${event.metadata.to === "admin" ? "管理员" : "教师"}」${by}`;
    case "sessions_revoked":
      return `强制下线会话（${Number(event.metadata.revokedCount ?? 0)} 个）${by}`;
    case "login_unlocked":
      return `解除登录频率锁定${by}`;
    default:
      return event.eventType;
  }
}

interface IssuedCredentialNotice {
  kind: "created" | "reset";
  username: string;
  role: "admin" | "teacher";
  password: string;
  mustChangePassword: boolean;
}

export default function AdminAccountsPage() {
  const [data, setData] = useState<AdminAccountsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [issuedCredential, setIssuedCredential] = useState<IssuedCredentialNotice | null>(null);
  const [copied, setCopied] = useState(false);

  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "admin" | "teacher">("all");
  const [stateFilter, setStateFilter] = useState<"all" | "online" | "active_7d" | "enabled" | "must_change" | "locked" | "disabled">("all");
  const [sortBy, setSortBy] = useState<"active" | "reviews" | "username">("active");

  const [actionBusyKey, setActionBusyKey] = useState<string | null>(null);

  // Create Account Dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [createUsername, setCreateUsername] = useState("");
  const [createRole, setCreateRole] = useState<"teacher" | "admin">("teacher");
  const [createPassword, setCreatePassword] = useState("");
  const [createMustChange, setCreateMustChange] = useState(true);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");

  // Reset Password Dialog state
  const [resetTarget, setResetTarget] = useState<AdminAccountView | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState("");
  const [resetMustChange, setResetMustChange] = useState(true);
  const [resetRevokeSessions, setResetRevokeSessions] = useState(true);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState("");

  const refreshOverview = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      const overview = await apiFetch<AdminAccountsOverview>("/api/admin/accounts");
      setData(overview);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void apiFetch<AdminAccountsOverview>("/api/admin/accounts")
      .then((overview) => {
        if (active) setData(overview);
      })
      .catch((caught) => {
        if (active) setError(errorMessage(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!createOpen && !resetTarget) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (createOpen && !createBusy) setCreateOpen(false);
      if (resetTarget && !resetBusy) setResetTarget(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [createBusy, createOpen, resetBusy, resetTarget]);

  const enabledAdminCount = useMemo(
    () => (data?.accounts ?? []).filter((item) => item.role === "admin" && item.enabled).length,
    [data],
  );

  const visibleAccounts = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const filtered = (data?.accounts ?? []).filter((account) => {
      if (keyword && !account.username.toLowerCase().includes(keyword)) return false;
      if (roleFilter !== "all" && account.role !== roleFilter) return false;
      if (stateFilter === "online" && account.activityLevel !== "online") return false;
      if (stateFilter === "active_7d" && !["online", "today", "active_7d"].includes(account.activityLevel)) return false;
      if (stateFilter === "enabled" && !account.enabled) return false;
      if (stateFilter === "must_change" && !account.mustChangePassword) return false;
      if (stateFilter === "locked" && !account.rateLimited) return false;
      if (stateFilter === "disabled" && account.enabled) return false;
      return true;
    });

    return [...filtered].sort((left, right) => {
      if (sortBy === "reviews") {
        if (right.usage.totalReviews !== left.usage.totalReviews) {
          return right.usage.totalReviews - left.usage.totalReviews;
        }
      } else if (sortBy === "username") {
        return left.username.localeCompare(right.username, "zh-CN");
      } else {
        const leftActive = left.usage.lastActiveAt ? new Date(left.usage.lastActiveAt).getTime() : 0;
        const rightActive = right.usage.lastActiveAt ? new Date(right.usage.lastActiveAt).getTime() : 0;
        if (rightActive !== leftActive) return rightActive - leftActive;
      }
      if (left.isCurrentUser !== right.isCurrentUser) return left.isCurrentUser ? -1 : 1;
      return left.username.localeCompare(right.username, "zh-CN");
    });
  }, [data, roleFilter, search, sortBy, stateFilter]);

  function openCreateDialog() {
    setCreateUsername("");
    setCreateRole("teacher");
    setCreatePassword(generateRandomPassword());
    setCreateMustChange(true);
    setCreateError("");
    setCreateOpen(true);
  }

  function openResetDialog(account: AdminAccountView) {
    setResetTarget(account);
    setResetPasswordValue(generateRandomPassword());
    setResetMustChange(!account.isCurrentUser);
    setResetRevokeSessions(true);
    setResetError("");
  }

  async function submitCreateAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createBusy) return;
    const normalizedUsername = createUsername.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/u.test(normalizedUsername) || normalizedUsername === "anonymous") {
      setCreateError("用户名需为 3 至 32 位字母、数字、.、_ 或 -");
      return;
    }
    if (createPassword.length < 8) {
      setCreateError("初始密码长度至少为 8 位");
      return;
    }
    setCreateBusy(true);
    setCreateError("");
    setError("");
    setNotice("");
    try {
      const { salt, verifier } = await deriveVerifierPayload(createPassword);
      const created = await apiFetch<{ id: string; username: string; role: "admin" | "teacher"; mustChangePassword: boolean }>(
        "/api/admin/accounts",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: normalizedUsername,
            role: createRole,
            mustChangePassword: createMustChange,
            salt,
            verifier,
          }),
        },
      );
      setIssuedCredential({
        kind: "created",
        username: created.username,
        role: created.role,
        password: createPassword,
        mustChangePassword: created.mustChangePassword,
      });
      setCopied(false);
      setCreateOpen(false);
      await refreshOverview();
    } catch (caught) {
      setCreateError(errorMessage(caught));
    } finally {
      setCreateBusy(false);
    }
  }

  async function submitResetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resetTarget || resetBusy) return;
    if (resetPasswordValue.length < 8) {
      setResetError("新密码长度至少为 8 位");
      return;
    }
    setResetBusy(true);
    setResetError("");
    setError("");
    setNotice("");
    try {
      const { salt, verifier } = await deriveVerifierPayload(resetPasswordValue);
      await apiFetch(`/api/admin/accounts/${encodeURIComponent(resetTarget.id)}/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          salt,
          verifier,
          mustChangePassword: resetTarget.isCurrentUser ? false : resetMustChange,
          revokeSessions: resetRevokeSessions,
        }),
      });
      setIssuedCredential({
        kind: "reset",
        username: resetTarget.username,
        role: resetTarget.role,
        password: resetPasswordValue,
        mustChangePassword: resetTarget.isCurrentUser ? false : resetMustChange,
      });
      setCopied(false);
      setResetTarget(null);
      await refreshOverview();
    } catch (caught) {
      setResetError(errorMessage(caught));
    } finally {
      setResetBusy(false);
    }
  }

  async function toggleAccountDisabled(account: AdminAccountView) {
    const disabling = account.enabled;
    if (disabling && !window.confirm(`确认停用账号「${account.username}」？停用后该账号的所有在线会话将立即下线，历史批改数据仍会保留。`)) {
      return;
    }
    setActionBusyKey(`disable-${account.id}`);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: disabling }),
      });
      setNotice(disabling ? `已停用账号「${account.username}」并下线其活动会话` : `已恢复启用账号「${account.username}」`);
      await refreshOverview();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setActionBusyKey(null);
    }
  }

  async function toggleAccountRole(account: AdminAccountView) {
    const nextRole = account.role === "admin" ? "teacher" : "admin";
    const actionLabel = nextRole === "admin" ? "升级为管理员" : "调整为普通教师";
    if (!window.confirm(`确认将「${account.username}」${actionLabel}？`)) return;
    setActionBusyKey(`role-${account.id}`);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      });
      setNotice(`已将「${account.username}」${actionLabel}`);
      await refreshOverview();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setActionBusyKey(null);
    }
  }

  async function revokeAccountSessions(account: AdminAccountView) {
    const promptText = account.isCurrentUser
      ? "确认踢出当前账号在其他设备上的登录会话？本机登录将保持保留。"
      : `确认强制下线「${account.username}」的全部在线会话？`;
    if (!window.confirm(promptText)) return;
    setActionBusyKey(`revoke-${account.id}`);
    setError("");
    setNotice("");
    try {
      const result = await apiFetch<{ revokedCount: number }>(
        `/api/admin/accounts/${encodeURIComponent(account.id)}/revoke-sessions`,
        { method: "POST" },
      );
      setNotice(`已为「${account.username}」下线 ${result.revokedCount} 个活动会话`);
      await refreshOverview();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setActionBusyKey(null);
    }
  }

  async function unlockAccountLogin(account: AdminAccountView) {
    setActionBusyKey(`unlock-${account.id}`);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/api/admin/accounts/${encodeURIComponent(account.id)}/unlock-login`, {
        method: "POST",
      });
      setNotice(`已解除「${account.username}」的登录频率锁定`);
      await refreshOverview();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setActionBusyKey(null);
    }
  }

  async function copyIssuedCredential() {
    if (!issuedCredential) return;
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const text = [
      `青藤未来作文批改助手 · 登录信息`,
      origin ? `登录地址：${origin}/login` : null,
      `用户名：${issuedCredential.username}`,
      `初始密码：${issuedCredential.password}`,
      issuedCredential.mustChangePassword ? `提示：首次登录后请按提示设置新密码。` : null,
    ].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setError("浏览器未授权剪贴板访问，请手动选中复制");
    }
  }

  const summary = data?.summary;

  return (
    <div className="app-shell">
      <AppHeader compact />
      <main className="page-container">
        <div className="page-title">
          <p className="eyebrow">管理员控制台 · 账号与活跃度</p>
          <h1>账号与活跃监控</h1>
          <p>实时掌握全部账号的在线会话、登录安全、作文批改使用量与活跃状态，并直接在页面完成建号、改密与权限管控。</p>
        </div>

        <AdminSubnav
          active="accounts"
          actions={
            <>
              <AsyncButton
                className="button button--quiet"
                type="button"
                busy={refreshing}
                busyLabel="刷新中…"
                disabled={loading || actionBusyKey !== null}
                onClick={() => void refreshOverview()}
              >
                刷新数据
              </AsyncButton>
              <button
                className="button button--primary"
                type="button"
                onClick={openCreateDialog}
              >
                + 新建账号
              </button>
            </>
          }
        />

        {error ? <ErrorBanner message={error} /> : null}
        {notice ? <div className="success-banner" role="status">{notice}</div> : null}

        {issuedCredential ? (
          <section className="credential-reveal-card" role="status" aria-label="一次性初始密码凭证">
            <div className="credential-reveal-header">
              <div>
                <p className="eyebrow">一次性安全凭证 · 请立即保存</p>
                <h2>
                  {issuedCredential.kind === "created"
                    ? `账号「${issuedCredential.username}」已创建`
                    : `账号「${issuedCredential.username}」密码已重置`}
                </h2>
                <p className="muted">密码已在浏览器本地加密派生后存入云端，服务器不保存明文；关闭本提示后将无法再次查看该密码。</p>
              </div>
              <div className="credential-reveal-actions">
                <button className="button button--primary" type="button" onClick={() => void copyIssuedCredential()}>
                  {copied ? "已复制登录信息 ✓" : "一键复制登录信息"}
                </button>
                <button className="button button--quiet" type="button" onClick={() => setIssuedCredential(null)}>
                  我已保存，关闭
                </button>
              </div>
            </div>
            <div className="credential-reveal-box">
              <div><span>用户名</span><code>{issuedCredential.username}</code></div>
              <div><span>角色</span><code>{issuedCredential.role === "admin" ? "管理员" : "教师"}</code></div>
              <div><span>初始密码</span><code>{issuedCredential.password}</code></div>
              <div><span>首次登录改密</span><code>{issuedCredential.mustChangePassword ? "需要" : "不需要"}</code></div>
            </div>
          </section>
        ) : null}

        {summary ? (
          <dl className="admin-kpi-grid" aria-label="账号与使用概览">
            <div className="admin-kpi-card">
              <dt>账号总数</dt>
              <dd>{summary.totalUsers}</dd>
              <small>启用 {summary.enabledUsers} · 停用 {summary.disabledUsers}</small>
            </div>
            <div className="admin-kpi-card admin-kpi-card--highlight">
              <dt>当前在线</dt>
              <dd>{summary.onlineUsers}</dd>
              <small>{summary.activeSessionsTotal} 个有效登录会话</small>
            </div>
            <div className="admin-kpi-card">
              <dt>近 7 天活跃</dt>
              <dd>{summary.activeUsers7d}</dd>
              <small>管理员 {summary.adminCount} · 教师 {summary.teacherCount}</small>
            </div>
            <div className="admin-kpi-card">
              <dt>累计批改作文</dt>
              <dd>{summary.totalReviews}</dd>
              <small>近 7 天新增 +{summary.reviews7d} 篇</small>
            </div>
            <div className="admin-kpi-card">
              <dt>近 7 天 AI 任务</dt>
              <dd>{summary.jobsSucceeded7d ?? summary.totalJobsSucceeded}</dd>
              <small>近 7 天失败 {summary.jobsFailed7d ?? 0} · 累计成功 {summary.totalJobsSucceeded}</small>
            </div>
            <div className={summary.rateLimitedUsers > 0 ? "admin-kpi-card admin-kpi-card--danger" : "admin-kpi-card"}>
              <dt>近 7 天登录</dt>
              <dd>{summary.loginsSucceeded7d}</dd>
              <small>
                失败 {summary.loginsFailed7d} 次
                {summary.rateLimitedUsers > 0 ? ` · 锁定 ${summary.rateLimitedUsers} 人` : " · 无锁定账号"}
              </small>
            </div>
          </dl>
        ) : null}

        <div className="history-toolbar admin-filter-bar">
          <div className="admin-filters-grid">
            <label className="history-search">
              <span>搜索账号</span>
              <input
                type="search"
                value={search}
                placeholder="输入用户名筛选…"
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className="history-search">
              <span>角色筛选</span>
              <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value as typeof roleFilter)}>
                <option value="all">全部角色</option>
                <option value="admin">管理员</option>
                <option value="teacher">教师</option>
              </select>
            </label>
            <label className="history-search">
              <span>状态与活跃度</span>
              <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value as typeof stateFilter)}>
                <option value="all">全部状态</option>
                <option value="online">当前在线</option>
                <option value="active_7d">近 7 天活跃</option>
                <option value="enabled">正常启用</option>
                <option value="must_change">待首次改密</option>
                <option value="locked">登录受限锁定</option>
                <option value="disabled">已停用</option>
              </select>
            </label>
            <label className="history-search">
              <span>排序方式</span>
              <select value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}>
                <option value="active">按最近活跃时间</option>
                <option value="reviews">按累计批改篇数</option>
                <option value="username">按用户名排序</option>
              </select>
            </label>
          </div>
        </div>

        {loading ? (
          <p className="loading-note" role="status">正在汇总账号登录与批改使用数据…</p>
        ) : visibleAccounts.length === 0 ? (
          <div className="history-empty-filter">
            <p className="muted">没有符合当前筛选条件的账号。</p>
          </div>
        ) : (
          <div className="admin-account-list">
            {visibleAccounts.map((account) => {
              const activity = activityLabels[account.activityLevel];
              const isSoleActiveAdmin = account.role === "admin" && account.enabled && enabledAdminCount <= 1;
              const roleLockReason = account.isCurrentUser
                ? "不能取消当前登录账号的管理员权限"
                : isSoleActiveAdmin
                  ? "系统至少需保留一个启用中的管理员"
                  : undefined;
              const disableLockReason = account.isCurrentUser
                ? "不能停用当前登录的账号"
                : isSoleActiveAdmin
                  ? "不能停用系统唯一的管理员"
                  : undefined;
              const canRevokeSessions = account.isCurrentUser
                ? account.login.activeSessions > 1
                : account.login.activeSessions > 0;

              return (
                <article
                  className={account.enabled ? "admin-account-card" : "admin-account-card admin-account-card--disabled"}
                  key={account.id}
                  aria-label={`账号 ${account.username}`}
                >
                  <header className="admin-account-header">
                    <div className="admin-account-identity">
                      <span className="admin-avatar" aria-hidden="true">
                        {account.username.slice(0, 1).toUpperCase()}
                      </span>
                      <div>
                        <div className="admin-account-title-row">
                          <h2>{account.username}</h2>
                          <span className={account.role === "admin" ? "role-pill role-pill--admin" : "role-pill"}>
                            {account.role === "admin" ? "管理员" : "教师"}
                          </span>
                          {account.isCurrentUser ? <span className="meta-chip">当前登录</span> : null}
                          <span className={activity.className}>{activity.text}</span>
                        </div>
                        <p className="admin-account-submeta">
                          创建于 {formatDateTime(account.createdAt)}
                          {" · "}
                          {account.proofMode === "modern" ? "已启用零明文安全验证" : "旧版哈希（待首次登录自动升级）"}
                        </p>
                      </div>
                    </div>

                    <div className="admin-account-badges">
                      {!account.enabled ? (
                        <span className="status-badge status-badge--failed">已停用</span>
                      ) : (
                        <span className="status-badge status-badge--ready_for_review">启用中</span>
                      )}
                      {account.mustChangePassword ? (
                        <span className="status-badge status-badge--analyzing">待首次改密</span>
                      ) : null}
                      {account.rateLimited ? (
                        <span className="status-badge status-badge--failed">
                          登录锁定（连错 {account.consecutiveFailures15m} 次）
                        </span>
                      ) : null}
                    </div>
                  </header>

                  <div className="admin-telemetry-grid">
                    <section className="admin-telemetry-box" aria-label={`${account.username} 登录情况`}>
                      <h3>登录与在线情况</h3>
                      <dl className="admin-kv-grid">
                        <div>
                          <dt>在线会话</dt>
                          <dd>
                            {account.login.activeSessions > 0 ? (
                              <strong className="text-teal">{account.login.activeSessions} 个有效会话</strong>
                            ) : (
                              "当前离线"
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>最近在线</dt>
                          <dd>
                            {account.login.lastSeenAt
                              ? `${formatRelative(account.login.lastSeenAt)}（${formatDateTime(account.login.lastSeenAt)}）`
                              : "暂无记录"}
                          </dd>
                        </div>
                        <div>
                          <dt>最近登录</dt>
                          <dd>{formatDateTime(account.login.lastLoginAt)}</dd>
                        </div>
                        <div>
                          <dt>近 7 天登录</dt>
                          <dd>
                            成功 <b>{account.login.succeeded7d}</b> 次 · 失败{" "}
                            <b className={account.login.failed7d > 0 ? "danger-text" : ""}>{account.login.failed7d}</b> 次
                            {account.login.lastFailedAt ? (
                              <small className="admin-inline-note">最近失败：{formatDateTime(account.login.lastFailedAt)}</small>
                            ) : null}
                          </dd>
                        </div>
                      </dl>
                    </section>

                    <section className="admin-telemetry-box" aria-label={`${account.username} 使用情况`}>
                      <h3>使用与活跃情况</h3>
                      <dl className="admin-kv-grid">
                        <div>
                          <dt>批改作文量</dt>
                          <dd>
                            <strong>共 {account.usage.totalReviews} 篇</strong>
                            <span className="admin-inline-pills">
                              <span>近 7 天 +{account.usage.reviews7d}</span>
                              <span>近 30 天 +{account.usage.reviews30d}</span>
                            </span>
                          </dd>
                        </div>
                        <div>
                          <dt>最近使用</dt>
                          <dd>
                            {account.usage.lastReviewActivityAt
                              ? `${formatRelative(account.usage.lastReviewActivityAt)}（${formatDateTime(account.usage.lastReviewActivityAt)}）`
                              : "暂无批改记录"}
                          </dd>
                        </div>
                        <div className="admin-kv-wide">
                          <dt>状态与沉淀</dt>
                          <dd className="admin-usage-chips">
                            <span>待复核 {account.usage.pendingReviewCount}</span>
                            <span>已复核 {account.usage.reviewedCount}</span>
                            <span>已导出 {account.usage.exportedCount}</span>
                            {account.usage.analyzingCount > 0 ? <span>分析中 {account.usage.analyzingCount}</span> : null}
                            {account.usage.failedCount > 0 ? <span className="chip-danger">待重批失败 {account.usage.failedCount} 篇</span> : null}
                            <span title={`含历史重试累计：成功 ${account.usage.jobsSucceeded} 次，历史失败 ${account.usage.jobsFailed} 次`}>
                              近 7 天 AI {account.usage.jobsSucceeded7d ?? 0} 成功 / {account.usage.jobsFailed7d ?? 0} 失败
                            </span>
                            <span>题目框架 {account.usage.savedAssignmentsCount}</span>
                            <span>长期规则 {account.usage.standingRulesCount}</span>
                          </dd>
                        </div>
                      </dl>
                    </section>
                  </div>

                  <footer className="admin-account-footer">
                    <div className="admin-account-events">
                      {account.recentEvents.length > 0 ? (
                        <details>
                          <summary>近期安全与管理记录（{account.recentEvents.length}）</summary>
                          <ul>
                            {account.recentEvents.map((event) => (
                              <li key={event.id}>
                                <span>{describeSecurityEvent(event)}</span>
                                <time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time>
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : (
                        <span className="muted admin-no-events">暂无近期安全事件记录</span>
                      )}
                    </div>

                    <div className="admin-account-actions">
                      {account.rateLimited ? (
                        <AsyncButton
                          className="button button--quiet"
                          type="button"
                          busy={actionBusyKey === `unlock-${account.id}`}
                          busyLabel="解锁中…"
                          disabled={actionBusyKey !== null}
                          onClick={() => void unlockAccountLogin(account)}
                        >
                          解除登录锁定
                        </AsyncButton>
                      ) : null}

                      <button
                        className="button button--quiet"
                        type="button"
                        disabled={actionBusyKey !== null}
                        onClick={() => openResetDialog(account)}
                      >
                        重置密码
                      </button>

                      <AsyncButton
                        className="button button--quiet"
                        type="button"
                        title={roleLockReason}
                        busy={actionBusyKey === `role-${account.id}`}
                        busyLabel="保存中…"
                        disabled={actionBusyKey !== null || Boolean(roleLockReason)}
                        onClick={() => void toggleAccountRole(account)}
                      >
                        {account.role === "admin" ? "设为教师" : "设为管理员"}
                      </AsyncButton>

                      <AsyncButton
                        className="button button--quiet"
                        type="button"
                        busy={actionBusyKey === `revoke-${account.id}`}
                        busyLabel="下线中…"
                        disabled={actionBusyKey !== null || !canRevokeSessions}
                        onClick={() => void revokeAccountSessions(account)}
                      >
                        {account.isCurrentUser
                          ? `踢出其他设备 (${Math.max(0, account.login.activeSessions - 1)})`
                          : `强制下线 (${account.login.activeSessions})`}
                      </AsyncButton>

                      <AsyncButton
                        className={account.enabled ? "button button--danger-quiet" : "button button--primary"}
                        type="button"
                        title={disableLockReason}
                        busy={actionBusyKey === `disable-${account.id}`}
                        busyLabel={account.enabled ? "停用中…" : "启用中…"}
                        disabled={actionBusyKey !== null || (account.enabled && Boolean(disableLockReason))}
                        onClick={() => void toggleAccountDisabled(account)}
                      >
                        {account.enabled ? "停用账号" : "恢复启用"}
                      </AsyncButton>
                    </div>
                  </footer>
                </article>
              );
            })}
          </div>
        )}

        {data && data.recentEvents.length > 0 ? (
          <section className="admin-audit-section" aria-label="全站最近安全与管理动态">
            <div className="section-heading">
              <div>
                <p className="eyebrow">安全审计</p>
                <h2>最近登录与管理动态</h2>
              </div>
              <span className="count-pill">最近 {data.recentEvents.length} 条</span>
            </div>
            <ul className="admin-audit-list">
              {data.recentEvents.slice(0, 10).map((event) => (
                <li key={event.id}>
                  <div>
                    <strong>{event.username ?? "已删除账号"}</strong>
                    <span>{describeSecurityEvent(event)}</span>
                  </div>
                  <time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {createOpen ? (
          <div
            className="revision-dialog-backdrop"
            onClick={(event) => {
              if (event.target === event.currentTarget && !createBusy) setCreateOpen(false);
            }}
          >
            <div className="revision-dialog" role="dialog" aria-modal="true" aria-labelledby="create-account-title">
              <form className="revision-dialog-form" onSubmit={(event) => void submitCreateAccount(event)}>
                <div className="revision-dialog-heading">
                  <div>
                    <p className="eyebrow">账号管理</p>
                    <h2 id="create-account-title">新建账号</h2>
                  </div>
                  <button
                    className="button button--ghost"
                    type="button"
                    disabled={createBusy}
                    onClick={() => setCreateOpen(false)}
                  >
                    关闭
                  </button>
                </div>
                <div className="revision-dialog-body">
                  {createError ? <p className="revision-dialog-error" role="alert">{createError}</p> : null}
                  <label className="revision-dialog-field">
                    <span>用户名</span>
                    <input
                      required
                      autoFocus
                      disabled={createBusy}
                      value={createUsername}
                      placeholder="例如：teacher_wang（3-32 位字母、数字、._-）"
                      onChange={(event) => setCreateUsername(event.target.value)}
                    />
                  </label>
                  <label className="revision-dialog-field">
                    <span>账号角色</span>
                    <select
                      disabled={createBusy}
                      value={createRole}
                      onChange={(event) => setCreateRole(event.target.value as "teacher" | "admin")}
                    >
                      <option value="teacher">教师（日常批改、审核与导出）</option>
                      <option value="admin">管理员（可配置 AI 模型与管理全部账号）</option>
                    </select>
                  </label>
                  <div className="revision-dialog-field">
                    <div className="password-field-header">
                      <label htmlFor="create-account-password">初始登录密码</label>
                      <button
                        className="text-button"
                        type="button"
                        disabled={createBusy}
                        onClick={() => setCreatePassword(generateRandomPassword())}
                      >
                        重新随机生成
                      </button>
                    </div>
                    <input
                      id="create-account-password"
                      type="text"
                      required
                      minLength={8}
                      disabled={createBusy}
                      value={createPassword}
                      onChange={(event) => setCreatePassword(event.target.value)}
                    />
                    <p className="revision-dialog-scope">创建成功后会生成可一键复制的登录通知卡片，明文密码不会上传至服务器。</p>
                  </div>
                  <label className="batch-reanalysis-option">
                    <input
                      type="checkbox"
                      disabled={createBusy}
                      checked={createMustChange}
                      onChange={(event) => setCreateMustChange(event.target.checked)}
                    />
                    <span>首次登录时要求本人修改密码（推荐）</span>
                  </label>
                </div>
                <div className="revision-dialog-actions">
                  <button
                    className="button button--quiet"
                    type="button"
                    disabled={createBusy}
                    onClick={() => setCreateOpen(false)}
                  >
                    取消
                  </button>
                  <button className="button button--primary" type="submit" disabled={createBusy}>
                    {createBusy ? "正在加密创建…" : "确认创建账号"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        ) : null}

        {resetTarget ? (
          <div
            className="revision-dialog-backdrop"
            onClick={(event) => {
              if (event.target === event.currentTarget && !resetBusy) setResetTarget(null);
            }}
          >
            <div className="revision-dialog" role="dialog" aria-modal="true" aria-labelledby="reset-password-title">
              <form className="revision-dialog-form" onSubmit={(event) => void submitResetPassword(event)}>
                <div className="revision-dialog-heading">
                  <div>
                    <p className="eyebrow">安全操作</p>
                    <h2 id="reset-password-title">重置「{resetTarget.username}」的密码</h2>
                  </div>
                  <button
                    className="button button--ghost"
                    type="button"
                    disabled={resetBusy}
                    onClick={() => setResetTarget(null)}
                  >
                    关闭
                  </button>
                </div>
                <div className="revision-dialog-body">
                  {resetError ? <p className="revision-dialog-error" role="alert">{resetError}</p> : null}
                  <div className="revision-dialog-field">
                    <div className="password-field-header">
                      <label htmlFor="reset-account-password">新登录密码</label>
                      <button
                        className="text-button"
                        type="button"
                        disabled={resetBusy}
                        onClick={() => setResetPasswordValue(generateRandomPassword())}
                      >
                        重新随机生成
                      </button>
                    </div>
                    <input
                      id="reset-account-password"
                      type="text"
                      required
                      minLength={8}
                      disabled={resetBusy}
                      value={resetPasswordValue}
                      onChange={(event) => setResetPasswordValue(event.target.value)}
                    />
                    <p className="revision-dialog-scope">重置密码会同时清除该账号近期的失败登录锁定记录。</p>
                  </div>
                  {!resetTarget.isCurrentUser ? (
                    <label className="batch-reanalysis-option">
                      <input
                        type="checkbox"
                        disabled={resetBusy}
                        checked={resetMustChange}
                        onChange={(event) => setResetMustChange(event.target.checked)}
                      />
                      <span>下次登录时要求本人修改密码（推荐）</span>
                    </label>
                  ) : null}
                  <label className="batch-reanalysis-option">
                    <input
                      type="checkbox"
                      disabled={resetBusy}
                      checked={resetRevokeSessions}
                      onChange={(event) => setResetRevokeSessions(event.target.checked)}
                    />
                    <span>
                      {resetTarget.isCurrentUser
                        ? "同时踢出当前账号在其他设备上的登录会话"
                        : "同时强制下线该账号已登录的所有设备会话"}
                    </span>
                  </label>
                </div>
                <div className="revision-dialog-actions">
                  <button
                    className="button button--quiet"
                    type="button"
                    disabled={resetBusy}
                    onClick={() => setResetTarget(null)}
                  >
                    取消
                  </button>
                  <button className="button button--primary" type="submit" disabled={resetBusy}>
                    {resetBusy ? "正在重置…" : "确认重置密码"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
