import test from 'node:test';
import assert from 'node:assert/strict';
import { auditExport, workspaceFromExport, validateWorkspace, analyze, scoreLabel, parseExportText, validateSettings } from '../app/packages/core/src/index.ts';
import {fixture,addUnavailable} from './core_fixture.mjs';

test('full class scores and labels are independently recomputed (Python parity)',()=>{
  const {audit} = auditExport(fixture());
  assert.equal(audit.exportedCount,2);assert.equal(audit.questionRecords,4);
  assert.equal(audit.resultCounts.partial_credit,2);
  assert.ok(!JSON.stringify(audit).includes('SYNTHETIC_1'));
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
