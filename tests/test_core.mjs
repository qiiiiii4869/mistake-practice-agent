import test from 'node:test';
import assert from 'node:assert/strict';
import { auditExport, workspaceFromExport, validateWorkspace, analyze, compareExams, scoreLabel, parseExportText, validateSettings } from '../app/packages/core/src/index.ts';
import {fixture,addUnavailable} from './core_fixture.mjs';
import {examTrend,heatCell} from '../app/packages/core/src/analysis.ts';

test('trend includes all matching local exams, updates current once and preserves missing scores',()=>{
  const w=workspaceFromExport(fixture(),'chrome_extension');
  w.overview={status:'received',classAvg:60,gradeAvg:65,topClassAvg:80,classMax:90,gradeMax:100};
  const record={examId:'old',examName:'Old',classId:w.exam.classId,className:w.exam.className,subjectName:w.exam.subjectName,finishedAt:'test',students:[]};
  const history=[{...record,examId:w.exam.id,classAvg:999,gradeAvg:999,topClassAvg:999},
    {...record,classAvg:0,gradeAvg:55,topClassAvg:70},
    {...record,examId:'unrelated',classId:'other',classAvg:80},
    {...record,examId:'other-subject',subjectName:'different',classAvg:80},
    {...record,examId:'oldest'}];
  const trend=examTrend(w,history);
  assert.deepEqual(trend.map(r=>r.id),['oldest','old',w.exam.id]);
  assert.equal(trend[0].classAvg,null);assert.equal(trend[0].gradeAvg,null);assert.equal(trend[0].topClassAvg,null);
  assert.equal(trend[1].classAvg,0);assert.equal(trend[2].classAvg,60);assert.equal(trend[2].gradeAvg,65);assert.equal(trend[2].topClassAvg,80);
  assert.equal(trend.filter(r=>r.current).length,1);
  assert.equal(examTrend(w,[]).length,1);
});
test('heatmap distinguishes missing records, non-scored questions and actual zero scores',()=>{
  assert.equal(heatCell(null,null).color,heatCell(0,0).color);
  assert.notEqual(heatCell(0,2).color,heatCell(null,null).color);
  assert.equal(heatCell(1,2).label,'1 / 2 · 50.0%');
  assert.notEqual(heatCell(2,2).color,heatCell(0,2).color);
});

