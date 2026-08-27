"use client";

import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef, useState } from "react";

import type { ExportFormat } from "../lib/review-export";

interface ExportMenuProps {
  onExport: (format: ExportFormat) => void | Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
  busy?: boolean;
  busyLabel?: string;
  className?: string;
  ariaLabel?: string;
}

export function ExportMenu({
  onExport,
  disabled = false,
  disabledReason,
  busy = false,
  busyLabel = "正在生成…",
  className = "",
  ariaLabel,
}: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const reasonId = useId();

  const closeAndRestoreFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAndRestoreFocus();
    };
    const onDocumentClick = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      closeAndRestoreFocus();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onDocumentClick);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onDocumentClick);
    };
  }, [open]);

  const moveMenuFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [],
    );
    if (items.length === 0) return;

    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | undefined;
    if (event.key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    if (event.key === "ArrowUp") nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex === undefined) return;

    event.preventDefault();
    items[nextIndex]?.focus();
  };

  const select = (format: ExportFormat) => {
    closeAndRestoreFocus();
    void onExport(format);
  };

  const unavailable = disabled || busy;
  return <div className={`export-menu ${className}`.trim()} ref={rootRef}>
    <button
      ref={triggerRef}
      className="button button--quiet export-menu-trigger"
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={ariaLabel}
      aria-describedby={disabledReason ? reasonId : undefined}
      disabled={unavailable}
      onClick={() => setOpen((current) => !current)}
    >{busy ? busyLabel : "导出"}</button>
    {open ? <div
      ref={menuRef}
      className="export-menu-popover"
      role="menu"
      aria-label="选择导出格式"
      onKeyDown={moveMenuFocus}
    >
      <button type="button" role="menuitem" onClick={() => select("pdf")}>PDF</button>
      <button type="button" role="menuitem" onClick={() => select("docx")}>Word (.docx)</button>
    </div> : null}
    {disabledReason ? <span className="export-menu-reason" id={reasonId}>{disabledReason}</span> : null}
  </div>;
}
