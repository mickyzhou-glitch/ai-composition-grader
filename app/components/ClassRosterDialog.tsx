"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  codePointLength,
  MAX_ROSTER_CLASS_NAME_CHARS,
  MAX_ROSTER_STUDENTS_PER_CLASS,
  parseMultiClassRosterText,
  parseRosterStudentText,
  type ClassRosterView,
} from "@/src/domain/class-roster";
import { errorMessage } from "../lib/api";

export type RosterSavePayload =
  | { className: string; students: string[]; mode?: "replace" | "append" }
  | { rosters: Array<{ className: string; students: string[] }>; mode?: "replace" | "append" };

export interface ClassRosterDialogProps {
  open: boolean;
  initialClassName: string;
  knownClasses: readonly string[];
  rosters: readonly ClassRosterView[];
  onClose(): void;
  onSave(payload: RosterSavePayload): Promise<void>;
  onDelete(className: string): Promise<void>;
}

async function readRosterTextFromFile(file: File): Promise<string> {
  if (!file.size) throw new Error("所选名单文件为空");
  if (file.size > 10 * 1024 * 1024) throw new Error("名单文件不能超过 10MB");
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "docx") {
    const mammoth = await import("mammoth/mammoth.browser");
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value ?? "";
  }
  if (ext === "txt" || ext === "csv" || ext === "tsv") {
    return file.text();
  }
  throw new Error("请选择 .txt、.csv 或 Word（.docx）格式名单文件");
}

