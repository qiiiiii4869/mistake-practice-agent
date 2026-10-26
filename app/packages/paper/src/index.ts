export interface PaperPage { id: string; name: string; data: string }
export interface PaperQuestion { number: string; pageId: string; stem: string; confirmed: boolean }
export interface Paper { pages: PaperPage[]; questions: PaperQuestion[] }
export interface Recognition {questions:{number:string;stem:string;confidence:'high'|'low'}[];warnings:string[]}
export function validateRecognition(value:unknown,numbers:string[]):Recognition {
  const fail=():never=>{throw new Error('invalid_paper_recognition');};
  if(!value||typeof value!=='object')return fail();const v=value as Recognition;
  if(!Array.isArray(v.questions)||v.questions.length>numbers.length||!Array.isArray(v.warnings)||v.warnings.length>100)return fail();
  const used=new Set<string>();
  const questions=v.questions.map(q=>{if(!q||!numbers.includes(q.number)||used.has(q.number)||typeof q.stem!=='string'||!q.stem.trim()||q.stem.length>20000||!['high','low'].includes(q.confidence))return fail();used.add(q.number);return {number:q.number,stem:q.stem,confidence:q.confidence};});
  const warnings=v.warnings.map(w=>typeof w==='string'&&w.length<=2000?w:fail());return {questions,warnings};
}
export function applyRecognition(paper:Paper,pageId:string,recognition:Recognition,numbers:string[]):Paper {
  const result=validateRecognition(recognition,numbers);
  if(!paper.pages.some(p=>p.id===pageId))throw new Error('invalid_paper');
  const replaced=new Set(result.questions.map(q=>q.number));
  return validatePaper({...paper,questions:[...paper.questions.filter(q=>!replaced.has(q.number)),...result.questions.map(q=>({number:q.number,stem:q.stem,pageId,confirmed:false}))]},numbers);
}

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
      || !/^data:(?:image\/(?:png|jpeg|webp)|application\/(?:pdf|vnd\.openxmlformats-officedocument\.wordprocessingml\.document));base64,[A-Za-z0-9+/]+={0,2}$/.test(page.data)) return bad();
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
