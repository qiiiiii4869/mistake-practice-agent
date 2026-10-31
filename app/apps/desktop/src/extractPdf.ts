import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { validateDocument, type KnowledgeDocument } from '../../../packages/knowledge/src';

GlobalWorkerOptions.workerSrc = workerUrl;
// Pack CMaps and fonts locally: textbook PDFs may use non-embedded Chinese fonts.
const cMapUrl = new URL('./pdf-assets/cmaps/', document.baseURI).href;
const standardFontDataUrl = new URL('./pdf-assets/standard_fonts/', document.baseURI).href;

export async function extractPdf(file: File, progress: (page: number, total: number) => void,knownIds:string[]=[]): Promise<KnowledgeDocument> {
  if (!file.name.toLowerCase().endsWith('.pdf') || file.size > 40 * 1024 * 1024 || !file.size) throw new Error('knowledge_pdf_limit');
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Do not embed the PDF magic string in this module: Tauri's content-based
  // MIME detector also scans JavaScript and can mislabel the entire JS asset.
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d];
  if (!bytes.subarray(0, 1024).some((_, offset, prefix) => magic.every((value, index) => prefix[offset + index] === value)))
    throw new Error('knowledge_pdf_failed');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const id = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  // Fingerprint before opening PDF.js: renamed duplicate files do not repeat
  // extraction or question processing. Normal use reads only the SQLite cache.
  if(knownIds.includes(id))throw new Error('knowledge_duplicate');
  const task = getDocument({ data: bytes, cMapUrl, standardFontDataUrl, useWasm: false,
    enableXfa: false, stopAtErrors: true, disableFontFace: true, useSystemFonts: false });
  // Never display a password prompt or leave a pending encrypted-file load.
  task.onPassword = () => { void task.destroy(); };
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 1000) throw new Error('knowledge_pdf_limit');
    const pages = [];
    let totalBytes = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      progress(number, pdf.numPages);
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
      totalBytes += new TextEncoder().encode(text).length;
      if ([...text].length > 100000 || totalBytes > 20 * 1024 * 1024) throw new Error('invalid_knowledge_document');
      pages.push({ number, text }); page.cleanup();
    }
    return validateDocument({ id, name: file.name, pages });
  } catch (error) {
    if (error instanceof Error && ['knowledge_pdf_limit', 'invalid_knowledge_document', 'knowledge_no_text'].includes(error.message)) throw error;
    throw new Error('knowledge_pdf_failed');
  } finally { await task.destroy(); }
}
