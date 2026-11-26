import { titleNames } from "../lib/classification";

export function TitleFilter({
  items = [],
  options,
  value,
  onChange,
}: {
  items?: { config?: { title?: string }; title?: string }[];
  options?: string[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const baseNames = options ?? titleNames(items);
  const names = value !== null && value !== "" && !baseNames.includes(value)
    ? [value, ...baseNames]
    : baseNames;

  return (
    <label className="class-field title-field">
      作文题目
      <select
        aria-label="作文题目"
        value={value === null ? "all" : `title:${value}`}
        onChange={(event) => onChange(event.target.value === "all" ? null : event.target.value.slice(6))}
      >
        <option value="all">全部题目</option>
        {names.map((title) => (
          <option key={title} value={`title:${title}`}>
            {title}
          </option>
        ))}
      </select>
    </label>
  );
}
