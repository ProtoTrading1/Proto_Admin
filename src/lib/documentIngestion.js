import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import {
  MAX_EXTRACTED_TEXT,
  classifyDocument,
  documentExtension,
} from '../../lib/workspace-documents.mjs';

const MAX_PDF_PAGES = 40;
const MAX_SHEETS = 12;

function cap(value) {
  return String(value || '').replace(/\u0000/g, '').slice(0, MAX_EXTRACTED_TEXT).trim();
}

function xmlText(xml) {
  try {
    const document = new DOMParser().parseFromString(xml, 'application/xml');
    return document.documentElement?.textContent || '';
  } catch {
    return String(xml || '').replace(/<[^>]+>/g, ' ');
  }
}

async function extractPdf(file, onProgress) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    onProgress?.({ phase: 'extracting', progress: pageNumber / pageCount, detail: `Reading PDF page ${pageNumber} of ${pageCount}` });
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str || '').join(' '));
    if (pages.join('\n').length >= MAX_EXTRACTED_TEXT) break;
  }
  return cap(pages.join('\n'));
}

async function extractSpreadsheet(file, onProgress) {
  onProgress?.({ phase: 'extracting', progress: 0.2, detail: 'Reading spreadsheet structure' });
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  return cap(workbook.SheetNames.slice(0, MAX_SHEETS).map((sheetName, index) => {
    onProgress?.({ phase: 'extracting', progress: (index + 1) / Math.min(workbook.SheetNames.length, MAX_SHEETS), detail: `Reading sheet ${sheetName}` });
    return `Sheet: ${sheetName}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName], { blankrows: false })}`;
  }).join('\n\n'));
}

async function extractOpenXml(file, extension, onProgress) {
  onProgress?.({ phase: 'extracting', progress: 0.25, detail: extension === 'docx' ? 'Reading Word document' : 'Reading presentation' });
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const paths = extension === 'docx'
    ? Object.keys(zip.files).filter((path) => /^word\/(document|header\d*|footer\d*)\.xml$/i.test(path))
    : Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const chunks = [];
  for (let index = 0; index < paths.length; index += 1) {
    const xml = await zip.file(paths[index])?.async('string');
    if (xml) chunks.push(xmlText(xml));
    onProgress?.({ phase: 'extracting', progress: (index + 1) / Math.max(paths.length, 1), detail: `Reading section ${index + 1} of ${paths.length}` });
    if (chunks.join('\n').length >= MAX_EXTRACTED_TEXT) break;
  }
  return cap(chunks.join('\n'));
}

async function extractImage(file, onProgress) {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng', 1, {
    logger: (message) => {
      if (message.status === 'recognizing text') {
        onProgress?.({ phase: 'ocr', progress: Number(message.progress || 0), detail: `Reading image text · ${Math.round(Number(message.progress || 0) * 100)}%` });
      }
    },
  });
  try {
    const result = await worker.recognize(file);
    return cap(result.data?.text);
  } finally {
    await worker.terminate();
  }
}

export async function hashDocumentFile(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function ingestDocumentFile(file, { selectedCategory = 'general', contentHash = '', onProgress } = {}) {
  const extension = documentExtension(file.name);
  let text = '';
  let status = 'unsupported';
  try {
    if (['txt', 'csv', 'eml'].includes(extension)) text = cap(await file.text());
    else if (extension === 'rtf') text = cap((await file.text()).replace(/\\[a-z]+\d* ?|[{}]/gi, ' '));
    else if (extension === 'pdf') text = await extractPdf(file, onProgress);
    else if (['xls', 'xlsx'].includes(extension)) text = await extractSpreadsheet(file, onProgress);
    else if (['docx', 'pptx'].includes(extension)) text = await extractOpenXml(file, extension, onProgress);
    else if (file.type?.startsWith('image/')) text = await extractImage(file, onProgress);
    status = text ? 'ready' : 'unsupported';
  } catch (error) {
    console.warn('Document extraction failed:', error?.message || error);
    status = 'failed';
  }
  onProgress?.({ phase: 'classifying', progress: 0.95, detail: 'Classifying operational context' });
  const classification = classifyDocument({ filename: file.name, text, selectedCategory });
  return {
    contentHash: contentHash || await hashDocumentFile(file),
    extractedText: text,
    extractionStatus: status,
    ...classification,
  };
}
