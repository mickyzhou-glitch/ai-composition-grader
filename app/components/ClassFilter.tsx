import { classNames } from "../lib/classification";

export function ClassFilter({ items = [], options, value, onChange }: {
  items?: { className?: string }[];
  options?: string[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const names = options ?? classNames(items);
  return <label className="class-field">班级筛选<select aria-label="班级筛选" value={value === null ? "all" : `class:${value}`} onChange={(event) => onChange(event.target.value === "all" ? null : event.target.value.slice(6))}>
    <option value="all">全部班级</option><option value="class:">未分类</option>
    {names.map((name) => <option key={name} value={`class:${name}`}>{name}</option>)}
  </select></label>;
}
