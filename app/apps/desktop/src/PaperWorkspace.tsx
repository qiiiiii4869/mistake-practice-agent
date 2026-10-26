import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Paper } from '../../../packages/core/src';
import { validatePaper, validateRecognition, applyRecognition, type Recognition } from '../../../packages/paper/src';
import { agentError } from '../../../packages/agent/src';

interface Props { paper?: Paper; numbers: string[]; locked: boolean; onBusy: (busy: boolean) => void; save: (paper: Paper) => Promise<void> }
export function PaperWorkspace({ paper, numbers, locked, onBusy, save }: Props) {
  const [draft, setDraft] = React.useState<Paper>(paper ?? { pages: [], questions: [] });
  const [number, setNumber] = React.useState(numbers[0] ?? '');
  const [message, setMessage] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [blank,setBlank]=React.useState(false);
  const [recognized,setRecognized]=React.useState<{pageId:string;result:Recognition}|null>(null);
  React.useEffect(() => { setDraft(paper ?? { pages: [], questions: [] }); setRecognized(null); }, [paper]);
  const q = draft.questions.find(q => q.number === number);
  const pageId = q?.pageId ?? draft.pages[0]?.id ?? '';
  const page = draft.pages.find(p => p.id === pageId);
  const disabled = locked || loading || recognized!==null;
  React.useEffect(()=>{setBlank(false);},[pageId]);
  async function recognize() {
    if(!blank||!paper?.pages.some(p=>p.id===pageId))return;
    setLoading(true);onBusy(true);setMessage('正在将本页空白试卷发送到 DeepSeek 识别，请等待…');
    try{
      const raw=await invoke('call_deepseek',{request:{stage:'recognize_paper',instruction:'',data:{pageId}}});
      const result=validateRecognition(raw,numbers);setRecognized({pageId,result});
      setMessage(result.questions.length?`识别出 ${result.questions.length} 道题，请预览后选择是否采用。`:'没有识别到可对应的题号，原草稿保持不变。');
    }catch(error){setMessage(error instanceof Error&&error.message==='invalid_paper_recognition'?'识别结果的题号或内容不完整，未采用。':agentError(error));}
    finally{setLoading(false);onBusy(false);}
  }
  function update(stem: string, selected: string, confirmed = false) {
    setDraft({ ...draft, questions: [...draft.questions.filter(q => q.number !== number), { number, stem, pageId: selected, confirmed }] });
  }
  async function importPages(event: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])]; event.target.value = '';
    if (!files.length) return;
    setLoading(true); onBusy(true); setMessage('正在检查照片…');
    try {
      if (files.length + draft.pages.length > 30 || files.some(f => !['image/jpeg', 'image/png', 'image/webp'].includes(f.type))
        || files.reduce((sum, f) => sum + f.size, 0) > 6 * 1024 * 1024) throw new Error();
      const pages = [];
      for (const file of files) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file);
        });
        const image = new Image(); image.src = data; await image.decode();
        pages.push({ id: crypto.randomUUID(), name: file.name, data });
      }
      setDraft(validatePaper({ ...draft, pages: [...draft.pages, ...pages] }, numbers));
      setMessage('照片已加入草稿。请关联题号、录入完整题干并保存。');
    } catch { setMessage('导入失败。请选择有效的 JPG、PNG 或 WebP；最多 30 页，所有照片编码后合计不超过 8 MB。可先压缩照片。原草稿保留。'); }
    finally { setLoading(false); onBusy(false); }
  }
  return <section className="card" id="paper-review" aria-label="试卷题干核对">
    <div className="card-heading"><h2>试卷与题号核对</h2><span className="muted">已核对 {draft.questions.filter(q => q.confirmed).length} / {numbers.length} 题</span></div>
    <p className="help">照片保存在本机当前考试。可手动录入，或保存照片后使用 DeepSeek 识别当前页。选择题请连同选项核对，共用材料请一并核对。</p>
    <label className="file-input">添加试卷照片<input aria-label="添加试卷照片" type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={disabled} onChange={e => void importPages(e)}/></label>
    <div className="fields">
      <label>成绩题号<select aria-label="成绩题号" value={number} disabled={disabled} onChange={e => setNumber(e.target.value)}>{numbers.map(n => <option key={n}>{n}</option>)}</select></label>
      <label>来源照片<select aria-label="来源照片" value={pageId} disabled={disabled || !draft.pages.length} onChange={e => update(q?.stem ?? '', e.target.value)}>{draft.pages.length ? draft.pages.map((p,i) => <option key={p.id} value={p.id}>第 {i+1} 页 · {p.name}</option>) : <option value="">请先添加照片</option>}</select></label>
    </div>
    {page && <a href={page.data} target="_blank" rel="noreferrer"><img className="paper-preview" src={page.data} alt={`试卷来源：${page.name}`}/></a>}
    <details><summary>DeepSeek 识别当前照片</summary>
      <p className="help">先在下方“出题与审核”的模型设置填写本机会话密钥。识别会上传当前已保存照片并消耗额度。程序无法在上传前检查图片中的姓名，请只使用空白试卷，先裁掉含姓名的区域；不要上传学生答题卡。</p>
      <label><input type="checkbox" aria-label="确认照片不含学生姓名" checked={blank} disabled={disabled} onChange={e=>setBlank(e.target.checked)}/> 当前照片为空白试卷，不含学生姓名</label>
      <div className="actions"><button className="secondary" disabled={disabled||!blank||!paper?.pages.some(p=>p.id===pageId)} onClick={()=>void recognize()}>识别当前已保存照片</button></div>
      {!paper?.pages.some(p=>p.id===pageId)&&<p className="help">请先点击“保存试卷与核对结果”保存照片。</p>}
    </details>
    {recognized&&<div className="confirm-panel" role="region" aria-label="照片识别结果预览">
      <b>识别结果尚未写入草稿</b><p>采用后会覆盖相同题号的原草稿，并取消这些题的核对状态；保存后才写入本机考试。</p>
      {recognized.result.warnings.map((w,i)=><p key={i} className="notice error">{w}</p>)}
      {recognized.result.questions.map(q=><details key={q.number} open><summary>第 {q.number} 题 · {q.confidence==='low'?'识别不确定，重点核对':'仍需教师核对'}</summary><pre className="recognition-text">{q.stem}</pre></details>)}
      <div className="actions"><button disabled={loading||!recognized.result.questions.length} onClick={()=>{setDraft(applyRecognition(draft,recognized.pageId,recognized.result,numbers));setRecognized(null);setMessage('已采用为未核对草稿。请逐题核对题干、选项及共用材料，再保存。');}}>采用识别草稿</button><button className="secondary" disabled={loading} onClick={()=>{setRecognized(null);setMessage('已放弃识别结果，原草稿保留。');}}>放弃识别结果</button></div>
    </div>}
    <label className="paper-stem">第 {number} 题题干<textarea aria-label="题干" rows={9} maxLength={20000} disabled={disabled || !page} value={q?.stem ?? ''} onChange={e => update(e.target.value, pageId)}/></label>
    <label><input aria-label="已核对题干" type="checkbox" checked={q?.confirmed ?? false} disabled={disabled || !page || !q?.stem.trim()} onChange={e => update(q?.stem ?? '', pageId, e.target.checked)}/> 已核对题号、题干与来源照片</label>
    <p className="help">修改题干或来源后需重新核对；保存试卷会清除本场旧出题与审核结果。未保存的草稿在退出程序后丢失；替换或清除当前考试会同时清除照片与题干。</p>
    <div className="actions"><button disabled={disabled} onClick={() => {
      try { const checked = validatePaper(draft, numbers); void save(checked); setMessage('已提交保存，请查看上方当前考试的保存结果。'); }
      catch { setMessage('题干或来源不完整，请检查后保存。'); }
    }}>保存试卷与核对结果</button><button className="secondary" disabled={disabled} onClick={() => { setDraft(paper ?? { pages: [], questions: [] }); setMessage('已恢复为上次保存的试卷。'); }}>撤销未保存修改</button></div>
    {message && <p role="status">{message}</p>}
  </section>;
}
