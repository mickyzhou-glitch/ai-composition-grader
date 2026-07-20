import Link from "next/link";

export function AppHeader({ compact = false }: { compact?: boolean }) {
  return (
    <header className={compact ? "app-header app-header--compact" : "app-header"}>
      <Link className="wordmark" href="/" aria-label="返回批改历史首页">
        <span className="seal" aria-hidden="true">批</span>
        <span>朱批 <b>·</b> AI作文批改助手</span>
      </Link>
      <nav className="header-actions" aria-label="主要操作">
        <Link className="button button--primary" href="/new">新建作文批改</Link>
        <Link className="button button--quiet" href="/settings">设置</Link>
      </nav>
    </header>
  );
}
