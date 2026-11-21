"use client";

import Link from "next/link";

export function AdminSubnav({
  active,
  actions,
}: {
  active: "models" | "accounts";
  actions?: React.ReactNode;
}) {
  return (
    <div className="admin-subnav-bar">
      <nav className="segmented-control" aria-label="管理员功能切换">
        <Link
          className={active === "models" ? "segmented-link is-active" : "segmented-link"}
          aria-current={active === "models" ? "page" : undefined}
          href="/settings"
        >
          模型连接设置
        </Link>
        <Link
          className={active === "accounts" ? "segmented-link is-active" : "segmented-link"}
          aria-current={active === "accounts" ? "page" : undefined}
          href="/settings/accounts"
        >
          账号与活跃监控
        </Link>
      </nav>
      {actions ? <div className="admin-subnav-actions">{actions}</div> : null}
    </div>
  );
}
