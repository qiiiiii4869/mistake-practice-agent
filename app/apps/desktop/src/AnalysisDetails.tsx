import React from 'react';
import './analysis.css';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { analyze, type compareExams, type ExamHistory, type Workspace } from '../../../packages/core/src';
import { examTrend, heatCell } from '../../../packages/core/src/analysis';

const format = (value: number) => String(Number(value.toFixed(2)));
const status = (value: string) => value === 'not_scanned' ? '没扫' : value === 'no_original_paper' ? '无原卷' : '无计分记录';

export function QuestionDetail({ workspace, number, onClose }: {workspace:Workspace; number:string; onClose:()=>void}) {
  const rows = workspace.students.map(student => ({student, question:student.questions.find(q=>q.number === number)}));
  return <div className="analysis-detail" role="region" aria-label={`第 ${number} 题明细`}>
    <div className="chart-heading"><h3>第 {number} 题 · 学生得分</h3><button className="secondary small" onClick={onClose}>收起明细</button></div>
    <div className="analysis-detail-list">{rows.map(({student,question})=><span key={student.id}><b>{student.name || '未命名学生'}</b> {question ? `${format(question.score)} / ${format(question.fullScore)}` : status(student.availability)}</span>)}</div>
  </div>;
}

export function StudentHeatmap({workspace}:{workspace:Workspace}) {
  const [search,setSearch] = React.useState('');
  const [sort,setSort] = React.useState('rank');
  const [rowPage,setRowPage] = React.useState(0);
  const [colPage,setColPage] = React.useState(0);
  const [selected,setSelected] = React.useState<{studentId:string; number:string}|null>(null);
  const questions = React.useMemo(()=>analyze(workspace).questions,[workspace]);
  const maps = React.useMemo(()=>new Map(workspace.students.map(s=>[s.id,new Map(s.questions.map(q=>[q.number,q]))])),[workspace]);
  const students = React.useMemo(()=>{
    const rate = (student: Workspace['students'][number]) => {
      const full = student.questions.reduce((sum,q)=>sum+q.fullScore,0);
      return full > 0 ? student.questions.reduce((sum,q)=>sum+q.score,0)/full : Infinity;
    };
    return workspace.students.filter(s=>s.name.includes(search.trim())).sort((a,b)=>sort === 'name'
      ? a.name.localeCompare(b.name,'zh-CN') : sort === 'score' ? rate(a)-rate(b) : (a.classRank ?? Infinity)-(b.classRank ?? Infinity));
  },[workspace,search,sort]);
  const rowCount = Math.max(1,Math.ceil(students.length/25)), colCount = Math.max(1,Math.ceil(questions.length/30));
  const page = Math.min(rowPage,rowCount-1), column = Math.min(colPage,colCount-1);
  const visibleQuestions = questions.slice(column*30,(column+1)*30);
  const person = workspace.students.find(s=>s.id===selected?.studentId);
  const question = person?.questions.find(q=>q.number===selected?.number);
  return <section className="chart-panel chart-wide" aria-label="学生逐题热力图">
    <div className="chart-heading"><div><h2>学生逐题热力图</h2><p>颜色表示得分率，点击格子查看学生和题目</p></div></div>
    <div className="analysis-controls"><label>查找学生<input type="search" value={search} onChange={e=>{setSearch(e.target.value);setRowPage(0);}}/></label>
      <label>学生排序<select value={sort} onChange={e=>{setSort(e.target.value);setRowPage(0);}}><option value="rank">班级名次</option><option value="score">得分率从低到高</option><option value="name">姓名</option></select></label></div>
    <div className="heatmap-legend">{[[0,1,'0%'],[0.5,1,'不足60%'],[0.8,1,'60%至不足100%'],[1,1,'100%'],[null,null,'无计分记录']].map(([score,full,label])=><span key={String(label)}><i style={{background:heatCell(score as number|null,full as number|null).color}}/>{label}</span>)}</div>
    {students.length ? <div className="heatmap-scroll"><table className="heatmap"><thead><tr><th>学生</th>{visibleQuestions.map(q=><th key={q.number}>第{q.number}题</th>)}</tr></thead><tbody>
      {students.slice(page*25,(page+1)*25).map(s=><tr key={s.id}><th scope="row">{s.name || '未命名学生'}</th>{visibleQuestions.map(q=>{
        const record = maps.get(s.id)?.get(q.number);
        const cell = heatCell(record?.score ?? null,record?.fullScore ?? null);
        const label = `${s.name || '未命名学生'} 第 ${q.number} 题 ${record ? cell.label : status(s.availability)}`;
        return <td key={q.number}><button title={label} aria-label={label} style={{background:cell.color}} onClick={()=>setSelected({studentId:s.id,number:q.number})}>{record && record.fullScore > 0 ? `${format(record.score)}` : '—'}</button></td>;
      })}</tr>)}
    </tbody></table></div> : <div className="chart-empty">没有匹配的学生</div>}
    <div className="analysis-pagination"><span>学生 {page+1} / {rowCount} 页 · 共 {students.length} 人</span><button className="secondary small" disabled={page===0} onClick={()=>setRowPage(page-1)}>上一页学生</button><button className="secondary small" disabled={page===rowCount-1} onClick={()=>setRowPage(page+1)}>下一页学生</button>
      {colCount > 1 && <><span>题目 {column+1} / {colCount} 页</span><button className="secondary small" disabled={column===0} onClick={()=>setColPage(column-1)}>上一页题目</button><button className="secondary small" disabled={column===colCount-1} onClick={()=>setColPage(column+1)}>下一页题目</button></>}</div>
    {selected && person && <div className="analysis-detail" role="region" aria-label="热力图成绩明细"><div className="chart-heading"><h3>{person.name || '未命名学生'} · 第 {selected.number} 题</h3><button className="secondary small" onClick={()=>setSelected(null)}>收起明细</button></div>
      <p>{question ? heatCell(question.score,question.fullScore).label : status(person.availability)}</p>
      <p>失分题：{person.availability === 'scored' ? person.questions.filter(q=>q.fullScore>q.score).map(q=>q.number).join('、') || '无' : '无逐题记录'}</p>
    </div>}
  </section>;
}

