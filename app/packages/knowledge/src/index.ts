export interface KnowledgePage { number: number; text: string }
export const KNOWLEDGE_RETRIEVAL_VERSION='processed-library-v1' as const;
export interface BankQuestion {
  id:string;number:string;pageStart:number;pageEnd:number;stem:string;
  options:{label:string;text:string}[];answer:string;explanation:string;
  answerPages:number[];
  knowledgeNotes:string[];taskPatterns:string[];
  knowledgePoints:string[];type:'choice'|'non_choice'|'unknown';difficulty:'unrated';warnings:string[];
}
export interface ProcessedKnowledge {version:'knowledge-processor-v1';kind:'question_bank'|'reference';questions:BankQuestion[];warnings:string[]}
export interface ProcessingSummary {version:string;kind:string;questionCount:number;answerCount:number;explanationCount:number;warnings:string[]}
export interface KnowledgeDocument { id: string; name: string; pages: KnowledgePage[];processed?:ProcessedKnowledge }
export interface KnowledgeSummary {
  id: string; name: string; pageCount: number; chunkCount: number; emptyPages: number[];
  processing?:ProcessingSummary|null;
}
export interface KnowledgeLibrary { revision: number; documents: KnowledgeSummary[] }
export interface KnowledgeHit { documentId: string; name: string; page: number; ordinal: number; text: string;kind?:string;questionId?:string|null;questionNumber?:string|null }

export function normalizePage(text: string): string {
  return text.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').replace(/[\t \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function validateDocument(value: KnowledgeDocument): KnowledgeDocument {
  const fail = (): never => { throw new Error('invalid_knowledge_document'); };
  if (!value || !/^[a-f0-9]{64}$/.test(value.id) || typeof value.name !== 'string' || !value.name.trim()
    || [...value.name].length > 300 || !Array.isArray(value.pages) || !value.pages.length || value.pages.length > 1000) return fail();
  let total = 0;
  const pages = value.pages.map((p, i) => {
    if (!p || p.number !== i + 1 || typeof p.text !== 'string' || [...p.text].length > 100000) return fail();
    const text = normalizePage(p.text); total += new TextEncoder().encode(text).length;
    if (total > 20 * 1024 * 1024) return fail();
    return { number: p.number, text };
  });
  if (!pages.some(p => p.text)) throw new Error('knowledge_no_text');
  return { id: value.id, name: value.name.trim(), pages,...(value.processed?{processed:value.processed}:{}) };
}

export function knowledgeError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  return ({
    knowledge_no_text: '这份 PDF 没有可提取的文字，尚未导入。扫描件需等待图像识别。',
    knowledge_duplicate: '相同 PDF 已在知识库中，无需重复导入。',
    knowledge_cache_corrupt: '已保存的处理结果损坏，请用已存文字重新处理；原资料保留。',
    knowledge_processing_invalid: '题库处理结果格式不完整，本次没有替换已存资料。',
    knowledge_processing_limit: '单份最多处理10000道题，请将题库分成多个文件导入。',
    knowledge_conflict: '知识库已在其他窗口改变，请点击刷新后再试。',
    knowledge_limit: '知识库容量已到上限，请先删除不再需要的文档。',
    knowledge_invalid_query: '请输入 1 至 100 字的检索词。',
    invalid_knowledge_document: '文档内容超出限制或格式不完整，本次没有导入。',
    knowledge_pdf_limit: '请选择不超过 40 MB、1000 页的 PDF。',
    knowledge_pdf_failed: 'PDF 文字提取失败，可能已加密、损坏或字体不受支持。本次没有导入。',
    storage_failed: '本机知识库存储失败，请刷新并核对后再试。',
  } as Record<string, string>)[code] ?? '知识库操作未完成，请检查文件并重试。';
}
