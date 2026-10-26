import { deepseekProvider, type DeepseekStatus } from '../../../packages/agent/src/deepseek';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { analyze, type Workspace } from '../../../packages/core/src';
import { runPipeline, assemble, agentError, editVariant, recheckVariant, type AgentBatch, type QuestionKind, type Exercise } from '../../../packages/agent/src';
import { demoProvider } from '../../../packages/agent/src/mock';
import type { KnowledgeHit } from '../../../packages/knowledge/src';

const labels: Record<QuestionKind,string> = {choice:'选择题',text:'纯文字题',diagram:'依赖图形',shared_material:'共用材料',listening:'听力',writing:'作文',practical:'实验操作'};
interface Props { workspace: Workspace; locked: boolean; onBusy: (busy: boolean) => void; save: (batch: AgentBatch) => Promise<boolean> }
export function AgentWorkspace({ workspace, locked, onBusy, save }: Props) {
  const [batch,setBatch]=React.useState<AgentBatch|null>(workspace.practice??null);
  const [keyword,setKeyword]=React.useState(workspace.practice?.annotations[0]?.annotation.keywords[0]??'');
  const [rules,setRules]=React.useState<Record<string,{kind:QuestionKind;group:string}>>({});
  const [mode,setMode]=React.useState<'mock'|'real'>(workspace.practice?.mode??'mock');
  const [key,setKey]=React.useState('');
  const [status,setStatus]=React.useState<DeepseekStatus|null>(null);
  const [configuring,setConfiguring]=React.useState(false);
  const [working,setWorking]=React.useState(false);
  const [message,setMessage]=React.useState('真实模型尚未接入。可用离线演示验证检索、出题、自检与审核。');
  const controller=React.useRef<AbortController|null>(null);
  React.useEffect(()=>{setBatch(workspace.practice??null);setRules({});setMessage(workspace.practice?(workspace.practice.mode==='mock'?'已恢复本场演示出题与审核，仍不可正式导出。':'已恢复本场 DeepSeek 出题与审核。密钥只在当前程序会话可用，重启需重填。'):'可配置 DeepSeek，或先运行离线演示。');},[workspace]);
  React.useEffect(()=>()=>controller.current?.abort(),[]);
  async function refreshStatus(){try{setStatus(await invoke<DeepseekStatus>('deepseek_status'));}catch{/* Older shells cannot enable real calls. */}}
  React.useEffect(()=>{void refreshStatus();},[]);
  function realProvider(){
    const base=deepseekProvider(request=>invoke('call_deepseek',{request}));
    return {...base,async call(request:Parameters<typeof base.call>[0]){
      const result=await base.call(request);
      const original=request.data.original as {number:string}|undefined;const rule=original?rules[original.number]:undefined;
      return request.stage==='annotate'&&rule&&result&&typeof result==='object'?{...result,kind:rule.kind,materialGroup:rule.kind==='shared_material'?rule.group:null}:result;
    }};
  }
  async function configure(clear=false){
    setConfiguring(true);
    try{await invoke('configure_deepseek',{key:clear?'':key});setKey('');await refreshStatus();setMode(clear?'mock':'real');setMessage(clear?'已清除本次会话密钥。':'已配置 DeepSeek V4.1 Flash，仅保留在本次程序会话中。');}
    catch(error){setMessage(agentError(error));}finally{setConfiguring(false);}
  }
  const analysis=React.useMemo(()=>analyze(workspace),[workspace]);
  const confirmed=workspace.paper?.questions.filter(q=>q.confirmed) ?? [];
  const preview=React.useMemo(()=>batch ? assemble(workspace,batch,true) : [],[workspace,batch]);
  const disabled=locked||working||configuring;
  async function run() {
    if (mode==='mock'&&!keyword.trim()) return;
    if(mode==='real'&&(!status?.configured||status.quotaExhausted)){setMessage(agentError(status?.quotaExhausted?'model_quota_exhausted':'model_key_required'));return;}
    setWorking(true);onBusy(true);controller.current=new AbortController();
    try {
      const next=await runPipeline({workspace,provider:mode==='real'?realProvider():demoProvider(keyword.trim(),rules),
        retrieve:query=>invoke<KnowledgeHit[]>('search_knowledge',{query}),progress:setMessage,signal:controller.current.signal});
      setBatch(next);setMessage(`${next.mode==='mock'?'演示完成':'生成完成'}：${next.variants.length} 道题，${next.skipped.length} 组跳过。请逐题查看并审核。`);
    } catch(error){setMessage(agentError(error));}
    finally{setWorking(false);onBusy(false);controller.current=null;void refreshStatus();}
  }
  function review(id:string,status:'approved'|'rejected'|'pending') {
    if(batch)setBatch({...batch,variants:batch.variants.map(v=>v.id===id?{...v,review:status}:v)});
  }
  function edit(id:string,patch:Partial<Pick<Exercise,'stem'|'options'|'answer'|'explanation'>>) {
    if(batch)setBatch({...batch,variants:batch.variants.map(v=>v.id===id?editVariant(v,patch):v)});
  }
  async function recheck(id:string) {
    const variant=batch?.variants.find(v=>v.id===id);if(!variant||!batch)return;
    setWorking(true);onBusy(true);setMessage('正在对修改后的题目重新独立自检…');
    try{
      const checked=await recheckVariant(workspace,batch.mode==='real'?realProvider():demoProvider(keyword.trim(),rules),variant);
      setBatch({...batch,calls:{...batch.calls,solve:batch.calls.solve+1},variants:batch.variants.map(v=>v.id===id?checked:v)});
      setMessage(checked.passed?'重新比对通过，仍需教师重新采用。':'重新自检不一致，已禁止采用该题。');
    }catch(error){setMessage(agentError(error));}
    finally{setWorking(false);onBusy(false);void refreshStatus();}
  }
  return <section className="card" aria-label="出题流程演示">
    <div className="card-heading"><h2>Agent 出题与审核</h2><span className="badge">{mode==='real'?'DeepSeek V4.1 Flash':'离线演示'}</span></div>
    <details><summary>DeepSeek 模型设置</summary><p className="help">官方接口 · deepseek-flash（V4.1 Flash）。密钥只保存在当前程序内存，重启需重新填写，不写入考试、日志或仓库。</p>
      <label>DeepSeek API Key<input aria-label="DeepSeek API Key" type="password" autoComplete="off" value={key} disabled={disabled} onChange={e=>setKey(e.target.value)}/></label>
      <div className="actions"><button className="secondary small" disabled={disabled||!key.trim()} onClick={()=>void configure()}>启用 DeepSeek</button><button className="secondary small" disabled={disabled||!status?.configured} onClick={()=>void configure(true)}>清除会话密钥</button></div>
      <p className="help">本次会话已记录 {status?.usage.totalTokens??0} token；余额/额度耗尽立即停止，不自动重试或切换服务。停止生成后，当前已发出的请求可能仍需结束。</p>
    </details>
    <label>运行模式<select aria-label="出题运行模式" value={mode} disabled={disabled} onChange={e=>setMode(e.target.value as 'mock'|'real')}><option value="mock">离线演示</option><option value="real" disabled={!status?.configured||status?.quotaExhausted}>DeepSeek V4.1 Flash</option></select></label>
    <div className="notice error">{mode==='real'?'使用真实 DeepSeek API，将按所选题目调用并消耗额度；学生姓名在请求前拦截。生成结果仍需教师审核。':'当前使用固定假接口，不调用付费模型。演示题和答案仅用于验证流程，不能作为正式补练导出。'}点击下方保存可在本机恢复本场结果；未保存修改退出后丢失。</div>
    <p className="help">先核对试卷题干并导入知识库。演示将以你填写的知识点检索本机资料；按薄弱题生成，每题数量沿用本场设置。改动当前考试、已保存题干或设置会重置结果。</p>
    {mode==='mock'&&<label className="agent-keyword">演示知识点与检索词<input aria-label="演示知识点与检索词" maxLength={100} disabled={disabled} value={keyword} onChange={e=>setKeyword(e.target.value)}/></label>}
    {confirmed.length>0 && <details><summary>题型规则（已核对 {confirmed.length} 题）</summary><div className="table-scroll"><table><thead><tr><th>题号</th><th>题型</th><th>共用材料组</th></tr></thead><tbody>{confirmed.map(q=><tr key={q.number}><td>{q.number}</td><td><select aria-label={`第 ${q.number} 题题型`} disabled={disabled} value={rules[q.number]?.kind??'text'} onChange={e=>setRules({...rules,[q.number]:{kind:e.target.value as QuestionKind,group:rules[q.number]?.group??''}})}>{Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></td><td><input aria-label={`第 ${q.number} 题材料组`} maxLength={100} disabled={disabled||rules[q.number]?.kind!=='shared_material'} value={rules[q.number]?.group??''} onChange={e=>setRules({...rules,[q.number]:{kind:'shared_material',group:e.target.value}})}/></td></tr>)}</tbody></table></div><p className="help">同一阅读材料的小题使用相同组名，题干中需包含完整共用材料。图形题仅尝试纯文字变式；听力、作文、实验操作不自动出题。</p></details>}
    <div className="actions"><button disabled={disabled||(mode==='mock'&&!keyword.trim())||!confirmed.length||(mode==='real'&&(!status?.configured||status.quotaExhausted))} onClick={()=>void run()}>{mode==='real'?'使用 DeepSeek 生成补练':'运行离线出题演示'}</button>{working&&<button className="secondary" onClick={()=>controller.current?.abort()}>停止生成</button>}</div>
    <p className="notice" aria-live="polite" data-testid="agent-message">{message}</p>
    {batch&&<>
      <p className="help">{batch.mode==='mock'?'假接口':'DeepSeek'}调用：标注 {batch.calls.annotate} 次 · 出题 {batch.calls.generate} 次 · 独立解题 {batch.calls.solve} 次。姓名只在下方本机组卷预览中显示。</p>
      {batch.skipped.length>0&&<ul>{batch.skipped.map((s,i)=><li key={i}>第 {s.numbers.join('、')} 题：{s.reason}</li>)}</ul>}
      {batch.variants.map(v=><article className={`agent-variant ${v.passed?'':'flagged'}`} key={v.id} aria-label={`审核 ${v.id}`}>
        <div className="card-heading"><b>原第 {v.sourceNumbers.join('、')} 题 · {v.id}</b><span className="badge">{v.passed?(batch.mode==='mock'?'演示比对通过':'独立自检通过'):'自检不一致，禁止采用'}</span></div>
        <p className="agent-question">{v.stem}</p>{v.options.length>0&&<ul>{v.options.map((o,i)=><li key={i}>{o}</li>)}</ul>}
        <details><summary>答案、解析、自检与来源</summary><p>答案：{v.answer}</p><p>解析：{v.explanation}</p><p>独立解题：{v.check.answer}；{v.check.explanation}</p><p>尝试次数：{v.attempts}。知识点：{v.knowledgePoints.join('、')}</p><ul>{v.sourceIndexes.map(index=><li key={index}>{v.evidence[index].name} · 第 {v.evidence[index].page} 页<pre>{v.evidence[index].text}</pre></li>)}</ul></details>
        <details><summary>{batch.mode==='mock'?'修改演示题（修改后需重新自检与审核）':'修改题目（修改后需重新自检与审核）'}</summary>
          <label>题干<textarea aria-label={`修改题干 ${v.id}`} rows={4} maxLength={20000} disabled={disabled} value={v.stem} onChange={e=>edit(v.id,{stem:e.target.value})}/></label>
          {v.options.map((option,i)=><label key={i}>选项 {i+1}<input aria-label={`修改选项 ${v.id}-${i+1}`} maxLength={3000} disabled={disabled} value={option} onChange={e=>edit(v.id,{options:v.options.map((o,j)=>j===i?e.target.value:o)})}/></label>)}
          <label>答案<textarea aria-label={`修改答案 ${v.id}`} rows={2} maxLength={10000} disabled={disabled} value={v.answer} onChange={e=>edit(v.id,{answer:e.target.value})}/></label>
          <label>解析<textarea aria-label={`修改解析 ${v.id}`} rows={3} maxLength={20000} disabled={disabled} value={v.explanation} onChange={e=>edit(v.id,{explanation:e.target.value})}/></label>
          <div className="actions"><button className="secondary small" disabled={disabled} onClick={()=>void recheck(v.id)}>重新自检 {v.id}</button><button className="secondary small danger" disabled={disabled} onClick={()=>setBatch({...batch,variants:batch.variants.filter(item=>item.id!==v.id)})}>删除此题 {v.id}</button></div>
        </details>
        <label>教师审核<select aria-label={`教师审核 ${v.id}`} value={v.review} disabled={disabled} onChange={e=>review(v.id,e.target.value as 'approved'|'rejected'|'pending')}><option value="pending">待审核</option><option value="approved" disabled={!v.passed}>{batch.mode==='mock'?'采用（仅演示）':'采用'}</option><option value="rejected">不采用</option></select></label>
      </article>)}
      <details><summary>{batch.mode==='mock'?'本机组卷预览（演示，不可导出）':'本机组卷预览'}</summary><p className="help">只使用教师采用且比对通过的题；同一知识点不重复，遵守每人上限。未覆盖的失分题单独列出。</p><div className="table-scroll"><table><thead><tr><th>学生</th><th>{batch.mode==='mock'?'演示题数':'补练题数'}</th><th>未覆盖题号</th></tr></thead><tbody>{preview.map((s,i)=><tr key={s.id}><td>{s.name||`学生 ${i+1}`}</td><td>{s.availability==='scored'?s.variants.length:'没扫/无原卷，不判对错'}</td><td>{s.uncoveredNumbers.join('、')||'—'}</td></tr>)}</tbody></table></div></details>
      <div className="actions"><button disabled={disabled} onClick={async()=>{
        const saved=await save(batch);if(!saved)setMessage('本次未能保存，请查看上方提示。当前未保存草稿仍保留。');
      }}>保存本场出题与审核</button></div>
      <p className="help">本场纳入分析 {analysis.audit.exportedCount} 人；真实接口尚待密钥实测；正式 PDF 下载未接入。</p>
    </>}
  </section>;
}