test('full class scores and labels are independently recomputed (Python parity)',()=>{
  const {audit} = auditExport(fixture());
  assert.equal(audit.exportedCount,2);assert.equal(audit.questionRecords,4);
  assert.equal(audit.resultCounts.partial_credit,2);
  assert.ok(!JSON.stringify(audit).includes('SYNTHETIC_1'));
});
test('official overview and student ranks survive workspace validation',()=>{
  const d=fixture();
  d.data.overview={status:'received',class_max:90,class_avg:70,grade_max:100,grade_avg:75,top_class_avg:95,top_class_name:'二班'};
  Object.assign(d.data.students[0],{roster_score:80,class_rank:2,grade_rank:12});
  const w=workspaceFromExport(d,'zhixue_webview');
  assert.equal(w.overview.gradeMax,100);assert.equal(w.overview.topClassName,'二班');assert.equal(w.students[0].classRank,2);assert.equal(w.students[0].gradeRank,12);
  assert.deepEqual(validateWorkspace(JSON.parse(JSON.stringify(w))),w);
});
test('exam comparison uses class ranks and excludes missing ranks or zero scores',()=>{
  const w=workspaceFromExport(fixture(),'chrome_extension');
  const current=w.students[0];current.classRank=3;const total=current.questions.reduce((s,q)=>s+q.fullScore,0);
  w.students[1].classRank=9;
  const score=current.questions.reduce((s,q)=>s+q.score,0);
  const prior={examId:'previous',examName:'Previous',classId:w.exam.classId,className:'Class',subjectName:w.exam.subjectName,finishedAt:'now',
    students:[{id:current.id,name:'old name',score:100,fullScore:200,classRank:8},
      {id:w.students[1].id,name:'zero',score:0,fullScore:100,classRank:1},{id:'other',name:'other',score:50,fullScore:100,classRank:1}]};
  const result=compareExams(w,prior);
  assert.equal(result.length,1);assert.equal(result[0].change,5);
  assert.equal(result[0].score,score);assert.equal(result[0].fullScore,total);
  prior.students[0].classRank=null;assert.equal(compareExams(w,prior).length,0);
  prior.students[0].classRank=8;current.rosterScore=0;assert.equal(compareExams(w,prior).length,0);
});
const invalid = [
  ['missing student',d=>d.data.students.pop()],
  ['mislabeled score',d=>d.data.students[0].questions[0].result='incorrect'],
  ['different paper',d=>d.data.students[1].questions[0].question_number=99],
  ['failed request',d=>d.summary.question_records.failures=[{code:'missing_sheet_data'}]],
  ['unprocessed students',d=>d.summary.question_records.unprocessed_students=1],
  ['roster gap',d=>d.summary.roster.student_count=3],
  ['sample export',d=>d.summary.status='passed_live_sample_export'],
  ['not a teacher',d=>d.summary.authentication='not_verified'],
  ['duplicate students',d=>d.data.students[1].student_id='SYNTHETIC_1'],
  ['duplicate questions',d=>d.data.students[0].questions[1].question_number=1],
  ['invalid full score',d=>d.data.students[0].questions[0].full_score=1],
  ['boolean score',d=>d.data.students[0].questions[0].score=true],
  ['negative score',d=>d.data.students[0].questions[0].score=-1],
  ['infinite score',d=>d.data.students[0].questions[0].score=Infinity],
  ['false lost flag',d=>d.data.students[0].questions[1].lost_points=false],
  ['wrong totals',d=>d.summary.result_counts.correct=3],
  ['wrong record total',d=>d.summary.question_records.question_count=5],
  ['credentials with alternate case',d=>d.private={Token:'secret'}],
  ['remote images',d=>d.data.students[0].questions[0].unexpected='https://secret.test/'],
  ['answer original',d=>d.data.students[0].questions[0].student_answer='A'],
];
for (const [name, mutate] of invalid) test(`rejects ${name}`,()=>{const d=fixture();mutate(d);assert.throws(()=>auditExport(d));});
for (const availability of ['not_scanned','no_original_paper']) {
  test(`${availability} preserves roster count and is excluded from analysis`,()=>{
    const d=fixture();addUnavailable(d,availability);
    const w=workspaceFromExport(d,'chrome_extension');const a=analyze(w);
    assert.equal(a.audit.rosterCount,3);assert.equal(a.audit.exportedCount,2);assert.equal(a.audit.questionRecords,4);
    assert.equal(a.questions[1].eligibleStudents,2);assert.deepEqual(a.students[2].weakQuestions,[]);
    assert.equal(a.students[2].availability,availability);
    assert.deepEqual(validateWorkspace(w),w);
  });
}
for (const [name, mutate] of [
  ['unavailable inferred from request failure',s=>s.reason_source='request_failed'],
  ['unavailable judged',s=>s.questions=[{question_number:1}]],
  ['unavailable duplicate',s=>s.student_id='SYNTHETIC_1'],
]) test(`rejects ${name}`,()=>{const d=fixture();addUnavailable(d);mutate(d.data.unavailable_students[0]);assert.throws(()=>auditExport(d));});
test('entirely unavailable class cannot become an exercise exam',()=>{
  const d=fixture();d.data.students=[];addUnavailable(d);assert.throws(()=>auditExport(d),/no_scanned_students/);
});
test('failed probe without data stays an explicit export failure',()=>{
  assert.throws(()=>auditExport({ok:false,summary:{status:'failed',error:'session_expired'}}),/export_reported_failure/);
});
test('paired verification compares objects independent of key order and rejects mismatch',()=>{
  const d=fixture();const v={ok:true,summary:structuredClone(d.summary)};
  v.summary = Object.fromEntries(Object.entries(v.summary).reverse());auditExport(d,v);
  v.summary.finished_at='OTHER';assert.throws(()=>auditExport(d,v),/verification_summary_mismatch/);
});
test('import supports BOM, rejects broken JSON and missing identities',()=>{
  assert.equal(parseExportText('\uFEFF'+JSON.stringify(fixture())).ok,true);
  assert.throws(()=>parseExportText('{'),/invalid_json/);
  const d=fixture();delete d.data.exam_id;assert.throws(()=>workspaceFromExport(d,'chrome_extension'),/missing_identifier/);
});
test('live read must match selected exam, subject and class',()=>{
  assert.throws(()=>workspaceFromExport(fixture(),'zhixue_webview',{classId:'other'}),/selection_mismatch/);
});
test('partial threshold uses strict percent comparison and never changes zero-score selection',()=>{
  const d=fixture();d.data.students[0].questions[0]={question_number:1,score:0,full_score:2,result:'incorrect',lost_points:true};
  d.summary.result_counts.correct--;d.summary.result_counts.incorrect++;
  const w=workspaceFromExport(d,'chrome_extension');
  assert.deepEqual(analyze(w).students[0].weakQuestions,['1','2']);
  w.settings.partialCreditThreshold=30;assert.deepEqual(analyze(w).students[0].weakQuestions,['1']);
  w.settings.partialCreditThreshold=34;assert.deepEqual(analyze(w).students[0].weakQuestions,['1','2']);
  w.settings.includePartialCredit=false;assert.deepEqual(analyze(w).students[0].weakQuestions,['1']);
  assert.equal(analyze(w).questions[0].lostRate,0.5);
});
test('zero full score is unscored and has no eligible denominator',()=>{
  assert.equal(scoreLabel(0,0),'not_scored');
  const d=fixture();for(const s of d.data.students)s.questions[0]={question_number:1,score:0,full_score:0,result:'not_scored',lost_points:false};
  d.summary.result_counts.correct=0;d.summary.result_counts.not_scored=2;
  const a=analyze(workspaceFromExport(d,'chrome_extension'));
  assert.equal(a.questions[0].lostRate,0);assert.equal(a.questions[0].eligibleStudents,0);assert.equal(a.questions[0].weakStudents,0);
});
test('local restored workspace is revalidated, settings bounds enforced',()=>{
  const w=workspaceFromExport(fixture(),'chrome_extension');validateWorkspace(w);
  w.students[0].questions[0].score=99;assert.throws(()=>validateWorkspace(w),/invalid_score/);
  assert.throws(()=>validateSettings({...w.settings,maxQuestionsPerStudent:0}));
  assert.throws(()=>validateSettings({...w.settings,partialCreditThreshold:101}));
});

