/** Truncate long SKU/filename text with ellipsis; full value on hover via title. */
export default function LoaderCodeEllipsis({
  value,
  strong = true,
  maxCh = 20,
  className = '',
  /** When true, fill table cell width (use with .pl-table-clip). */
  fill = false,
}) {
  const text = String(value ?? '').trim();
  if (!text) return <span>—</span>;
  const content = strong ? <strong>{text}</strong> : text;
  return (
    <span
      className={`pm-code-ellipsis${fill ? ' pm-code-ellipsis--fill' : ''} ${className}`.trim()}
      style={fill ? undefined : { maxWidth: `${maxCh}ch` }}
      title={text}
    >
      {content}
    </span>
  );
}
