import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { knowledgeError, type KnowledgeDocument, type KnowledgeLibrary, type KnowledgeHit,type ProcessedKnowledge } from '../../../packages/knowledge/src';
import {biologyLibrary,searchBiology,formatBiologyCard} from '../../../packages/knowledge/src/biology';
import {biologyAuthoring,searchBiologyAuthoring} from '../../../packages/knowledge/src/biologyAuthoring';
import {KNOWLEDGE_PROCESSOR_VERSION,type ImportKind} from '../../../packages/knowledge/src/processKnowledge';
import {processKnowledgeFile} from './processKnowledgeFile';

export function KnowledgeWorkspace() {
  const [library, setLibrary] = React.useState<KnowledgeLibrary | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('正在读取本机知识库…');
  const [candidate, setCandidate] = React.useState<KnowledgeDocument | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [hits, setHits] = React.useState<KnowledgeHit[] | null>(null);
  const [searched, setSearched] = React.useState('');
  const [builtInHits,setBuiltInHits]=React.useState<ReturnType<typeof searchBiology>|null>(null);
  const [methodHits,setMethodHits]=React.useState<ReturnType<typeof searchBiologyAuthoring>|null>(null);
  const [importKind,setImportKind]=React.useState<ImportKind>('auto');
  const [processedView,setProcessedView]=React.useState<{name:string;value:ProcessedKnowledge}|null>(null);
  const [questionPage,setQuestionPage]=React.useState(0);
  const mounted = React.useRef(true);
  const locked = busy || candidate !== null || deleting !== null;
  React.useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, []);
  async function refresh() {
    setBusy(true);
    try {
      const value = await invoke<KnowledgeLibrary>('list_knowledge');
      if (mounted.current) { setLibrary(value); setMessage(`已加载 ${value.documents.length} 份本机文档。`); setHits(null); }
    } catch (error) { if (mounted.current) setMessage(knowledgeError(error)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function prepare(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || !library) return;
    setBusy(true); setMessage('正在本机提取 PDF 文字…');
    try {
      const { extractPdf } = await import('./extractPdf');
      const doc = await extractPdf(file, (page, total) => setMessage(`正在提取第 ${page} / ${total} 页…`),library.documents.map(d=>d.id));
      if (library.documents.some(d => d.id === doc.id)) throw new Error('knowledge_duplicate');
      setMessage('首次处理：正在拆题、区分答案解析并建立考点索引…');
      const processed=await processKnowledgeFile(doc,importKind);
      setCandidate(processed); setMessage(`首次处理完成：${processed.processed?.questions.length??0} 道题。请预览并确认，之后直接使用保存结果。`);
    } catch (error) { setMessage(knowledgeError(error)); }
    finally { setBusy(false); }
  }
  async function commit() {
    if (!candidate || !library) return;
    setBusy(true);setMessage('正在保存文字、结构记录和索引…');
    try {
      const saved = await invoke<KnowledgeLibrary>('import_knowledge', { expectedRevision: library.revision, document: candidate });
      setLibrary(saved); setCandidate(null); setHits(null); setMessage('已保存文字、题目、答案解析与索引。后续使用无需源文件，不会重复解析 PDF。');
    } catch (error) { setMessage(knowledgeError(error)); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!deleting || !library) return;
    setBusy(true);
    try {
      const saved = await invoke<KnowledgeLibrary>('remove_knowledge', { expectedRevision: library.revision, documentId: deleting });
      setLibrary(saved); setDeleting(null); setHits(null);setProcessedView(null); setMessage('已从知识库删除文档文字、处理结果及索引。原 PDF 与当前考试中已保存的引用片段保留。');
    } catch (error) { setMessage(knowledgeError(error)); }
    finally { setBusy(false); }
  }
  async function search(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setHits(null);setBuiltInHits(searchBiology(query,10));setMethodHits(searchBiologyAuthoring(query));
    try {
      const result = await invoke<KnowledgeHit[]>('search_knowledge', { query });
      setHits(result); setSearched(query.trim()); setMessage(`检索完成，找到 ${result.length} 个片段（最多显示 20 个）。`);
    } catch (error) { setMessage(knowledgeError(error)); }
    finally { setBusy(false); }
  }
  async function showProcessed(id:string,name:string){
    setBusy(true);try{const value=await invoke<ProcessedKnowledge|null>('read_processed_knowledge',{documentId:id});setProcessedView(value?{name,value}:null);setQuestionPage(0);setMessage(value?'已读取本机处理结果，没有读取源 PDF。':'这份资料尚未处理，可点击“处理已存文字”。');}catch(e){setMessage(knowledgeError(e));}finally{setBusy(false);}
  }
  async function processSaved(id:string){
    if(!library)return;setBusy(true);setMessage('正在使用已保存文字处理，不读取原 PDF…');
    try{const source=await invoke<KnowledgeDocument>('read_knowledge_document',{documentId:id});const doc=await processKnowledgeFile(source,importKind);
      const saved=await invoke<KnowledgeLibrary>('process_saved_knowledge',{expectedRevision:library.revision,documentId:id,processed:doc.processed});
      setLibrary(saved);setProcessedView({name:source.name,value:doc.processed!});setQuestionPage(0);setMessage('已更新处理结果和索引，后续直接复用。');
    }catch(e){setMessage(knowledgeError(e));}finally{setBusy(false);}
  }
  const emptyPages = candidate?.pages.filter(p => !p.text).map(p => p.number) ?? [];
  return <section className="card" id="knowledge-library" aria-label="本机知识库">
    <div className="card-heading"><h2>高中生物与 PDF 知识库</h2><span className="muted">{biologyLibrary.cards.length} 张内置卡 · {library?.documents.length ?? 0} 份本机文档</span></div>
    <p className="help">已内置用户资料整理的高中生物主题知识：五个教材模块和实验方法。生成时先按原题检索知识卡，再提炼适用知识；不必重复导入。原题负责定位考点，知识库提供标准命题。</p>
    <details><summary>内置知识范围与提炼方法</summary><p>{biologyLibrary.basis.scope}</p>
     <ul>{biologyLibrary.modules.map(module=><li key={module.id}>{module.volume}《{module.name}》：{biologyLibrary.cards.filter(c=>c.moduleId===module.id).length} 张卡</li>)}</ul>
     <ol>{biologyLibrary.method.map(step=><li key={step}>{step}</li>)}</ol>
     <p className="help">来源为用户提供的江苏2024、2025真题及教材目录。卡片是原创概括，不是教材原文；目录尚无具体依据的专题仍待补充。</p>
    </details>
    <details aria-label="生物出题方法库"><summary>基础填空与情景出题方法（{biologyAuthoring.principles.length} 条）</summary>
     <p className="help">参考对话“编写高中生物基础填空题”及本地命题研究笔记整理，已用于新任务的知识提炼、听写和补练生成。</p>
     <ol>{biologyAuthoring.principles.map(p=><li key={p.id}><b>{p.title}</b>：{p.method}</li>)}</ol>
     {biologyAuthoring.topicTemplates.map(t=><article key={t.id}><h3>{t.title}</h3><ol>{t.taskChain.map(s=><li key={s}>{s}</li>)}</ol><p>{t.textExample.stem}</p><p className="help">答案：{t.textExample.answer}；目标：{t.textExample.purpose}</p></article>)}
     <p className="help">{biologyAuthoring.scope}</p>
    </details>
    <p className="help">首次导入会保存文字、逐题结构、答案解析和考点索引；后续生成直接检索已存结果，不再读取原 PDF。旧资料也可从已存文字处理。扫描页暂无OCR，复杂版面和答案关联请预览核对。</p>
    <label>资料处理方式<select aria-label="知识库资料类型" value={importKind} disabled={locked} onChange={e=>setImportKind(e.target.value as ImportKind)}><option value="auto">自动识别</option><option value="question_bank">题库：逐题拆分</option><option value="reference">教材资料：文字索引</option></select></label>
    <div className="actions"><label className="file-input">导入 PDF<input aria-label="导入知识库 PDF" type="file" accept=".pdf,application/pdf" disabled={locked || !library} onChange={e => void prepare(e)}/></label><button className="secondary small" disabled={locked} onClick={() => void refresh()}>刷新知识库</button></div>
    <p className="help">单份不超过 40 MB、1000 页、10000 道题；库内最多 100 份、文字与缓存约 100 MB。考点是自动匹配标签，难度未测定；不把答案解析自动视为教材事实。导入处理在本机完成，不调用模型。</p>
    <div className="notice" aria-live="polite">{message}</div>
    {candidate && <div className="confirm-panel" role="region" aria-label="确认导入知识库">
      <b>{candidate.name}</b><p>共 {candidate.pages.length} 页，{emptyPages.length} 页无文字层。</p>
      {candidate.processed&&<><p>一次性处理：{candidate.processed.questions.length} 道题；有答案 {candidate.processed.questions.filter(q=>q.answer).length} 道，有解析 {candidate.processed.questions.filter(q=>q.explanation).length} 道。</p><p className="help">{candidate.processed.warnings.join('；')}</p><details><summary>题目处理预览（前20题）</summary>{candidate.processed.questions.slice(0,20).map(q=><article key={q.id}><b>原第{q.number}题 · 第{q.pageStart}—{q.pageEnd}页</b><pre>{q.stem}</pre>{q.options.map(o=><p key={o.label}>{o.label}. {o.text}</p>)}<p>答案：{q.answer||'未识别'}</p><p>解析：{q.explanation||'未识别'}</p><p>考点：{q.knowledgePoints.join('、')||'待补充'}；{q.warnings.join('；')}</p><p>设问标签：{q.taskPatterns.join('、')||'待补充'}</p><p>解析知识候选（未经核验）：{q.knowledgeNotes.join('；')||'暂无'}</p></article>)}</details></>}
      {emptyPages.length > 0 && <p className="notice error">以下页没有可提取文字，暂不参与检索：{emptyPages.join('、')}。若有页眉但正文为图片，也可能漏提，请对照原 PDF。</p>}
      <details open><summary>逐页文字预览</summary><div className="knowledge-preview">{candidate.pages.map(p => <details key={p.number} open={p.number === 1}><summary>第 {p.number} 页 · {p.text.length} 字符</summary><pre>{p.text || '无可提取文字'}</pre></details>)}</div></details>
      <div className="actions"><button disabled={busy} onClick={() => void commit()}>确认导入知识库</button><button className="secondary" disabled={busy} onClick={() => { setCandidate(null); setMessage('已取消导入，知识库保持原样。'); }}>取消导入</button></div>
    </div>}
    {library && library.documents.length > 0 && <ul className="knowledge-documents">{library.documents.map(doc => <li key={doc.id}>
      <div><b>{doc.name}</b><p className="help">{doc.pageCount} 页 · {doc.chunkCount} 个片段{doc.emptyPages.length > 0 ? ` · 无文字页：${doc.emptyPages.join('、')}` : ''}</p></div>
      <div><p className="help">{doc.processing?(doc.processing.kind==='reference'?'已建立资料索引，无需重新读取PDF':`已处理题库 · ${doc.processing.questionCount} 道题 · 答案 ${doc.processing.answerCount} · 解析 ${doc.processing.explanationCount}`):'旧资料：文字已保存，尚未逐题处理'}</p>
       {doc.processing&&<button className="secondary small" disabled={locked} onClick={()=>void showProcessed(doc.id,doc.name)}>查看处理结果</button>}
       <button className="secondary small" disabled={locked} onClick={()=>void processSaved(doc.id)}>{doc.processing?.version===KNOWLEDGE_PROCESSOR_VERSION?'重新处理已存文字':'处理已存文字'}</button></div>
      <button className="secondary small danger" disabled={locked} aria-label={`删除文档 ${doc.name}`} onClick={() => setDeleting(doc.id)}>删除</button>
    </li>)}</ul>}
    {processedView&&<div role="region" aria-label="已保存题库处理结果"><b>{processedView.name} · 已存结果</b><p>共 {processedView.value.questions.length} 道题，当前显示第 {questionPage+1} 批；{processedView.value.warnings.join('；')}</p>
     {processedView.value.questions.slice(questionPage*20,questionPage*20+20).map(q=><details key={q.id}><summary>原第{q.number}题 · 第{q.pageStart}—{q.pageEnd}页 · {q.knowledgePoints.join('、')||'考点待补充'}</summary><pre>{q.stem}</pre>{q.options.map(o=><p key={o.label}>{o.label}. {o.text}</p>)}<p>参考答案：{q.answer||'未识别'}</p><p>解析：{q.explanation||'未识别'}</p><p>设问标签：{q.taskPatterns.join('、')||'待补充'}</p><p>解析知识候选（未经核验）：{q.knowledgeNotes.join('；')||'暂无'}</p><p className="help">{q.warnings.join('；')}；难度尚未测定</p></details>)}
     <button className="secondary small" disabled={questionPage===0} onClick={()=>setQuestionPage(p=>p-1)}>上一批</button><button className="secondary small" disabled={(questionPage+1)*20>=processedView.value.questions.length} onClick={()=>setQuestionPage(p=>p+1)}>下一批</button><button className="secondary small" onClick={()=>setProcessedView(null)}>关闭结果</button></div>}
    {deleting && <div className="confirm-panel" role="region" aria-label="确认删除知识库文档"><b>删除 {library?.documents.find(d => d.id === deleting)?.name}？</b><p>删除本机提取文字与索引，原 PDF 保留。</p><div className="actions"><button disabled={busy} onClick={() => void remove()}>确认删除文档</button><button className="secondary" disabled={busy} onClick={() => setDeleting(null)}>取消删除</button></div></div>}
    <form onSubmit={e => void search(e)} className="knowledge-search"><label>检索关键词<input aria-label="知识库检索词" maxLength={100} value={query} disabled={locked} onChange={e => { setQuery(e.target.value); setHits(null);setBuiltInHits(null);setMethodHits(null); }}/></label><button disabled={locked || !query.trim()}>检索知识库</button></form>
    {methodHits!==null&&<div aria-label="生物出题方法检索结果"><p>出题方法：{methodHits.length} 条</p>{methodHits.map(p=><article className="knowledge-hit" key={p.id}><b>{p.title}</b><p>{p.method}</p></article>)}</div>}
    {builtInHits!==null&&<div aria-label="内置生物知识检索结果"><p>内置知识卡：{builtInHits.length} 条</p>{builtInHits.map(card=><article className="knowledge-hit" key={card.id}><b>{card.title}</b><pre>{formatBiologyCard(card)}</pre></article>)}</div>}
    {hits !== null && <div aria-label="知识库检索结果"><p>“{searched}” · {hits.length} 个片段</p>{hits.map(hit => <article className="knowledge-hit" key={`${hit.documentId}-${hit.page}-${hit.ordinal}`}><b>{hit.name} · 第 {hit.page} 页</b><pre>{hit.text}</pre></article>)}</div>}
  </section>;
}
