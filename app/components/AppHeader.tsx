"use client";

import Link from "next/link";
import { useAuthRole } from "./AuthUserContext";

export function AppHeader({ compact = false, userRole }: { compact?: boolean; userRole?: "admin" | "teacher" }) {
  const contextRole = useAuthRole();
  const role = userRole ?? contextRole;
  return (
    <header className={compact ? "app-header app-header--compact" : "app-header"}>
      <Link className="wordmark" href="/" aria-label="返回批改历史首页">
        <span className="seal" aria-hidden="true">批</span>
        <span>朱批 <b>·</b> AI作文批改助手</span>
      </Link>
      <nav className="header-actions" aria-label="主要操作">
        <Link className="button button--primary" href="/new">新建作文批改</Link>
        {role === "admin" ? <Link className="button button--quiet" href="/settings">设置</Link> : null}
      </nav>
    </header>
  );
}
