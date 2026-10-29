import React from 'react';
import { Award, TrendingDown, TrendingUp } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { analyze, compareExams, comparisonScores, type ExamHistory, type Workspace } from '../../../packages/core/src';
import { ClassTrend, QuestionDetail, RankChanges, StudentHeatmap } from './AnalysisDetails';

export function AnalysisCharts({ workspace, history, historyError, active }: { workspace: Workspace; history: ExamHistory[]; historyError: boolean; active: boolean }) {
  const [comparison, setComparison] = React.useState('');
  const [questionSort,setQuestionSort] = React.useState('number');
  const [selectedQuestion,setSelectedQuestion] = React.useState('');
  const result = React.useMemo(() => analyze(workspace), [workspace]);
  const exams = history.filter(item => item.classId === workspace.exam.classId && item.subjectName === workspace.exam.subjectName && item.examId !== workspace.exam.id && item.subjectName !== '未命名学科');
  const previous = exams.find(item => item.examId === comparison);
  const changes = previous ? compareExams(workspace, previous) : [];
  const maxChange = changes.length ? Math.max(...changes.map(item => item.change)) : 0;
  const minChange = changes.length ? Math.min(...changes.map(item => item.change)) : 0;
  const progress = maxChange > 0 ? changes.filter(item => item.change === maxChange) : [];
  const decline = minChange < 0 ? changes.filter(item => item.change === minChange) : [];
  const totals = comparisonScores(workspace).map(student => ({name:student.name || '未命名学生', score:student.score}));
  const max = totals.length ? Math.max(...totals.map(item => item.score)) : null;
  const best = totals.filter(item => item.score === max);
  const scores = result.questions.filter(q => q.fullScore > 0 && q.eligibleStudents > 0)
    .map(q => ({number:q.number, rate:Number(((1-q.lostRate)*100).toFixed(1))}));
  const weakest = [...scores].sort((a,b) => a.rate-b.rate).slice(0,5);
  const sortedScores = [...scores].sort((a,b)=>questionSort === 'low' ? a.rate-b.rate : questionSort === 'high' ? b.rate-a.rate : a.number.localeCompare(b.number,'en',{numeric:true}));
  const format = (value: number | null | undefined) => value == null ? '未获取' : String(Number(value.toFixed(2)));
  const overview = workspace.overview;
  if (!active) return null;
  return <div className="analysis-grid" aria-label="成绩图表">
    <section className="chart-panel chart-wide" aria-label="学生成绩亮点">
      <div className="chart-heading"><div><h2>学生成绩亮点</h2><p>优先采用智学网成绩，未获取时使用逐题得分合计</p></div></div>
      <label>对比考试<select aria-label="对比考试" value={previous ? comparison : ''} onChange={e => setComparison(e.target.value)}>
        <option value="">请选择同班同学科的历史考试</option>{exams.map(item => <option key={item.examId} value={item.examId}>{item.examName} · {item.className} · {item.subjectName}</option>)}
      </select></label>
      {historyError && <p className="notice">历史成绩读取失败，请重新打开程序后重试。</p>}
      {!historyError && !exams.length && <p className="chart-footnote">暂无可比较的历史考试；读取另一场同班同学科考试后可选择对比。</p>}
      <div className="student-highlights">
        <div className="student-highlight highlight-best"><div className="highlight-title"><Award size={18}/><span>最高分</span></div>
          {best.length ? best.map((item,i)=><div className="highlight-person" key={i}><strong>{item.name}</strong><b>{format(item.score)} <small>分</small></b></div>) : <p className="highlight-empty">暂无成绩</p>}
        </div>
        {([{label:'进步最快', rows:progress, kind:'progress', icon:TrendingUp}, {label:'退步最快', rows:decline, kind:'decline', icon:TrendingDown}] as const).map(({label,rows,kind,icon:Icon}) =>
          <div className={`student-highlight highlight-${kind}`} key={kind}><div className="highlight-title"><Icon size={18}/><span>{label}</span></div>
            {rows.length ? rows.map(item=><div className="highlight-person" key={item.id}><strong>{item.name || '未命名学生'}</strong><b>{format(item.score)} <small>分</small></b><span>第 {item.previousRank} 名 → 第 {item.currentRank} 名 · {item.change > 0 ? '上升' : '下降'} {Math.abs(item.change)} 名</span><span>上次 {format(item.previousScore)} 分</span></div>)
              : <p className="highlight-empty">{!previous ? '请选择对比考试' : !changes.length ? '暂无可比较名次' : kind === 'progress' ? '无人上升' : '无人下降'}</p>}
          </div>)}
      </div>
      {previous && <p className="chart-footnote">按班级名次和学生 ID 比较，共 {changes.length} 人参与；任一场缺考、0 分或缺少名次的学生不参与。</p>}
    </section>
    <section className="chart-panel chart-wide" aria-label="班级和年级成绩概览">
      <div className="chart-heading"><h2>班级和年级成绩概览</h2></div>
      <div className="score-overview">
        <div className="score-overview-row"><div><span>本班均分</span><strong>{format(overview?.classAvg)}</strong></div><div><span>最高班均分</span><strong>{format(overview?.topClassAvg)}</strong></div></div>
        <div className="score-overview-row"><div><span>班级最高</span><strong>{format(overview?.classMax)}</strong></div><div><span>年级最高</span><strong>{format(overview?.gradeMax)}</strong></div></div>
      </div>
    </section>
    <section className="chart-panel chart-wide" aria-label="各题得分率图表">
      <div className="chart-heading"><div><h2>各题得分率</h2><p>各题得分总和 / 可分析学生的该题满分总和</p></div><span className="chart-chip">点击柱子查看学生</span></div>
      <div className="analysis-controls"><label>题目排序<select value={questionSort} onChange={e=>setQuestionSort(e.target.value)}><option value="number">按题号</option><option value="low">得分率从低到高</option><option value="high">得分率从高到低</option></select></label><label>查看题目<select value={selectedQuestion} onChange={e=>setSelectedQuestion(e.target.value)}><option value="">请选择题目</option>{sortedScores.map(q=><option key={q.number} value={q.number}>第 {q.number} 题 · {q.rate}%</option>)}</select></label></div>
      {scores.length ? <div className="chart-scroll"><div style={{width:'100%',minWidth:Math.max(500,scores.length*38),height:260}}>
        <ResponsiveContainer width="100%" height="100%"><BarChart data={sortedScores} margin={{top:10,right:20,left:0,bottom:5}}>
          <CartesianGrid vertical={false} stroke="var(--color-chart-grid)" strokeDasharray="3 4"/><XAxis dataKey="number" tickLine={false} axisLine={false} tick={{fill:'var(--color-muted)',fontSize:11}} interval={0}/><YAxis domain={[0,100]} width={44} tickFormatter={value=>`${value}%`} tickLine={false} axisLine={false} tick={{fill:'var(--color-muted)',fontSize:11}}/>
          <Tooltip formatter={value=>[`${value}%`,'得分率']} labelFormatter={value=>`第 ${value} 题`}/><Bar dataKey="rate" name="得分率" fill="var(--color-chart-primary)" radius={[6,6,0,0]} maxBarSize={28} isAnimationActive={false} onClick={(_entry,i)=>setSelectedQuestion(sortedScores[i]?.number ?? '')}/>
        </BarChart></ResponsiveContainer></div></div> : <div className="chart-empty">没有可计分的题目</div>}
      {weakest.length > 0 && <div className="chart-highlights"><span>得分率较低</span>{weakest.map(q=><span className="question-tag" key={q.number}>第 {q.number} 题 <b>{q.rate}%</b></span>)}</div>}
      {selectedQuestion && <QuestionDetail workspace={workspace} number={selectedQuestion} onClose={()=>setSelectedQuestion('')}/>}
    </section>
    <StudentHeatmap workspace={workspace}/>
    <RankChanges changes={changes} selectedExam={previous?.examName}/>
    <ClassTrend workspace={workspace} history={history} historyError={historyError}/>
  </div>;
}
