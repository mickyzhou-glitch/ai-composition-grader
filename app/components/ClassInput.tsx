"use client";

import { useId, useRef, useState } from "react";
import { apiFetch } from "../lib/api";

export function ClassInput({
  value,
  onChange,
  disabled = false,
  className = "class-field",
  label = "班级（选填）",
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  label?: string;
}) {
  const id = useId();
  const [classes, setClasses] = useState<string[]>([]);
  const loading = useRef(false);
  async function load() {
    if (loading.current) return;
    loading.current = true;
    try { setClasses(await apiFetch<string[]>("/api/classes")); }
    catch { loading.current = false; }
  }
  return <label className={className}>{label}<input aria-label="班级" list={id} maxLength={50} placeholder="填写或选择班级，如六（1）班" value={value} disabled={disabled} onFocus={() => void load()} onChange={(event) => onChange(event.target.value)} /><datalist id={id}>{classes.map((name) => <option key={name} value={name} />)}</datalist></label>;
}
