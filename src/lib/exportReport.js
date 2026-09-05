/** Download rows as CSV (Excel-compatible). */
export function downloadCsv(filename, columns, rows) {
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = columns.map((c) => escape(c.header)).join(',');
  const lines = (rows || []).map((row) => columns.map((c) => escape(typeof c.value === 'function' ? c.value(row) : row[c.key])).join(','));
  const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Download rows as .xlsx using dynamic import. */
export async function downloadExcel(filename, sheetName, columns, rows) {
  const XLSX = await import('xlsx');
  const data = [
    columns.map((c) => c.header),
    ...(rows || []).map((row) => columns.map((c) => (typeof c.value === 'function' ? c.value(row) : row[c.key] ?? ''))),
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, filename);
}
