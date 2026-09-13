import * as pdfjsLib from './vendor/pdf.min.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';

export class PdfPasswordError extends Error {
  constructor(kind) {
    super(`PDF requires a password (${kind})`);
    this.kind = kind; // 'required' | 'incorrect'
  }
}

export class PdfNoTextError extends Error {
  constructor() {
    super('This PDF has no extractable text layer (it is likely a scanned image).');
  }
}

export async function extractPdfText(file, password) {
  const arrayBuffer = await file.arrayBuffer();
  const params = { data: arrayBuffer };
  if (password) params.password = password;

  let pdf;
  try {
    pdf = await pdfjsLib.getDocument(params).promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') {
      throw new PdfPasswordError(err.code === 1 ? 'required' : 'incorrect');
    }
    throw err;
  }

  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    fullText += reconstructLines(content.items) + '\n';
  }

  if (!fullText.replace(/\s+/g, '').length) {
    throw new PdfNoTextError();
  }

  return fullText;
}

function reconstructLines(items) {
  const Y_TOLERANCE = 2;
  const rows = [];

  for (const item of items) {
    if (!item.str) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) <= Y_TOLERANCE);
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push({ x, width: item.width || 0, str: item.str });
  }

  rows.sort((a, b) => b.y - a.y);

  return rows
    .map((row) => {
      row.items.sort((a, b) => a.x - b.x);
      let line = '';
      let prevEnd = null;
      for (const it of row.items) {
        if (prevEnd !== null && it.x - prevEnd > 1.5) line += ' ';
        line += it.str;
        prevEnd = it.x + it.width;
      }
      return line.replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean)
    .join('\n');
}