const paperFixture = () => ({pages:[{id:'page-1',name:'模拟试卷.png',data:'data:image/png;base64,aGVsbG8='}],
  questions:[{number:'1',pageId:'page-1',stem:'模拟题干 A B C D',confirmed:true}]});
test('paper survives validation, settings changes and old workspaces stay compatible', () => {
  const w = workspaceFromExport(fixture(), 'chrome_extension');
  assert.equal(validateWorkspace(w).paper, undefined);
  w.paper = paperFixture();
  assert.deepEqual(validateWorkspace(w).paper, w.paper);
  w.settings.maxQuestionsPerStudent = 8;
  assert.deepEqual(validateWorkspace(w).paper, w.paper);
});
for (const [name, mutate] of [
  ['unknown question', p => p.questions[0].number='999'],
  ['duplicate question', p => p.questions.push({...p.questions[0]})],
  ['missing source', p => p.questions[0].pageId='missing'],
  ['duplicate page', p => p.pages.push({...p.pages[0]})],
  ['remote photo', p => p.pages[0].data='https://example.test/p.png'],
  ['active image', p => p.pages[0].data='data:image/svg+xml;base64,aGVsbG8='],
  ['empty confirmed stem', p => p.questions[0].stem='  '],
  ['oversize photos', p => p.pages[0].data='data:image/png;base64,'+'A'.repeat(8*1024*1024)],
]) test(`paper rejects ${name}`, () => {
  const w = workspaceFromExport(fixture(), 'chrome_extension');
  w.paper = paperFixture(); mutate(w.paper); assert.throws(() => validateWorkspace(w));
});
