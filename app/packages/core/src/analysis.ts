import { comparisonScores, type ExamHistory, type Workspace } from './index.ts';

export function examTrend(workspace: Workspace, history: ExamHistory[]) {
  // History is returned newest first. First-save order is distinct from exam date.
  const records = new Map<string, ExamHistory>();
  for (const item of [...history].reverse()) {
    if (item.classId === workspace.exam.classId && item.subjectName === workspace.exam.subjectName) records.set(item.examId, item);
  }
  records.set(workspace.exam.id, {examId:workspace.exam.id, examName:workspace.exam.name,
    classId:workspace.exam.classId, className:workspace.exam.className, subjectName:workspace.exam.subjectName,
    finishedAt:workspace.source.finishedAt, students:comparisonScores(workspace),
    classAvg:workspace.overview?.classAvg, gradeAvg:workspace.overview?.gradeAvg, topClassAvg:workspace.overview?.topClassAvg});
  return [...records.values()].map(item => {
    const metric = (value: number | null | undefined) => value != null && Number.isFinite(value) && value >= 0 ? value : null;
    return {id:item.examId, name:item.examName, current:item.examId === workspace.exam.id,
      classAvg:metric(item.classAvg), gradeAvg:metric(item.gradeAvg), topClassAvg:metric(item.topClassAvg)};
  });
}

export function heatCell(score: number | null, fullScore: number | null) {
  if (score == null || fullScore == null || fullScore <= 0) return {color:'#edf0ee', label:'无计分记录'};
  const rate = score/fullScore;
  return {color:rate === 0 ? '#f2d6ce' : rate < 0.6 ? '#f3e7be' : rate < 1 ? '#c9e1d8' : '#70aa96',
    label:`${score} / ${fullScore} · ${(rate*100).toFixed(1)}%`};
}