export function RankChanges({changes, selectedExam}:{changes:ReturnType<typeof compareExams>;selectedExam:string|undefined}) {
  const [filter,setFilter] = React.useState('all');
  const [page,setPage] = React.useState(0);
  const [selected,setSelected] = React.useState('');
  const rows = [...changes].filter(s=>filter==='up' ? s.change>0 : filter==='down' ? s.change<0 : true)
    .sort((a,b)=>Math.abs(b.change)-Math.abs(a.change) || a.currentRank-b.currentRank);
  const pages = Math.max(1,Math.ceil(rows.length/20)), index = Math.min(page,pages-1);
  const visible = rows.slice(index*20,(index+1)*20);
  const extent = Math.max(1,...visible.map(s=>Math.abs(s.change)));
  const person = changes.find(s=>s.id===selected);
  return <section className="chart-panel chart-wide" aria-label="学生名次变化图">
    <div className="chart-heading"><div><h2>学生名次变化</h2><p>{selectedExam ? `对比 ${selectedExam} · 按变化幅度排序` : '先在上方选择对比考试'}</p></div></div>
    <div className="analysis-controls"><label>查看范围<select value={filter} onChange={e=>{setFilter(e.target.value);setPage(0);}}><option value="all">全部参与学生</option><option value="up">名次上升</option><option value="down">名次下降</option></select></label><span>绿色上升，红色下降 · 共 {rows.length} 人</span></div>
    {visible.length ? <div className="chart-scroll"><div style={{minWidth:500,height:Math.max(230,visible.length*34+45)}}><ResponsiveContainer width="100%" height="100%"><BarChart data={visible} layout="vertical" margin={{top:8,right:30,left:8,bottom:4}}>
      <CartesianGrid horizontal={false} stroke="#e8eeeb" strokeDasharray="3 4"/><XAxis type="number" domain={[-extent,extent]} allowDecimals={false} tickFormatter={value=>`${value>0?'+':''}${value}`} tickLine={false} axisLine={false}/><YAxis type="category" dataKey="name" width={90} tick={{fontSize:12}} tickLine={false} axisLine={false}/><ReferenceLine x={0} stroke="#9bafa4"/>
      <Tooltip formatter={value=>[`${Number(value)>0?'上升':Number(value)<0?'下降':'持平'} ${Math.abs(Number(value))} 名`,'班级名次']}/><Bar dataKey="change" name="班级名次变化" isAnimationActive={false} maxBarSize={19} radius={3} onClick={(_entry,i)=>setSelected(visible[i]?.id ?? '')}>{visible.map(s=><Cell key={s.id} fill={s.change>0?'#438d76':s.change<0?'#c37a70':'#a5b3ac'}/>)}</Bar>
    </BarChart></ResponsiveContainer></div></div> : <div className="chart-empty">{selectedExam ? '没有符合条件的可比较学生' : '请选择对比考试'}</div>}
    {visible.length>0 && <><div className="analysis-pagination"><span>{index+1} / {pages} 页</span><button className="secondary small" disabled={index===0} onClick={()=>setPage(index-1)}>上一页名次</button><button className="secondary small" disabled={index===pages-1} onClick={()=>setPage(index+1)}>下一页名次</button></div>
      <details><summary>查看名次明细</summary><div className="rank-student-list">{visible.map(s=><button key={s.id} className="secondary small" onClick={()=>setSelected(s.id)}>{s.name || '未命名学生'}：{s.previousRank} → {s.currentRank} 名</button>)}</div></details></>}
    {person && <p className="notice" role="status">{person.name || '未命名学生'}：上次第 {person.previousRank} 名，{format(person.previousScore)} 分；本次第 {person.currentRank} 名，{format(person.score)} 分。</p>}
    <p className="chart-footnote">任一场缺考、0 分或没有有效班级名次的学生不参与。选择对比考试与上方亮点共用。</p>
  </section>;
}

