export interface PaperPage { id: string; name: string; data: string }
export interface PaperQuestion { number: string; pageId: string; stem: string; confirmed: boolean }
export interface Paper { pages: PaperPage[]; questions: PaperQuestion[] }

// Only local raster images; no active SVG or remote resources.
export function validatePaper(value: unknown, numbers: string[]): Paper {
  const bad = (): never => { throw new Error('invalid_paper'); };
  if (!value || typeof value !== 'object') return bad();
  const p = value as Paper;
  if (!Array.isArray(p.pages) || !Array.isArray(p.questions) || p.pages.length > 30 || p.questions.length > numbers.length) return bad();
  let total = 0;
  const ids = new Set<string>(), used = new Set<string>();
  const pages = p.pages.map(page => {
    if (!page || typeof page.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(page.id) || ids.has(page.id)
      || typeof page.name !== 'string' || !page.name.trim() || page.name.length > 300 || typeof page.data !== 'string'
      || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(page.data)) return bad();
    total += page.data.length;
    if (total > 8 * 1024 * 1024) return bad();
    ids.add(page.id);
    return { id: page.id, name: page.name, data: page.data };
  });
  const questions = p.questions.map(q => {
    if (!q || !numbers.includes(q.number) || used.has(q.number) || !ids.has(q.pageId)
      || typeof q.stem !== 'string' || q.stem.length > 20000 || typeof q.confirmed !== 'boolean'
      || (q.confirmed && !q.stem.trim())) return bad();
    used.add(q.number);
    return { number: q.number, pageId: q.pageId, stem: q.stem, confirmed: q.confirmed };
  });
  return { pages, questions };
}