export function ClassRosterDialog({
  open,
  initialClassName,
  knownClasses,
  rosters,
  onClose,
  onSave,
  onDelete,
}: ClassRosterDialogProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  const rosterByClass = useMemo(
    () => new Map(rosters.map((item) => [item.className, item.students])),
    [rosters],
  );

  const allClasses = useMemo(
    () => [...new Set([...knownClasses, ...rosters.map((item) => item.className)].filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true })),
    [knownClasses, rosters],
  );

  const defaultClass = initialClassName || allClasses[0] || "";

  const [tab, setTab] = useState<"single" | "multi">("single");
  const [className, setClassName] = useState(defaultClass);
  const [studentText, setStudentText] = useState(() => (rosterByClass.get(defaultClass) ?? []).join("\n"));
  const [multiText, setMultiText] = useState("");
  const [multiMode, setMultiMode] = useState<"replace" | "append">("replace");
  const [submitting, setSubmitting] = useState(false);
  const [importingFile, setImportingFile] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const background = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdropRef.current)
      .map((element) => ({ element, wasInert: element.hasAttribute("inert") }));
    background.forEach(({ element }) => element.setAttribute("inert", ""));
    document.body.style.overflow = "hidden";
    firstInputRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      background.forEach(({ element, wasInert }) => {
        if (!wasInert) element.removeAttribute("inert");
      });
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, [open]);

  const parsedSingle = useMemo(() => parseRosterStudentText(studentText), [studentText]);
  const parsedMulti = useMemo(() => parseMultiClassRosterText(multiText), [multiText]);

  if (!open || typeof document === "undefined") return null;

  const trimmedClass = className.trim();
  const existingForClass = rosterByClass.get(trimmedClass);
  const singleClassValid = trimmedClass.length > 0 && codePointLength(trimmedClass) <= MAX_ROSTER_CLASS_NAME_CHARS;
  const singleStudentsValid = parsedSingle.students.length > 0 && parsedSingle.students.length <= MAX_ROSTER_STUDENTS_PER_CLASS;
  const canSubmitSingle = singleClassValid && singleStudentsValid && !submitting && !importingFile;
  const canSubmitMulti = parsedMulti.rosters.length > 0 && !submitting && !importingFile;

  function switchClassChip(targetClass: string) {
    setClassName(targetClass);
    setStudentText((rosterByClass.get(targetClass) ?? []).join("\n"));
    setError("");
  }

  async function handleFileImport(file: File | undefined, target: "single" | "multi") {
    if (!file || importingFile || submitting) return;
    setImportingFile(true);
    setError("");
    try {
      const content = await readRosterTextFromFile(file);
      if (target === "single") {
        setStudentText((current) => (current.trim() ? `${current.trim()}\n${content}` : content));
      } else {
        setMultiText((current) => (current.trim() ? `${current.trim()}\n${content}` : content));
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setImportingFile(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || importingFile) return;
    setError("");
    setSubmitting(true);
    try {
      if (tab === "single") {
        if (!singleClassValid) {
          setError("请先填写班级名称");
          return;
        }
        if (parsedSingle.students.length === 0) {
          setError("请至少输入 1 名学生姓名");
          return;
        }
        if (parsedSingle.students.length > MAX_ROSTER_STUDENTS_PER_CLASS) {
          setError(`单班最多支持 ${MAX_ROSTER_STUDENTS_PER_CLASS} 名学生，请检查是否粘贴了多余内容`);
          return;
        }
        await onSave({ className: trimmedClass, students: parsedSingle.students, mode: "replace" });
      } else {
        if (parsedMulti.rosters.length === 0) {
          setError("未识别到有效的「班级 + 姓名」行，请按每行「班级  姓名」格式粘贴");
          return;
        }
        await onSave({
          rosters: parsedMulti.rosters.map(({ className: cName, students }) => ({ className: cName, students })),
          mode: multiMode,
        });
      }
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteCurrent() {
    if (!existingForClass || submitting || importingFile) return;
    if (!window.confirm(`确认删除「${trimmedClass}」的整体学生名单？已上传的批改记录不会受影响。`)) return;
    setError("");
    setSubmitting(true);
    try {
      await onDelete(trimmedClass);
      setStudentText("");
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !submitting && !importingFile) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>("button, input:not(.visually-hidden), textarea, select") ?? [],
      ).filter((element) => !element.hasAttribute("disabled"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialogRef.current?.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  return createPortal(
    <div ref={backdropRef} className="revision-dialog-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="revision-dialog class-roster-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="class-roster-dialog-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <form className="revision-dialog-form" onSubmit={(event) => void handleSubmit(event)}>
          <div className="revision-dialog-heading">
            <div>
              <p className="eyebrow">班级花名册</p>
              <h2 id="class-roster-dialog-title">管理班级整体学生名单</h2>
            </div>
            <div className="segmented-control" role="tablist" aria-label="名单录入方式">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "single"}
                className={tab === "single" ? "active" : ""}
                disabled={submitting}
                onClick={() => { setTab("single"); setError(""); }}
              >
                按班级录入
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "multi"}
                className={tab === "multi" ? "active" : ""}
                disabled={submitting}
                onClick={() => { setTab("multi"); setError(""); }}
              >
                多班表格导入
              </button>
            </div>
          </div>

          <div className="revision-dialog-body">
            {tab === "single" ? (
              <>
                {allClasses.length > 0 ? (
                  <div className="roster-dialog-classes" role="group" aria-label="已有班级快速切换">
                    {allClasses.map((name) => {
                      const count = rosterByClass.get(name)?.length ?? 0;
                      const active = trimmedClass === name;
                      return (
                        <button
                          key={name}
                          type="button"
                          className={`roster-class-switch ${active ? "roster-class-switch--active" : ""}`}
                          disabled={submitting}
                          onClick={() => switchClassChip(name)}
                        >
                          <span>{name}</span>
                          <small>{count > 0 ? `${count}人` : "未设置"}</small>
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                <div className="revision-dialog-field">
                  <label htmlFor="roster-class-name">班级名称</label>
                  <input
                    id="roster-class-name"
                    ref={firstInputRef}
                    aria-label="名单班级名称"
                    maxLength={MAX_ROSTER_CLASS_NAME_CHARS}
                    placeholder="如：六（1）班"
                    value={className}
                    disabled={submitting}
                    onChange={(event) => {
                      const next = event.target.value;
                      setClassName(next);
                      const matched = rosterByClass.get(next.trim());
                      if (matched && !studentText.trim()) {
                        setStudentText(matched.join("\n"));
                      }
                      setError("");
                    }}
                  />
                </div>

                <div className="revision-dialog-field">
                  <div className="roster-field-header">
                    <label htmlFor="roster-student-list">本班整体学生名单</label>
                    <label className="roster-file-btn">
                      {importingFile ? "正在读取…" : "从文件导入（.txt / .csv / .docx）"}
                      <input
                        type="file"
                        className="visually-hidden"
                        accept=".txt,.csv,.tsv,.docx,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        disabled={submitting || importingFile}
                        onChange={(event) => {
                          void handleFileImport(event.target.files?.[0], "single");
                          event.currentTarget.value = "";
                        }}
                      />
                    </label>
                  </div>
                  <textarea
                    id="roster-student-list"
                    aria-label="本班整体学生名单"
                    rows={8}
                    placeholder={"直接粘贴全班学生姓名，每行一人，或用空格、顿号、逗号分隔：\n张三\n李四\n王五"}
                    value={studentText}
                    disabled={submitting}
                    onChange={(event) => {
                      setStudentText(event.target.value);
                      setError("");
                    }}
                  />
                  <p className="revision-dialog-scope">
                    保存一次即可长期复用；会自动清理前导序号（如 <code>1. 张三</code>）与汉字间排版空格（如 <code>张　三</code>）。
                  </p>
                  <div className="roster-parse-summary" role="status">
                    <span>
                      已识别 <strong>{parsedSingle.students.length}</strong> 名学生
                      {parsedSingle.students.length > 0
                        ? `：${parsedSingle.students.slice(0, 8).join("、")}${parsedSingle.students.length > 8 ? " 等" : ""}`
                        : ""}
                    </span>
                    {parsedSingle.duplicateNames.length > 0 ? (
                      <small>
                        已自动合并重复姓名：{parsedSingle.duplicateNames.join("、")}（若确有重名学生，建议标为「{parsedSingle.duplicateNames[0]}1 / {parsedSingle.duplicateNames[0]}2」）
                      </small>
                    ) : null}
                    {parsedSingle.ignoredTooLong.length > 0 ? (
                      <small>已跳过超长无效项 {parsedSingle.ignoredTooLong.length} 条</small>
                    ) : null}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="revision-dialog-field">
                  <div className="roster-field-header">
                    <label htmlFor="roster-multi-list">粘贴多班名单（每行「班级 + 姓名」）</label>
                    <label className="roster-file-btn">
                      {importingFile ? "正在读取…" : "从文件导入（.csv / .txt / .docx）"}
                      <input
                        type="file"
                        className="visually-hidden"
                        accept=".txt,.csv,.tsv,.docx,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        disabled={submitting || importingFile}
                        onChange={(event) => {
                          void handleFileImport(event.target.files?.[0], "multi");
                          event.currentTarget.value = "";
                        }}
                      />
                    </label>
                  </div>
                  <textarea
                    id="roster-multi-list"
                    aria-label="多班名单文本"
                    rows={8}
                    placeholder={"可直接从 Excel / WPS 选中「班级、姓名」两列复制粘贴：\n六（1）班\t张三\n六（1）班\t李四\n六（2）班\t王五"}
                    value={multiText}
                    disabled={submitting}
                    onChange={(event) => {
                      setMultiText(event.target.value);
                      setError("");
                    }}
                  />
                  <label className="roster-mode-select">
                    同名班级处理方式
                    <select
                      aria-label="同名班级处理方式"
                      value={multiMode}
                      disabled={submitting}
                      onChange={(event) => setMultiMode(event.target.value as "replace" | "append")}
                    >
                      <option value="replace">覆盖同名班级原有名单</option>
                      <option value="append">追加合并到同名班级名单</option>
                    </select>
                  </label>
                  <div className="roster-parse-summary" role="status">
                    <span>
                      已识别 <strong>{parsedMulti.rosters.length}</strong> 个班级
                      {parsedMulti.rosters.length > 0
                        ? `：${parsedMulti.rosters.map((item) => `${item.className}（${item.students.length}人）`).join("、")}`
                        : ""}
                    </span>
                    {parsedMulti.skippedLines > 0 ? (
                      <small>另有 {parsedMulti.skippedLines} 行未能拆分为「班级 + 姓名」已跳过</small>
                    ) : null}
                  </div>
                </div>
              </>
            )}

            {error ? <p className="revision-dialog-error" role="alert">{error}</p> : null}
          </div>

          <div className="revision-dialog-actions">
            {tab === "single" && existingForClass ? (
              <button
                type="button"
                className="button button--danger-quiet roster-delete-btn"
                disabled={submitting || importingFile}
                onClick={() => void handleDeleteCurrent()}
              >
                删除本班名单
              </button>
            ) : null}
            <button type="button" className="button button--quiet" disabled={submitting || importingFile} onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className="button button--primary"
              disabled={tab === "single" ? !canSubmitSingle : !canSubmitMulti}
              aria-busy={submitting}
            >
              {submitting
                ? "正在保存…"
                : tab === "single"
                  ? "保存本班名单"
                  : `批量保存（${parsedMulti.rosters.length} 个班）`}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
