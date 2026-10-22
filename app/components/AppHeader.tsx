"use client";

import { useState } from "react";
import Link from "next/link";

import { apiFetch, errorMessage } from "../lib/api";
import { replaceDocument } from "../lib/document-navigation";
import { AsyncButton } from "./AsyncButton";
import { useAuthRole } from "./AuthUserContext";
import { usePendingRules } from "./PendingRulesContext";

export function AppHeader({ compact = false, userRole }: { compact?: boolean; userRole?: "admin" | "teacher" }) {
  const contextRole = useAuthRole();
  const role = userRole ?? contextRole;
  const pendingRules = usePendingRules()?.count ?? 0;
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  async function logout() {
    setLoggingOut(true);
    setLogoutError("");
    try {
      await apiFetch<{ loggedOut: boolean }>("/api/auth/logout", { method: "POST" });
      replaceDocument("/login");
    } catch (error) {
      setLogoutError(errorMessage(error));
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <header className={compact ? "app-header app-header--compact" : "app-header"}>
      <Link className="wordmark" href="/" aria-label="返回批改历史首页">
        <span className="seal" aria-hidden="true">批</span>
        <span>青藤未来作文批改助手</span>
      </Link>
      <nav className="header-actions" aria-label="主要操作">
        <Link
          className="button button--quiet nav-with-badge"
          href="/opinions"
          aria-label={pendingRules > 0 ? `长期批改规则（${pendingRules} 条待审批）` : "长期批改规则"}
        >
          长期批改规则
          {pendingRules > 0 ? <span className="nav-badge" aria-hidden="true">{pendingRules > 99 ? "99+" : pendingRules}</span> : null}
        </Link>
        <Link className="button button--primary" href="/new">新建作文批改</Link>
        {role === "admin" ? <Link className="button button--quiet" href="/settings">设置</Link> : null}
        <AsyncButton
          className="button button--quiet"
          type="button"
          busy={loggingOut}
          busyLabel="正在退出…"
          onClick={() => void logout()}
        >
          退出登录
        </AsyncButton>
        {logoutError ? <span className="header-action-error" role="alert">{logoutError}</span> : null}
      </nav>
    </header>
  );
}
