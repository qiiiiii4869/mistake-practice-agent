import { renderPaperFiles } from './renderPaperFiles';
import { practiceKey } from '../../../packages/agent/src/storage';
import { preparePaper } from '../../../packages/agent/src/preparePaper';
import { deepseekProvider, type DeepseekStatus } from '../../../packages/agent/src/deepseek';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { analyze, type Workspace, type Paper } from '../../../packages/core/src';
import { runPipeline, assemble, agentError, editVariant, recheckVariant, regenerateVariant, type AgentBatch, type QuestionKind, type Exercise } from '../../../packages/agent/src';
import { demoProvider } from '../../../packages/agent/src/mock';
import type { KnowledgeHit, KnowledgeLibrary } from '../../../packages/knowledge/src';
import { useAccount, accountError } from './AccountGate';

const labels: Record<QuestionKind,string> = {choice:'选择题',text:'纯文字题',diagram:'依赖图形',shared_material:'共用材料',listening:'听力',writing:'作文',practical:'实验操作'};
interface Props { workspace: Workspace; revision:number; locked: boolean; onBusy: (busy: boolean) => void; prepare: (paper: Paper, expectedRevision:number) => Promise<{workspace:Workspace;revision:number}>; save: (batch: AgentBatch) => Promise<boolean> }
export function AgentWorkspace({ workspace, revision, locked, onBusy, prepare, save }: Props) {
  const account=useAccount();
  const [pendingGeneration,setPendingGeneration]=React.useState<{jobId:string;batch:AgentBatch|null}|null>(null);
  const requestKey=React.useRef<string|null>(null);
  const [batch,setBatch]=React.useState<AgentBatch|null>(workspace.practice??null);
  const [keyword,setKeyword]=React.useState(workspace.practice?.annotations[0]?.annotation.keywords[0]??'');
  const [rules,setRules]=React.useState<Record<string,{kind:QuestionKind;group:string}>>({});
  const [mode,setMode]=React.useState<'mock'|'real'>(workspace.practice?.mode??'mock');
  const [blank,setBlank]=React.useState(false);
  const [key,setKey]=React.useState('');
  const [status,setStatus]=React.useState<DeepseekStatus|null>(null);
  const [configuring,setConfiguring]=React.useState(false);
  const [checking,setChecking]=React.useState(false);
  const [knowledgeCheck,setKnowledgeCheck]=React.useState<{documents:number;chunks:number}|null>(null);
  const [readinessMessage,setReadinessMessage]=React.useState('检查只读取当前账号的本机资料，不调用模型、不预占或扣次数。');
  const [working,setWorking]=React.useState(false);
  const [layout,setLayout]=React.useState<'class'|'individual'>('class');
  const [includeAnswers,setIncludeAnswers]=React.useState(true);
  const [exportFolder,setExportFolder]=React.useState('');
  const [message,setMessage]=React.useState('真实模型尚未接入。可用离线演示验证检索、出题、自检与审核。');
  const controller=React.useRef<AbortController|null>(null);
  const ownPaperUpdate=React.useRef<string|null>(null);
  React.useEffect(()=>{if(ownPaperUpdate.current===JSON.stringify(workspace.paper)){ownPaperUpdate.current=null;return;}if(controller.current)return;setBlank(false);setBatch(workspace.practice??null);setRules({});setMessage(workspace.practice?(workspace.practice.mode==='mock'?'已恢复本场演示出题与审核，仍不可正式导出。':'已恢复本场 DeepSeek 出题与审核。密钥只在当前程序会话可用，重启需重填。'):'可配置 DeepSeek，或先运行离线演示。');},[workspace]);
  React.useEffect(()=>()=>controller.current?.abort(),[]);
  async function refreshStatus(){try{setStatus(await invoke<DeepseekStatus>('deepseek_status'));}catch{/* Older shells cannot enable real calls. */}}
  React.useEffect(()=>{void refreshStatus();},[]);
  React.useEffect(()=>{void invoke<{jobId:string;batch:AgentBatch|null}|null>('account_pending_generation').then(setPendingGeneration).catch(()=>{});},[]);
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
  const preview=React.useMemo(()=>batch && batch.inputKey===practiceKey(workspace) ? assemble(workspace,batch,true) : [],[workspace,batch]);
  const disabled=locked||working||configuring||checking;
  async function checkReadiness(){
    const library=await invoke<KnowledgeLibrary>('list_knowledge');
    const chunks=library.documents.reduce((sum,d)=>sum+d.chunkCount,0);
    setKnowledgeCheck({documents:library.documents.length,chunks});
    if(chunks<1)throw new Error('knowledge_required');
    if(!workspace.paper?.pages.length&&!confirmed.length)throw new Error('paper_required');
    if(!analysis.questions.some(q=>q.weakStudents>0))throw new Error('no_weak_questions');
    const current=await invoke<DeepseekStatus>('deepseek_status');setStatus(current);
    if(!current.configured||current.quotaExhausted)throw new Error(current.quotaExhausted?'model_quota_exhausted':'model_key_required');
    setReadinessMessage('本机资料检查通过；点击“生成结果”才会预占次数并调用模型。题号对应及识别质量仍需实际核对。');
  }
  async function inspectReadiness(){
    setChecking(true);
    try{await checkReadiness();}catch(error){setReadinessMessage(agentError(error));}
    finally{setChecking(false);}
  }
  async function run() {
    if (mode==='mock'&&!keyword.trim()) return;
    if(mode==='real'&&(!status?.configured||status.quotaExhausted)){setMessage(agentError(status?.quotaExhausted?'model_quota_exhausted':'model_key_required'));return;}
    setWorking(true);onBusy(true);controller.current=new AbortController();
    let jobId:string|null=null;let generated:AgentBatch|null=null;
    try {
      if(mode==='real'){
        setMessage('正在检查本机知识库、试卷和模型配置，尚未预占次数…');
        await checkReadiness();
        requestKey.current??=crypto.randomUUID();
        const job=await invoke<{jobId:string}>('account_generation_begin',{requestKey:requestKey.current});jobId=job.jobId;
      }
      let input=workspace;let inputRevision=revision;
      if(mode==='real'&&workspace.paper?.pages.length){
        if(!blank)throw new Error('paper_blank_required');
        const rendered=await renderPaperFiles(input.paper!,analysis.audit.questionNumbers,setMessage,controller.current.signal);
        if(JSON.stringify(rendered)!==JSON.stringify(input.paper)){
          setBatch(null);ownPaperUpdate.current=JSON.stringify(rendered);const saved=await prepare(rendered,inputRevision);input=saved.workspace;inputRevision=saved.revision;
        }
        const paper=await preparePaper(input,pageId=>invoke('call_deepseek',{request:{stage:'recognize_paper',instruction:'',data:{pageId}}}),setMessage,controller.current.signal);
        if(JSON.stringify(paper)!==JSON.stringify(input.paper)){
          setBatch(null);
          try{ownPaperUpdate.current=JSON.stringify(paper);const saved=await prepare(paper,inputRevision);input=saved.workspace;inputRevision=saved.revision;}
          catch{ownPaperUpdate.current=null;if(input===workspace)setBatch(batch);throw new Error('paper_save_failed');}
        }
      }
      const next=await runPipeline({workspace:input,provider:mode==='real'?realProvider():demoProvider(keyword.trim(),rules),
        retrieve:query=>invoke<KnowledgeHit[]>('search_knowledge',{query}),progress:setMessage,signal:controller.current.signal});
      if(jobId){
        if(!next.variants.some(v=>v.passed)){
          await invoke('account_generation_finish',{jobId,batch:null});requestKey.current=null;jobId=null;
          setBatch(next);setMessage('没有生成自检通过的补练题，本次不扣次数。请核对题干、知识库和自检提示。');return;
        }
        generated=next;setPendingGeneration({jobId,batch:next});
        await invoke('account_generation_finish',{jobId,batch:next});
        requestKey.current=null;
        setBatch(next);
        const saved=await save(next);
        if(saved)setPendingGeneration(null);
        setMessage(saved?`生成完成：${next.variants.length} 道题，已扣 1 次并保存，剩余次数请见顶部。请逐题审核。`:'已确认本次使用次数，结果暂存在本机恢复文件中，请重试保存。');
        return;
      }
      setBatch(next);setMessage(`${next.mode==='mock'?'演示完成':'生成完成'}：${next.variants.length} 道题，${next.skipped.length} 组跳过。请逐题查看并审核。`);
    } catch(error){
      if(jobId&&!generated){try{await invoke('account_generation_finish',{jobId,batch:null});requestKey.current=null;}catch{setPendingGeneration({jobId,batch:null});}}
      const code=error instanceof Error?error.message:String(error);
      setMessage(generated?'补练结果已暂存，但次数确认或保存尚未完成。请点击“恢复并确认结果”；同一批不会重复扣次。':/^(account_|session_|credits_|generation_)/.test(code)?accountError(error):agentError(error));
    }
    finally{setWorking(false);onBusy(false);controller.current=null;void refreshStatus();void account.refresh();}
  }
  async function recoverGeneration(){
    if(!pendingGeneration)return;setWorking(true);onBusy(true);
    try{
      await invoke('account_generation_finish',{jobId:pendingGeneration.jobId,batch:pendingGeneration.batch});
      if(pendingGeneration.batch){setBatch(pendingGeneration.batch);if(!await save(pendingGeneration.batch))throw new Error('storage_failed');}
      setPendingGeneration(null);requestKey.current=null;setMessage(pendingGeneration.batch?'已恢复并保存这批结果，同一批只扣 1 次。':'已释放上次未完成任务的次数，可重新生成。');
    }catch(error){setMessage(String(error)==='invalid_practice'?'当前考试或题干已变化，无法把旧结果放入本场；恢复文件保留，请联系管理员。':accountError(error));}
    finally{setWorking(false);onBusy(false);void account.refresh();}
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
  async function regenerate(id:string){
    if(!batch)return;setWorking(true);onBusy(true);setMessage('正在为这道题重新生成并独立自检…');
    try{const next=await regenerateVariant(workspace,batch,id,batch.mode==='real'?realProvider():demoProvider(keyword.trim(),rules),query=>invoke<KnowledgeHit[]>('search_knowledge',{query}));setBatch(next);setMessage('已替换为新题，需重新审核采用并保存。');}
    catch(error){setMessage(agentError(error));}finally{setWorking(false);onBusy(false);void refreshStatus();}
  }
  const saved=!!batch&&!!workspace.practice&&JSON.stringify(batch)===JSON.stringify(workspace.practice);
  const exportReady=!!batch&&batch.mode==='real'&&saved&&!batch.variants.some(v=>v.review==='pending')&&batch.variants.some(v=>v.review==='approved'&&v.passed);
  async function exportPdf(){
    if(!exportReady)return;setWorking(true);onBusy(true);setMessage('请选择保存位置，随后在本机编译 PDF，不调用模型。');
    try{
      const result=await invoke<{folder:string;fileCount:number;complete:boolean}|null>('export_practice_pdf',{expectedRevision:revision,layout,includeAnswers});
      if(!result)setMessage('已取消导出，考试和审核结果保留。');
      else{setExportFolder(result.folder);setMessage(result.complete?`已导出 ${result.fileCount} 份 PDF。`:`只成功保存 ${result.fileCount} 份，请检查文件夹和磁盘空间。`);}
    }catch(error){
      const code=error instanceof Error?error.message:String(error);
      const messages:Record<string,string>={pdf_compiler_missing:'程序缺少 PDF 组件，请使用完整安装包或重新准备构建资源。',pdf_unsupported_formula:'题目中存在尚未支持的公式，请修改后重新自检、审核和保存。',pdf_compile_failed:'PDF 编译未完成，请核对公式与题干；没有发布本次文件。',pdf_write_failed:'无法写入所选文件夹，请检查权限和磁盘空间。',pdf_export_timeout:'PDF 生成超时，请减少一次导出的题量。',pdf_unreviewed:'仍有待审核题目，请先审核并保存。',pdf_export_too_large:'本次导出内容过多，请减少题量。',storage_conflict:'本机考试已经变化，请重新打开并核对当前考试。'};
      setMessage(messages[code]??'PDF 导出未完成，请核对本场保存与审核状态。');
    }finally{setWorking(false);onBusy(false);}
  }
  return <section className="card" id="agent-review" aria-label="出题流程演示">
    <div className="card-heading"><h2>Agent 出题与审核</h2><span className="badge">{mode==='real'?'DeepSeek V4.1 Flash':'离线演示'}</span></div>
    <p className="help">账号剩余 {account.user.credits} 次，可用 {account.user.available} 次。真实生成一批自检通过的补练扣 1 次，失败、离线演示、审核和下载已有结果不扣次。</p>
    {pendingGeneration&&<div className="generation-pending"><p>{pendingGeneration.batch?'本机有一批尚未完成确认或保存的生成结果。恢复时会核对服务器记录，同一批不会重复扣次。':'上次生成未完成，可以释放预占次数后重新开始。'}</p><button className="secondary small" disabled={disabled} onClick={()=>void recoverGeneration()}>{pendingGeneration.batch?'恢复并确认结果':'释放未完成任务'}</button></div>}
    <details><summary>DeepSeek 模型设置</summary><p className="help">官方接口 · deepseek-flash（V4.1 Flash）。密钥只保存在当前程序内存，重启需重新填写，不写入考试、日志或仓库。</p>
      <label>DeepSeek API Key<input aria-label="DeepSeek API Key" type="password" autoComplete="off" value={key} disabled={disabled} onChange={e=>setKey(e.target.value)}/></label>
      <div className="actions"><button className="secondary small" disabled={disabled||!key.trim()} onClick={()=>void configure()}>启用 DeepSeek</button><button className="secondary small" disabled={disabled||!status?.configured} onClick={()=>void configure(true)}>清除会话密钥</button></div>
      <p className="help">本次会话已记录 {status?.usage.totalTokens??0} token；余额/额度耗尽立即停止，不自动重试或切换服务。停止生成后，当前已发出的请求可能仍需结束。</p>
    </details>
    <label>运行模式<select aria-label="出题运行模式" value={mode} disabled={disabled} onChange={e=>setMode(e.target.value as 'mock'|'real')}><option value="mock">离线演示</option><option value="real" disabled={!status?.configured||status?.quotaExhausted}>DeepSeek V4.1 Flash</option></select></label>
    <div className="notice error">{mode==='real'?'使用真实 DeepSeek API，将按所选题目调用并消耗额度；学生姓名在请求前拦截。生成结果仍需教师审核。':'当前使用固定假接口，不调用付费模型。演示题和答案仅用于验证流程，不能作为正式补练导出。'}点击下方保存可在本机恢复本场结果；未保存修改退出后丢失。</div>
    <p className="help">上传空白卷并准备知识库后点击“生成结果”。Agent 将依次读取卷面、核对题号与完整内容、分析知识点、检索知识库、生成补练并独立自检。识别不清或核对不一致会停止提示，不编造题干。离线演示仍使用手动核对题干。</p>
    {mode==='mock'&&<label className="agent-keyword">演示知识点与检索词<input aria-label="演示知识点与检索词" maxLength={100} disabled={disabled} value={keyword} onChange={e=>setKeyword(e.target.value)}/></label>}
    {confirmed.length>0 && <details><summary>题型规则（已核对 {confirmed.length} 题）</summary><div className="table-scroll"><table><thead><tr><th>题号</th><th>题型</th><th>共用材料组</th></tr></thead><tbody>{confirmed.map(q=><tr key={q.number}><td>{q.number}</td><td><select aria-label={`第 ${q.number} 题题型`} disabled={disabled} value={rules[q.number]?.kind??'text'} onChange={e=>setRules({...rules,[q.number]:{kind:e.target.value as QuestionKind,group:rules[q.number]?.group??''}})}>{Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></td><td><input aria-label={`第 ${q.number} 题材料组`} maxLength={100} disabled={disabled||rules[q.number]?.kind!=='shared_material'} value={rules[q.number]?.group??''} onChange={e=>setRules({...rules,[q.number]:{kind:'shared_material',group:e.target.value}})}/></td></tr>)}</tbody></table></div><p className="help">同一阅读材料的小题使用相同组名，题干中需包含完整共用材料。图形题仅尝试纯文字变式；听力、作文、实验操作不自动出题。</p></details>}
    {mode==='real'&&!!workspace.paper?.pages.length&&<label><input type="checkbox" aria-label="确认空白卷不含学生姓名" checked={blank} disabled={disabled} onChange={e=>setBlank(e.target.checked)}/> 已上传空白试卷，不含学生姓名；点击生成后才发送给模型读取和核对</label>}
    {mode==='real'&&<div className="notice" aria-label="生成准备检查">
      <b>生成前准备</b><ul>
        <li>当前账号：{account.user.username}；本场 {analysis.audit.exportedCount} 人有逐题得分。</li>
        <li>空白卷：{workspace.paper?.pages.length??0} 个文件或页面；已核对题干 {confirmed.length} 道。</li>
        <li>知识库：{knowledgeCheck?`${knowledgeCheck.documents} 份文档、${knowledgeCheck.chunks} 个可检索片段（上次检查）`:'尚未检查'}。 <a href="#knowledge-library">前往知识库</a></li>
        <li>模型密钥：{status?.configured?'本次会话已配置':'尚未配置'}；可用生成次数：{account.user.available}。</li>
      </ul><button className="secondary small" disabled={disabled} onClick={()=>void inspectReadiness()}>检查生成准备</button>
      <p role="status">{readinessMessage}</p>
    </div>}
    <div className="actions"><button disabled={disabled||(mode==='mock'&&(!keyword.trim()||!confirmed.length))||(mode==='real'&&(!!pendingGeneration||account.user.available<1||!status?.configured||status.quotaExhausted||(!workspace.paper?.pages.length&&!confirmed.length)||(!!workspace.paper?.pages.length&&!blank)))} onClick={()=>void run()}>{mode==='real'?'生成结果':'运行离线出题演示'}</button>{working&&controller.current&&<button className="secondary" onClick={()=>controller.current?.abort()}>停止生成</button>}</div>
    <p className="notice" aria-live="polite" data-testid="agent-message">{message}</p>
    {batch&&<>
      <details><summary>知识点分析</summary><ul>{batch.annotations.map(item=><li key={item.number}>第 {item.number} 题：{item.annotation.knowledgePoints.join('、')}；检索词：{item.annotation.keywords.join('、')}</li>)}</ul></details>
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
          <div className="actions"><button className="secondary small" disabled={disabled} onClick={()=>void recheck(v.id)}>重新自检 {v.id}</button><button className="secondary small" disabled={disabled} onClick={()=>void regenerate(v.id)}>重新生成 {v.id}</button><button className="secondary small danger" disabled={disabled} onClick={()=>setBatch({...batch,variants:batch.variants.filter(item=>item.id!==v.id)})}>删除此题 {v.id}</button></div>
        </details>
        <label>教师审核<select aria-label={`教师审核 ${v.id}`} value={v.review} disabled={disabled} onChange={e=>review(v.id,e.target.value as 'approved'|'rejected'|'pending')}><option value="pending">待审核</option><option value="approved" disabled={!v.passed}>{batch.mode==='mock'?'采用（仅演示）':'采用'}</option><option value="rejected">不采用</option></select></label>
      </article>)}
      <details><summary>{batch.mode==='mock'?'本机组卷预览（演示，不可导出）':'本机组卷预览'}</summary><p className="help">只使用教师采用且比对通过的题；同一知识点不重复，遵守每人上限。未覆盖的失分题单独列出。</p><div className="table-scroll"><table><thead><tr><th>学生</th><th>{batch.mode==='mock'?'演示题数':'补练题数'}</th><th>未覆盖题号</th></tr></thead><tbody>{preview.map((s,i)=><tr key={s.id}><td>{s.name||`学生 ${i+1}`}</td><td>{s.availability==='scored'?s.variants.length:'没扫/无原卷，不判对错'}</td><td>{s.uncoveredNumbers.join('、')||'—'}</td></tr>)}</tbody></table></div></details>
      <div className="actions"><button disabled={disabled} onClick={async()=>{
        const saved=await save(batch);if(!saved)setMessage('本次未能保存，请查看上方提示。当前未保存草稿仍保留。');
      }}>保存本场出题与审核</button></div>
      <div aria-label="PDF 导出"><h3>导出补练 PDF</h3><div className="fields"><label>文件组织<select aria-label="PDF 文件组织" value={layout} disabled={disabled} onChange={e=>setLayout(e.target.value as 'class'|'individual')}><option value="class">全班合订</option><option value="individual">每人一份</option></select></label></div>
        <label><input type="checkbox" aria-label="PDF 包含答案解析" checked={includeAnswers} disabled={disabled} onChange={e=>setIncludeAnswers(e.target.checked)}/> 附答案解析（另起一页）</label>
        <p className="help">先逐题审核，再保存本场结果。仅真实模型批次可导出，演示题不能导出。程序会在你选择的位置新建“错题补练”文件夹，不覆盖已有文件。</p>
        <button disabled={disabled||!exportReady} onClick={()=>void exportPdf()}>导出 PDF</button>{!saved&&<p className="help">当前修改尚未保存。</p>}{exportFolder&&<p className="saved">保存位置：{exportFolder}</p>}
      </div>
      <p className="help">本场纳入分析 {analysis.audit.exportedCount} 人；真实模型质量仍须教师验收。</p>
    </>}
  </section>;
}
