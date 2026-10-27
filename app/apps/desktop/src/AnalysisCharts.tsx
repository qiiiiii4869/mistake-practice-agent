import React from 'react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { analyze, type Workspace } from '../../../packages/core/src';

const COLORS = { correct: '#3c907b', partial: '#d3a44e', incorrect: '#cf7771', unscored: '#a8b1af', bars: '#648fc1' };

export function AnalysisCharts({ workspace, active }: { workspace: Workspace; active: boolean }) {
  const result = React.useMemo(() => analyze(workspace), [workspace]);
  const loss = result.questions.filter(question => question.fullScore > 0 && question.eligibleStudents > 0)
    .map(question => ({ number: question.number, rate: Number((question.lostRate * 100).toFixed(1)), weak: question.weakStudents }));
  const distribution = [
    { name: '全对', value: result.audit.resultCounts.correct, color: COLORS.correct },
    { name: '部分得分', value: result.audit.resultCounts.partial_credit, color: COLORS.partial },
    { name: '全错', value: result.audit.resultCounts.incorrect, color: COLORS.incorrect },
    { name: '不计分', value: result.audit.resultCounts.not_scored, color: COLORS.unscored },
  ];
  const bands = [
    { name: '60%以下', min: 0, max: 60, count: 0 },
    { name: '60–69%', min: 60, max: 70, count: 0 },
    { name: '70–79%', min: 70, max: 80, count: 0 },
    { name: '80–89%', min: 80, max: 90, count: 0 },
    { name: '90–100%', min: 90, max: 101, count: 0 },
  ];
  for (const student of workspace.students) {
    if (student.availability !== 'scored') continue;
    const scoredQuestions = student.questions.filter(question => question.fullScore > 0);
    const total = scoredQuestions.reduce((sum, question) => sum + question.fullScore, 0);
    if (!total) continue;
    const percent = scoredQuestions.reduce((sum, question) => sum + question.score, 0) / total * 100;
    const band = bands.find(item => percent >= item.min && percent < item.max);
    if (band) band.count++;
  }
  const scored = bands.reduce((sum, band) => sum + band.count, 0);
  const totals = workspace.students.filter(student => student.availability === 'scored' && student.questions.some(q => q.fullScore > 0))
    .map(student => student.questions.reduce((sum, q) => sum + q.score, 0));
  const formatScore = (value: number | null | undefined) => value == null ? '未获取' : Number(value.toFixed(2));
  const overview = workspace.overview;
  const weak = loss.filter(question => question.rate > 0).sort((a, b) => b.rate - a.rate).slice(0, 5);
  if (!active) return null;

  return <div className="analysis-grid" aria-label="成绩图表">
    <section className="chart-panel chart-wide" aria-label="班级和年级成绩概览">
      <div className="chart-heading"><div><h2>班级和年级成绩概览</h2><p>智学网统计与已读取逐题成绩分别展示</p></div></div>
      <div className="table-scroll"><table><thead><tr><th>统计口径</th><th>最高分</th><th>最低分</th><th>平均分</th><th>人数</th></tr></thead><tbody>
        <tr><td>智学网班级统计</td><td>{formatScore(overview?.classMax)}</td><td>未获取</td><td>{formatScore(overview?.classAvg)}</td><td>未获取</td></tr>
        <tr><td>智学网年级统计</td><td>{formatScore(overview?.gradeMax)}</td><td>未获取</td><td>{formatScore(overview?.gradeAvg)}</td><td>未获取</td></tr>
        <tr><td>已读取逐题成绩</td><td>{formatScore(totals.length ? Math.max(...totals) : null)}</td><td>{formatScore(totals.length ? Math.min(...totals) : null)}</td><td>{formatScore(totals.length ? totals.reduce((a,b) => a+b, 0) / totals.length : null)}</td><td>{totals.length}</td></tr>
      </tbody></table></div>
      <p className="chart-footnote">逐题统计不包含没扫、无原卷和无可计分题的学生；智学网统计可能采用不同人数或口径。旧数据需重新读取才能获取智学网概览与名次。</p>
    </section>
    <section className="chart-panel chart-wide" aria-label="各题失分率图表">
      <div className="chart-heading"><div><h2>各题失分率</h2><p>各题失分总和 / 可分析学生的该题满分总和</p></div><span className="chart-chip">按题统计</span></div>
      {loss.length ? <div className="chart-scroll"><div style={{ width: '100%', minWidth: Math.max(500, loss.length * 38), height: 260 }}>
        <ResponsiveContainer width="100%" height="100%"><BarChart data={loss} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
          <CartesianGrid vertical={false} stroke="#e8eeeb" strokeDasharray="3 4"/><XAxis dataKey="number" tickLine={false} axisLine={false} tick={{ fill: '#73877e', fontSize: 11 }} interval={0}/><YAxis domain={[0, 100]} width={44} tickFormatter={value => `${value}%`} tickLine={false} axisLine={false} tick={{ fill: '#73877e', fontSize: 11 }}/>
          <Tooltip formatter={value => [`${value}%`, '失分率']} labelFormatter={value => `第 ${value} 题`}/><Bar dataKey="rate" name="失分率" fill={COLORS.bars} radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false}/>
        </BarChart></ResponsiveContainer></div></div> : <div className="chart-empty">没有可计分的题目</div>}
      {weak.length > 0 && <div className="chart-highlights"><span>失分率较高</span>{weak.map(question => <span className="question-tag" key={question.number}>第 {question.number} 题 <b>{question.rate}%</b></span>)}</div>}
    </section>
    <section className="chart-panel" aria-label="逐题得分情况图表">
      <div className="chart-heading"><div><h2>逐题得分情况</h2><p>按逐题记录统计 · 共 {result.audit.questionRecords} 条</p></div></div>
      <div className="distribution-layout"><div className="donut-wrap"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={distribution.filter(item => item.value > 0)} dataKey="value" nameKey="name" innerRadius="63%" outerRadius="90%" stroke="#fff" strokeWidth={3} isAnimationActive={false}>{distribution.filter(item => item.value > 0).map(item => <Cell key={item.name} fill={item.color}/>)}</Pie><Tooltip formatter={value => [`${value} 条`, '记录数']}/></PieChart></ResponsiveContainer><div className="donut-center"><strong>{result.audit.questionRecords}</strong><span>逐题记录</span></div></div>
        <div className="chart-legend">{distribution.map(item => <div key={item.name}><span className="legend-name"><i style={{ background: item.color }}/>{item.name}</span><b>{item.value}</b><span>{result.audit.questionRecords ? (item.value / result.audit.questionRecords * 100).toFixed(1) : '0.0'}%</span></div>)}</div>
      </div>
    </section>
    <section className="chart-panel" aria-label="学生得分分布图表">
      <div className="chart-heading"><div><h2>学生得分分布</h2><p>按逐题得分合计 / 满分合计 · {scored} 人</p></div></div>
      {scored ? <div className="band-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={bands} margin={{ top: 14, right: 10, left: -15, bottom: 2 }}>
        <CartesianGrid vertical={false} stroke="#e8eeeb" strokeDasharray="3 4"/><XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fill: '#73877e', fontSize: 10 }}/><YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: '#73877e', fontSize: 11 }}/><Tooltip formatter={value => [`${value} 人`, '学生数']}/><Bar dataKey="count" fill={COLORS.correct} radius={[3, 3, 0, 0]} maxBarSize={40} isAnimationActive={false}><LabelList dataKey="count" position="top" fill="#668779" fontSize={10}/></Bar>
      </BarChart></ResponsiveContainer></div> : <div className="chart-empty">暂无可计分学生</div>}
      <p className="chart-footnote">没扫、无原卷以及无可计分题的学生不计入。</p>
    </section>
  </div>;
}
