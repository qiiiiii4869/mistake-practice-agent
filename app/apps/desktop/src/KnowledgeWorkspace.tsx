import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { knowledgeError, type KnowledgeDocument, type KnowledgeLibrary, type KnowledgeHit } from '../../../packages/knowledge/src';
import {biologyLibrary,searchBiology,formatBiologyCard} from '../../../packages/knowledge/src/biology';

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
      const doc = await extractPdf(file, (page, total) => setMessage(`正在提取第 ${page} / ${total} 页…`));
      if (library.documents.some(d => d.id === doc.id)) throw new Error('knowledge_duplicate');
      setCandidate(doc); setMessage('提取完成，请预览文字并确认导入。');
    } catch (error) { setMessage(knowledgeError(error)); }
    finally { setBusy(false); }
  }
  async function commit() {
    if (!candidate || !library) return;
    setBusy(true);
    try {
      const saved = await invoke<KnowledgeLibrary>('import_knowledge', { expectedRevision: library.revision, document: candidate });
      setLibrary(saved); setCandidate(null); setHits(null); setMessage('已保存至本机知识库，可检索来源片段。');
    } catch (error) { setMessage(knowledgeError(error)); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!deleting || !library) return;
    setBusy(true);
    try {
      const saved = await invoke<KnowledgeLibrary>('remove_knowledge', { expectedRevision: library.revision, documentId: deleting });
      setLibrary(saved); setDeleting(null); setHits(null); setMessage('已从知识库删除文档文字及检索索引。原 PDF 与当前考试中已保存的引用片段保留。');
    } catch (error) { setMessage(knowledgeError(error)); }
    finally { setBusy(false); }
  }
  async function search(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setHits(null);setBuiltInHits(searchBiology(query,10));
    try {
      const result = await invoke<KnowledgeHit[]>('search_knowledge', { query });
      setHits(result); setSearched(query.trim()); setMessage(`检索完成，找到 ${result.length} 个片段（最多显示 20 个）。`);
    } catch (error) { setMessage(knowledgeError(error)); }
    finally { setBusy(false); }
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
    <p className="help">课本与试卷可重复使用，知识库独立于当前考试。清除考试不会删除知识库。仅保存提取文字和来源页码，原 PDF 留在原位置。扫描页识别待接入。</p>
    <div className="actions"><label className="file-input">导入 PDF<input aria-label="导入知识库 PDF" type="file" accept=".pdf,application/pdf" disabled={locked || !library} onChange={e => void prepare(e)}/></label><button className="secondary small" disabled={locked} onClick={() => void refresh()}>刷新知识库</button></div>
    <p className="help">单份不超过 40 MB、1000 页；库内最多 100 份、索引文字约 100 MB。复杂排版、公式和表格可能提取不完整，请先核对预览。</p>
    <div className="notice" aria-live="polite">{message}</div>
    {candidate && <div className="confirm-panel" role="region" aria-label="确认导入知识库">
      <b>{candidate.name}</b><p>共 {candidate.pages.length} 页，{emptyPages.length} 页无文字层。</p>
      {emptyPages.length > 0 && <p className="notice error">以下页没有可提取文字，暂不参与检索：{emptyPages.join('、')}。若有页眉但正文为图片，也可能漏提，请对照原 PDF。</p>}
      <details open><summary>逐页文字预览</summary><div className="knowledge-preview">{candidate.pages.map(p => <details key={p.number} open={p.number === 1}><summary>第 {p.number} 页 · {p.text.length} 字符</summary><pre>{p.text || '无可提取文字'}</pre></details>)}</div></details>
      <div className="actions"><button disabled={busy} onClick={() => void commit()}>确认导入知识库</button><button className="secondary" disabled={busy} onClick={() => { setCandidate(null); setMessage('已取消导入，知识库保持原样。'); }}>取消导入</button></div>
    </div>}
    {library && library.documents.length > 0 && <ul className="knowledge-documents">{library.documents.map(doc => <li key={doc.id}>
      <div><b>{doc.name}</b><p className="help">{doc.pageCount} 页 · {doc.chunkCount} 个片段{doc.emptyPages.length > 0 ? ` · 无文字页：${doc.emptyPages.join('、')}` : ''}</p></div>
      <button className="secondary small danger" disabled={locked} aria-label={`删除文档 ${doc.name}`} onClick={() => setDeleting(doc.id)}>删除</button>
    </li>)}</ul>}
    {deleting && <div className="confirm-panel" role="region" aria-label="确认删除知识库文档"><b>删除 {library?.documents.find(d => d.id === deleting)?.name}？</b><p>删除本机提取文字与索引，原 PDF 保留。</p><div className="actions"><button disabled={busy} onClick={() => void remove()}>确认删除文档</button><button className="secondary" disabled={busy} onClick={() => setDeleting(null)}>取消删除</button></div></div>}
    <form onSubmit={e => void search(e)} className="knowledge-search"><label>检索关键词<input aria-label="知识库检索词" maxLength={100} value={query} disabled={locked} onChange={e => { setQuery(e.target.value); setHits(null);setBuiltInHits(null); }}/></label><button disabled={locked || !query.trim()}>检索知识库</button></form>
    {builtInHits!==null&&<div aria-label="内置生物知识检索结果"><p>内置知识卡：{builtInHits.length} 条</p>{builtInHits.map(card=><article className="knowledge-hit" key={card.id}><b>{card.title}</b><pre>{formatBiologyCard(card)}</pre></article>)}</div>}
    {hits !== null && <div aria-label="知识库检索结果"><p>“{searched}” · {hits.length} 个片段</p>{hits.map(hit => <article className="knowledge-hit" key={`${hit.documentId}-${hit.page}-${hit.ordinal}`}><b>{hit.name} · 第 {hit.page} 页</b><pre>{hit.text}</pre></article>)}</div>}
  </section>;
}