export function ClassTrend({workspace,history,historyError}:{workspace:Workspace;history:ExamHistory[];historyError:boolean}) {
  const base = React.useMemo(()=>examTrend(workspace,history),[workspace,history]);
  const [order,setOrder] = React.useState<string[]>([]);
  const ordered = [...base].sort((a,b)=>{
    const position = (id:string) => {const i=order.indexOf(id);return i<0 ? order.length+base.findIndex(r=>r.id===id) : i;};
    return position(a.id)-position(b.id);
  });
  const rows = ordered.map((r,i)=>({...r,axisLabel:`${i+1}. ${r.name}${r.current?'（当前）':''}`}));
  function move(index:number,direction:number) {
    const ids=ordered.map(r=>r.id);[ids[index],ids[index+direction]]=[ids[index+direction],ids[index]];setOrder(ids);
  }
  const missing = rows.filter(r=>r.classAvg==null || r.gradeAvg==null || r.topClassAvg==null);
  return <section className="chart-panel chart-wide" aria-label="班级历次表现趋势图">
    <div className="chart-heading"><div><h2>班级历次表现趋势</h2><p>本班均分 · 年级均分 · 最高班均分，共 {rows.length} 场考试</p></div></div>
    {historyError && <p className="notice">历史成绩读取失败，目前仅展示当前考试。</p>}
    <div className="chart-scroll"><div style={{minWidth:Math.max(560,rows.length*130),height:320}}><ResponsiveContainer width="100%" height="100%"><LineChart data={rows} margin={{top:20,right:30,left:5,bottom:15}}>
      <CartesianGrid vertical={false} stroke="#e8eeeb" strokeDasharray="3 4"/><XAxis dataKey="axisLabel" interval={0} height={55} padding={{left:55,right:75}} tick={{fontSize:11}} tickFormatter={value=>value.length>12 ? value.slice(0,12)+'…' : value} tickLine={false} axisLine={false}/><YAxis width={46} unit="分" tick={{fontSize:11}} tickLine={false} axisLine={false}/>
      <Tooltip formatter={value=>[`${format(Number(value))} 分`]}/><Legend wrapperStyle={{fontSize:12}}/>
      <Line type="linear" dataKey="classAvg" name="本班均分" stroke="#287f68" strokeWidth={3} dot={{r:4}} activeDot={{r:6}} connectNulls={false} isAnimationActive={false}/>
      <Line type="linear" dataKey="gradeAvg" name="年级均分" stroke="#648fc1" strokeWidth={2} dot={{r:4}} connectNulls={false} isAnimationActive={false}/>
      <Line type="linear" dataKey="topClassAvg" name="最高班均分" stroke="#c39547" strokeWidth={2} dot={{r:4}} connectNulls={false} isAnimationActive={false}/>
    </LineChart></ResponsiveContainer></div></div>
    <p className="chart-footnote">包含本机保存的同班同学科考试与当前考试；按首次保存顺序排列，可在下方调整。</p>
    {missing.length>0 && <p className="notice">{missing.length} 场考试缺少部分均分，折线在缺失处断开。重新读取这些考试后会更新。</p>}
    <details><summary>查看考试数据与调整顺序</summary><ol className="trend-order">{rows.map((r,i)=><li key={r.id}><div><b>{r.name}{r.current?'（当前）':''}</b><span>本班 {r.classAvg==null?'未获取':format(r.classAvg)} · 年级 {r.gradeAvg==null?'未获取':format(r.gradeAvg)} · 最高班 {r.topClassAvg==null?'未获取':format(r.topClassAvg)}</span></div><div><button className="secondary small" aria-label={`${r.name}上移`} disabled={i===0} onClick={()=>move(i,-1)}>上移</button><button className="secondary small" aria-label={`${r.name}下移`} disabled={i===rows.length-1} onClick={()=>move(i,1)}>下移</button></div></li>)}</ol></details>
  </section>;
}
