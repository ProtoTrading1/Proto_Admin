// jspdf pulls in html2canvas (~200 KB) at build time. Load it on-demand so
// the initial admin bundle stays lean — only the code paths that generate
// or export PDFs pay the cost, and only the first time they run per session.

let _jspdfPromise = null;

export function loadJsPDF() {
  if (!_jspdfPromise) {
    _jspdfPromise = import('jspdf').then((mod) => mod.jsPDF || mod.default);
  }
  return _jspdfPromise;
}
