import React from 'react';
import type { Paper } from '../../../packages/core/src';
import { validatePaper } from '../../../packages/paper/src';

interface Props { paper?: Paper; numbers: string[]; locked: boolean; onBusy: (busy: boolean) => void; save: (paper: Paper) => Promise<boolean> }
export function PaperWorkspace({ paper, numbers, locked, onBusy, save }: Props) {
  const [draft, setDraft] = React.useState<Paper>(paper ?? { pages: [], questions: [] });
  const [number, setNumber] = React.useState(numbers[0] ?? '');
  const [message, setMessage] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  React.useEffect(() => { setDraft(paper ?? { pages: [], questions: [] }); }, [paper]);
  const q = draft.questions.find(q => q.number === number);
  const pageId = q?.pageId ?? draft.pages[0]?.id ?? '';
  const page = draft.pages.find(p => p.id === pageId);
  const disabled = locked || loading;
  function update(stem: string, selected: string, confirmed = false) {
    setDraft({ ...draft, questions: [...draft.questions.filter(q => q.number !== number), { number, stem, pageId: selected, confirmed }] });
  }
  async function importPages(event: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])]; event.target.value = '';
    if (!files.length) return;
    setLoading(true); onBusy(true); setMessage('正在保存空白卷文件…');
    try {
      if(files.some(f=>!/\.(jpe?g|png|webp|pdf|docx)$/i.test(f.name)))throw new Error('paper_file_type');
      if(files.some(f=>f.size>6*1024*1024))throw new Error('paper_file_size');
      const pages = [];let duplicates=0;
      for (const file of files) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file);
        });
        const extension=file.name.split('.').pop()!.toLowerCase();
        const encoded=data.slice(data.indexOf(',')+1);
        const mime=extension==='pdf'?'application/pdf':extension==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':extension==='jpg'||extension==='jpeg'?'image/jpeg':`image/${extension}`;
        const normalized=`data:${mime};base64,${encoded}`;
        if(['pdf','docx'].includes(extension)){
          const header=new Uint8Array(await file.slice(0,8).arrayBuffer());
          if(extension==='pdf'?!new TextDecoder().decode(header).startsWith('%PDF-'):!(header[0]===80&&header[1]===75&&header[2]===3&&header[3]===4))throw new Error();
        }else{const image=new Image();image.src=normalized;await image.decode();}
        if([...draft.pages,...pages].some(p=>p.data===normalized)){duplicates++;continue;}
        pages.push({ id: crypto.randomUUID(), name: file.name, data:normalized });
      }
      if(!pages.length){setMessage('该文件已经上传，无需重复添加。点击“生成结果”后才会读取和处理。');return;}
      if(draft.pages.length+pages.length>30)throw new Error('paper_file_count');
      if([...draft.pages,...pages].reduce((sum,p)=>sum+p.data.length,0)>8*1024*1024)throw new Error('paper_total_size');
      const next=validatePaper({ ...draft, pages: [...draft.pages, ...pages] }, numbers);
      if(await save(next)){setDraft(next);setMessage(`空白卷已保存到本机。${duplicates?`跳过 ${duplicates} 个重复文件。`:''}点击“生成结果”后，Agent 才会读取、核对并出题。`);}
      else setMessage('空白卷未能保存，请检查上方提示后重新上传。');
    } catch(error) {
      const code=error instanceof Error?error.message:'';
      const reasons:Record<string,string>={paper_file_type:'文件格式不支持，请选择照片、PDF 或 Word（.docx）；旧 .doc 请另存为 .docx 或 PDF。',paper_file_size:'单个文件超过 6 MB，请压缩或拆分后添加。',paper_file_count:'本场已保存文件与新增文件合计超过 30 个。',paper_total_size:'本场已有文件与新增文件编码合计超过 8 MB，请压缩文件或减少上传内容。'};
      setMessage(`导入失败：${reasons[code]??'文件内容无法读取，请确认文件完整且格式正确。'}原来已保存的文件保留。`);
    }
    finally { setLoading(false); onBusy(false); }
  }
  return <section className="card" id="paper-review" aria-label="试卷题干核对">
    <div className="card-heading"><h2>上传空白卷</h2><span className="muted">已保存 {paper?.pages.length ?? 0} 个文件或页面</span></div>
    <p className="help">上传时只保存到本机，不识别、不调用模型。支持照片、Word（.docx）和 PDF；文档在点击生成时才在本机展开为页面。请上传无学生姓名的空白试卷；点击“生成结果”后统一读取、核对、检索知识库并出题。</p>
    <label className="file-input">添加照片、Word 或 PDF<input aria-label="添加试卷照片" type="file" multiple accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp,.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={disabled} onChange={e => void importPages(e)}/></label>
    {!!paper?.pages.length&&<ul aria-label="已上传空白卷文件">{paper.pages.map((file,i)=><li key={file.id}>{i+1}. {file.name} <span className="muted">· 已保存</span></li>)}</ul>}
    <details><summary>手动查看或修正题干（可选）</summary>
    <div className="fields">
      <label>成绩题号<select aria-label="成绩题号" value={number} disabled={disabled} onChange={e => setNumber(e.target.value)}>{numbers.map(n => <option key={n}>{n}</option>)}</select></label>
      <label>来源照片<select aria-label="来源照片" value={pageId} disabled={disabled || !draft.pages.length} onChange={e => update(q?.stem ?? '', e.target.value)}>{draft.pages.length ? draft.pages.map((p,i) => <option key={p.id} value={p.id}>第 {i+1} 页 · {p.name}</option>) : <option value="">请先添加照片</option>}</select></label>
    </div>
    {page?.data.startsWith('data:image/') && <a href={page.data} target="_blank" rel="noreferrer"><img className="paper-preview" src={page.data} alt={`试卷来源：${page.name}`}/></a>}
    {page&&!page.data.startsWith('data:image/')&&<p className="help">{page.name}：文件已保存，点击“生成结果”时才展开页面。</p>}
    <label className="paper-stem">第 {number} 题题干<textarea aria-label="题干" rows={9} maxLength={20000} disabled={disabled || !page} value={q?.stem ?? ''} onChange={e => update(e.target.value, pageId)}/></label>
    <label><input aria-label="已核对题干" type="checkbox" checked={q?.confirmed ?? false} disabled={disabled || !page || !q?.stem.trim()} onChange={e => update(q?.stem ?? '', pageId, e.target.checked)}/> 已核对题号、题干与来源照片</label>
    <p className="help">修改题干或来源后需重新核对；保存试卷会清除本场旧出题与审核结果。未保存的草稿在退出程序后丢失；替换或清除当前考试会同时清除照片与题干。</p>
    <div className="actions"><button disabled={disabled} onClick={() => {
      try { const checked = validatePaper(draft, numbers); void save(checked); setMessage('已提交保存，请查看上方当前考试的保存结果。'); }
      catch { setMessage('题干或来源不完整，请检查后保存。'); }
    }}>保存试卷与核对结果</button><button className="secondary" disabled={disabled} onClick={() => { setDraft(paper ?? { pages: [], questions: [] }); setMessage('已恢复为上次保存的试卷。'); }}>撤销未保存修改</button></div>
    </details>
    {message && <p role="status">{message}</p>}
  </section>;
}
