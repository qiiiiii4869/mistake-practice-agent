import React from 'react';
import type { Paper } from '../../../packages/core/src';
import { validatePaper } from '../../../packages/paper/src';

interface Props { paper?: Paper; numbers: string[]; locked: boolean; onBusy: (busy: boolean) => void; save: (paper: Paper) => Promise<void> }
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
  return <section className="card" aria-label="试卷题干核对">
    <div className="card-heading"><h2>试卷与题号核对</h2><span className="muted">已核对 {draft.questions.filter(q => q.confirmed).length} / {numbers.length} 题</span></div>
    <p className="help">照片仅保存在本机当前考试。自动识别尚待模型接口接入；目前请对照照片手动录入，选择题请连同选项录入，共用材料请一并填写。</p>
    <label className="file-input">添加试卷照片<input aria-label="添加试卷照片" type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={disabled} onChange={e => void importPages(e)}/></label>
    <div className="fields">
      <label>成绩题号<select aria-label="成绩题号" value={number} disabled={disabled} onChange={e => setNumber(e.target.value)}>{numbers.map(n => <option key={n}>{n}</option>)}</select></label>
      <label>来源照片<select aria-label="来源照片" value={pageId} disabled={disabled || !draft.pages.length} onChange={e => update(q?.stem ?? '', e.target.value)}>{draft.pages.length ? draft.pages.map((p,i) => <option key={p.id} value={p.id}>第 {i+1} 页 · {p.name}</option>) : <option value="">请先添加照片</option>}</select></label>
    </div>
    {page && <a href={page.data} target="_blank" rel="noreferrer"><img className="paper-preview" src={page.data} alt={`试卷来源：${page.name}`}/></a>}
    <label className="paper-stem">第 {number} 题题干<textarea aria-label="题干" rows={9} maxLength={20000} disabled={disabled || !page} value={q?.stem ?? ''} onChange={e => update(e.target.value, pageId)}/></label>
    <label><input aria-label="已核对题干" type="checkbox" checked={q?.confirmed ?? false} disabled={disabled || !page || !q?.stem.trim()} onChange={e => update(q?.stem ?? '', pageId, e.target.checked)}/> 已核对题号、题干与来源照片</label>
    <p className="help">修改题干或来源后需重新核对。未保存的草稿在退出程序后丢失；替换或清除当前考试会同时清除照片与题干。</p>
    <div className="actions"><button disabled={disabled} onClick={() => {
      try { const checked = validatePaper(draft, numbers); void save(checked); setMessage('已提交保存，请查看上方当前考试的保存结果。'); }
      catch { setMessage('题干或来源不完整，请检查后保存。'); }
    }}>保存试卷与核对结果</button><button className="secondary" disabled={disabled} onClick={() => { setDraft(paper ?? { pages: [], questions: [] }); setMessage('已恢复为上次保存的试卷。'); }}>撤销未保存修改</button></div>
    {message && <p role="status">{message}</p>}
  </section>;
}
