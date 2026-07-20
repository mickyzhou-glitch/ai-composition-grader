import type { ButtonHTMLAttributes, ReactNode } from "react";

interface AsyncButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  busy?: boolean;
  busyLabel?: string;
  children: ReactNode;
}

export function AsyncButton({ busy = false, busyLabel = "处理中…", children, disabled, ...props }: AsyncButtonProps) {
  return (
    <button {...props} disabled={disabled || busy} aria-busy={busy}>
      {busy ? busyLabel : children}
    </button>
  );
}
