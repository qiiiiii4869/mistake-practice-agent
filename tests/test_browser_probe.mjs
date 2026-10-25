import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { zhixueProbe } from '../browser-probe/probe.mjs';

// Every network response here is synthetic. None of these tests proves live access.
const calls = [];
function install({ role='teacher', roster, businessError=false, brokenPaper=false, badScore=false, classMismatch=false, backendFail=false, totalCount, scopeClasses, rowSubject, paperTransform, failPaperOnce=false, expireAt, structuredPaper }={}) {
  calls.length=0;
  globalThis.location={origin:'https://www.zhixue.com'};
  globalThis.fetch=async(url,options)=>{
    const u=new URL(url);calls.push({url:u,options});
    assert.equal(options.method,'GET');
    assert.equal(options.credentials,'include');
    assert.ok(['www.zhixue.com','ali-bg.zhixue.com'].includes(u.hostname));
    const path=u.pathname;
    let result;
    if(path==='/container/getCurrentUser')result={role,id:'private-teacher-id'};
    else if(path==='/container/app/token/getToken')result='PRIVATE_SESSION_TOKEN';
    else if(backendFail)throw new TypeError('network failed with PRIVATE_SESSION_TOKEN');
    else if(path.includes('getAcademicTermTeachingCycle'))result={schoolId:'school1',termTeachingCycleMap:{term:[{id:'cycle1',termId:'term1',beginTime:1,endTime:9999999999999}]}};
    else if(path.includes('getUserTeachingInfos'))result={gradeClassSubjectDTO:[{gradeCode:'g3',classes:scopeClasses??[{classId:'class1',className:'三班',subjects:[{subjectCode:'bio',subjectName:'生物'}]}]}]};
    else if(path.includes('getClassReportList'))result={classPaperSummaryList:[{examId:'exam1',examName:'Synthetic exam'}],pageInfoDTO:{totalCount:1}};
    else if(path.includes('getSubjectsIncludeSubAndGroup'))result=[{topicSetId:'paper1',subjectName:'生物',subjectCode:'bio'},{topicSetId:'mathpaper',subjectName:'数学',subjectCode:'math'},{subjectName:'总分',isSubjectGroup:true}];
    else if(path.includes('singleScoreList'))result={studentAnswerRecords:roster??[{userId:'private-student-id',userName:'Private Student',classId:classMismatch?'other':'class1',subjectCode:rowSubject??'bio',topicSetId:'paper1'}],...(totalCount===undefined?{}:{totalCount})};
    else if(path.includes('getNewCheckSheet'))result=structuredPaper??{};
    else if(path.includes('/checksheet/')) {
      const number=calls.filter(call=>call.url.pathname.includes('/checksheet/')).length;
      if(failPaperOnce&&number===1)throw new TypeError('temporary_network_failure');
      if(expireAt===number)return {ok:false,status:403,headers:new Headers()};
      const data={userAnswerRecordDTO:{answerRecordDetails:[
        {topicNumber:3,dispTitle:'3',answer:'D',score:badScore?-1:0,standardScore:2,answerType:'s01Text',isCorrect:false},
        {topicNumber:21,answer:'https://example.invalid/private?token=SIGNED_IMAGE_SECRET',score:3,standardScore:6,answerType:'s02Image',subTopics:[{subTopicIndex:1,score:3}]},
      ]}};
      if(paperTransform)paperTransform(data,number);
      const html=brokenPaper?'<html>login again</html>':`const sheetDatas = ${JSON.stringify(data)}; var another = 1; const sheetImages = [];`;
      return {ok:true,status:200,headers:new Headers(),text:async()=>html};
    } else throw new Error('unexpected endpoint '+path);
    return {ok:true,status:200,headers:new Headers(),json:async()=>({errorCode:businessError&&path.includes('getClassReportList')?-403:200,result})};
  };
}
const selection={action:'export',examId:'exam1',subjectId:'paper1',classId:'class1'};

test('manifest limits access to explicit current-tab action and local downloads',()=>{
  const m=JSON.parse(fs.readFileSync(new URL('../browser-probe/manifest.json',import.meta.url)));
  assert.deepEqual(m.permissions,['activeTab','scripting','downloads']);
  assert.equal(m.host_permissions,undefined);
  assert.equal(m.externally_connectable,undefined);
});
test('injected function is self contained when serialized',async()=>{
  install();
  const isolated=Function(`return (${zhixueProbe.toString()})`)();
  const r=await isolated({action:'connect'});
  assert.equal(r.ok,true);assert.equal(r.summary.exams.count,1);
  assert.equal(r.options[0].id,'exam1');
  assert.equal(JSON.stringify(r).includes('PRIVATE_SESSION_TOKEN'),false);
  assert.equal(JSON.stringify(r).includes('private-teacher-id'),false);
});
test('rejects foreign origins before any network request',async()=>{
  install();globalThis.location={origin:'https://example.com'};
  const r=await zhixueProbe({action:'connect'});
  assert.equal(r.ok,false);assert.equal(calls.length,0);
});
test('requires an actual teacher role',async()=>{
  install({role:'student'});const r=await zhixueProbe({action:'connect'});
  assert.equal(r.ok,false);assert.equal(r.summary.error,'teacher_session_required');
  assert.equal(calls.length,1);
});
test('application denial with HTTP 200 cannot be marked connected',async()=>{
  install({businessError:true});const r=await zhixueProbe({action:'connect'});
  assert.equal(r.ok,false);assert.equal(r.summary.error,'business_error_-403');
});
test('filters exam subjects and classes to actual teaching scope',async()=>{
  install();let r=await zhixueProbe({action:'subjects',examId:'exam1'});
  assert.equal(r.ok,true);assert.deepEqual(r.subjects.map(x=>x.name),['生物']);
  r=await zhixueProbe({action:'classes',subjectCode:'bio'});
  assert.equal(r.classes[0].id,'class1');
  assert.equal(calls.some(c=>c.url.pathname.includes('schoolClass')),false);
});
test('exports real-shaped question fields without token or signed image URLs',async()=>{
  install();const r=await zhixueProbe(selection);
  assert.equal(r.ok,true);assert.equal(r.summary.status,'passed_live_sample_export');
  assert.equal(r.summary.roster.student_count,1);
  assert.equal(r.summary.question_records.question_count,2);
  assert.equal(r.data.students[0].questions[0].student_answer,'D');
  assert.equal(r.data.students[0].questions[0].lost_points,true);
  assert.equal(r.data.students[0].questions[1].student_answer,null);
  const serialized=JSON.stringify(r);
  assert.equal(serialized.includes('PRIVATE_SESSION_TOKEN'),false);
  assert.equal(serialized.includes('SIGNED_IMAGE_SECRET'),false);
  assert.equal(JSON.stringify(r.summary).includes('Private Student'),false);
  assert.equal(JSON.stringify(r.summary).includes('private-student-id'),false);
});
test('requires usable roster student IDs instead of guessing',async()=>{
  install({roster:[{userName:'Private Student'}]});const r=await zhixueProbe(selection);
  assert.equal(r.ok,false);assert.equal(r.summary.error,'roster_student_ids_missing_or_duplicated');
  assert.equal(calls.some(c=>c.url.pathname.includes('/checksheet/')),false);
});
test('does not read student pages when class identity differs',async()=>{
  install({classMismatch:true});const r=await zhixueProbe(selection);
  assert.equal(r.ok,false);assert.equal(r.summary.error,'class_mismatch');
});
test('a partial class score table cannot be reported as a complete roster',async()=>{
  install({totalCount:99});const r=await zhixueProbe(selection);
  assert.equal(r.ok,false);assert.equal(r.summary.error,'class_roster_incomplete');
});
test('changed or missing answer sheets cannot pass as zero mistakes',async()=>{
  install({brokenPaper:true});const r=await zhixueProbe(selection);
  assert.equal(r.ok,false);assert.equal(r.summary.question_records.exported_students,0);
  assert.equal(r.summary.question_records.failures[0].code,'missing_question_records');
});
test('invalid question scores cannot pass',async()=>{
  install({badScore:true});const r=await zhixueProbe(selection);
  assert.equal(r.ok,false);assert.equal(r.summary.question_records.failures[0].code,'invalid_question_fields');
});
test('network errors cannot serialize arbitrary exception text or token',async()=>{
  install({backendFail:true});const r=await zhixueProbe({action:'connect'});
  assert.equal(r.ok,false);assert.equal(r.summary.error,'request_failed');
  assert.equal(JSON.stringify(r).includes('PRIVATE_SESSION_TOKEN'),false);
});
test('single-class biology teacher connects using that class and subject instead of school-wide queries',async()=>{
  install();const r=await zhixueProbe({action:'connect'});
  assert.equal(r.ok,true);
  assert.equal(r.teachingClasses.length,1);
  assert.equal(r.teachingClasses[0].name,'三班');
  const query=calls.find(c=>c.url.pathname.includes('getClassReportList')).url.searchParams;
  assert.equal(query.get('classId'),'class1');
  assert.equal(query.get('subjectCode'),'bio');
  assert.equal(query.get('gradeCode'),'g3');
});
test('export uses a class single-subject table, without school-wide roster or class enumeration',async()=>{
  install();const r=await zhixueProbe(selection);
  assert.equal(r.ok,true);
  const request=calls.find(c=>c.url.pathname.includes('singleScoreList'));
  assert.equal(request.url.searchParams.get('classId'),'class1');
  assert.equal(request.url.searchParams.get('topicSetId'),'paper1');
  assert.equal(calls.some(c=>/getAllSubjectStudentRank|schoolClass/.test(c.url.pathname)),false);
});
test('export cannot target a class missing from the current teaching scope',async()=>{
  install();const r=await zhixueProbe({...selection,classId:'unassigned'});
  assert.equal(r.ok,false);assert.equal(r.summary.error,'class_outside_teaching_scope');
  assert.equal(calls.some(c=>c.url.pathname.includes('singleScoreList')),false);
});
test('subject-class pairs remain bound when one teacher has multiple assignments',async()=>{
  install({scopeClasses:[
    {classId:'class1',className:'三班',subjects:[{subjectCode:'bio',subjectName:'生物'}]},
    {classId:'class2',className:'四班',subjects:[{subjectCode:'math',subjectName:'数学'}]},
  ]});
  let r=await zhixueProbe({action:'classes',subjectCode:'bio'});
  assert.deepEqual(r.classes.map(row=>row.id),['class1']);
  r=await zhixueProbe({...selection,classId:'class2'});
  assert.equal(r.ok,false);assert.equal(r.summary.error,'subject_outside_teaching_scope');
});
test('does not silently fall back to school-wide data when teacher scope is empty',async()=>{
  install({scopeClasses:[]});const r=await zhixueProbe({action:'connect'});
  assert.equal(r.ok,false);assert.equal(r.summary.error,'no_teaching_scope');
  assert.equal(calls.some(c=>c.url.pathname.includes('getClassReportList')),false);
});
test('rejects roster rows for another subject',async()=>{
  install({rowSubject:'math'});const r=await zhixueProbe(selection);
  assert.equal(r.ok,false);assert.equal(r.summary.error,'subject_mismatch');
});
test('full class mode reads beyond the three-student sample and saves scores only',async()=>{
  const roster=Array.from({length:5},(_,i)=>({userId:`student-${i+1}`,classId:'class1',subjectCode:'bio',topicSetId:'paper1'}));
  install({roster});
  const runId='full-class-test';
  const r=await zhixueProbe({...selection,fullClass:true,runId});
  assert.equal(r.ok,true);assert.equal(r.summary.status,'passed_live_full_class_export');
  assert.equal(r.data.students.length,5);assert.equal(r.summary.question_records.question_count,10);
  assert.deepEqual(r.summary.result_counts,{correct:0,incorrect:5,partial_credit:5,not_scored:0});
  assert.equal(r.summary.question_alignment.status,'consistent_across_exported_class');
  for(const student of r.data.students) for(const question of student.questions) {
    assert.equal('student_answer' in question,false);
    assert.equal('subjective_answer_present' in question,false);
  }
  const progress=await zhixueProbe({action:'progress',runId});
  assert.deepEqual(progress,{total:5,processed:5,succeeded:5,unavailable:0,failed:0,status:'passed_live_full_class_export'});
  assert.equal(JSON.stringify(progress).includes('student-1'),false);
});
test('one changed paper is listed as failed while remaining students are processed',async()=>{
  install({roster:[{userId:'s1'},{userId:'s2'},{userId:'s3'},{userId:'s4'}],paperTransform:(data,n)=>{
    if(n===2)data.userAnswerRecordDTO.answerRecordDetails[0].topicNumber=9;
  }});
  const r=await zhixueProbe({...selection,fullClass:true});
  assert.equal(r.ok,false);assert.equal(r.summary.question_records.processed_students,4);
  assert.equal(r.data.students.length,3);
  assert.equal(r.summary.question_records.failures.length,1);
  assert.equal(r.summary.question_records.failures[0].sample_index,2);
  assert.equal(r.summary.question_records.failures[0].code,'question_number_or_full_score_mismatch');
  assert.equal(r.summary.question_alignment.status,'incomplete');
});
test('temporary request failure is retried once',async()=>{
  install({failPaperOnce:true});const r=await zhixueProbe({...selection,fullClass:true});
  assert.equal(r.ok,true);assert.equal(r.summary.question_records.retried_requests,1);
  assert.equal(calls.filter(call=>call.url.pathname.includes('/checksheet/')).length,2);
});
test('access denial stops further students and preserves successes',async()=>{
  install({roster:[{userId:'s1'},{userId:'s2'},{userId:'s3'},{userId:'s4'}],expireAt:2});
  const r=await zhixueProbe({...selection,fullClass:true});
  assert.equal(r.ok,false);assert.equal(r.data.students.length,1);
  assert.equal(r.summary.question_records.processed_students,2);
  assert.equal(r.summary.question_records.unprocessed_students,2);
  assert.equal(r.summary.question_records.failures[0].code,'http_403');
});
test('duplicate question numbers cannot pass the mapping check',async()=>{
  install({paperTransform:data=>{data.userAnswerRecordDTO.answerRecordDetails[1].topicNumber=3;}});
  const r=await zhixueProbe({...selection,fullClass:true});
  assert.equal(r.ok,false);assert.equal(r.summary.question_records.failures[0].code,'duplicate_question_numbers');
});
test('zero-full-score items are not asserted correct',async()=>{
  install({paperTransform:data=>{const q=data.userAnswerRecordDTO.answerRecordDetails[0];q.score=0;q.standardScore=0;}});
  const r=await zhixueProbe({...selection,fullClass:true});
  assert.equal(r.ok,true);assert.equal(r.data.students[0].questions[0].result,'not_scored');
});
test('an unreadable HTML sheet uses the authorized structured records endpoint',async()=>{
  install({brokenPaper:true,structuredPaper:{sheetDatas:JSON.stringify({userAnswerRecordDTO:{answerRecordDetails:[
    {topicNumber:1,score:1,standardScore:2,answerType:'s01Text',answer:'D'},
  ]}})}});
  const r=await zhixueProbe({...selection,fullClass:true});
  assert.equal(r.ok,true);assert.equal(r.summary.question_records.structured_fallback_requests,1);
  assert.equal(r.data.students[0].questions[0].result,'partial_credit');
  assert.equal('student_answer' in r.data.students[0].questions[0],false);
  const request=calls.find(c=>c.url.pathname.includes('getNewCheckSheet'));
  assert.equal(request.url.searchParams.get('topicSetId'),'paper1');
});
test('empty structured records remain an explicit failure instead of an absent or correct student',async()=>{
  install({brokenPaper:true,structuredPaper:{archiveStatus:2,sheetDatas:'{}'}});
  const r=await zhixueProbe({...selection,fullClass:true});
  assert.equal(r.ok,false);assert.equal(r.summary.question_records.exported_students,0);
  assert.equal(r.summary.question_records.failures[0].code,'missing_question_records');
});
test('the score-column label 没扫 skips paper requests and preserves a separate unscanned student',async()=>{
  install({roster:[{userId:'s1',score:55},{userId:'s2',score:'没扫'}]});
  const r=await zhixueProbe({...selection,fullClass:true});
  assert.equal(r.ok,true);assert.equal(r.summary.roster.student_count,2);
  assert.equal(r.summary.question_records.exported_students,1);
  assert.equal(r.summary.question_records.not_scanned_students,1);
  assert.equal(r.summary.question_records.accounted_students,2);
  assert.equal(r.summary.question_records.failures.length,0);
  assert.equal(r.data.unavailable_students[0].availability,'not_scanned');
  assert.equal(r.data.unavailable_students[0].reason_source,'roster_score_column');
  assert.deepEqual(r.data.unavailable_students[0].questions,[]);
  assert.equal(calls.filter(call=>call.url.pathname.includes('/checksheet/')).length,1);
});
test('zero total score never implies unscanned',async()=>{
  install({roster:[{userId:'s1',score:0}]});const r=await zhixueProbe({...selection,fullClass:true});
  assert.equal(r.ok,true);assert.equal(r.summary.question_records.not_scanned_students,0);
  assert.equal(calls.filter(call=>call.url.pathname.includes('/checksheet/')).length,1);
});
test('an entirely unscanned class produces no correct or incorrect question judgments',async()=>{
  install({roster:[{userId:'s1',score:'没扫'},{userId:'s2',score:'没扫'}]});
  const r=await zhixueProbe({...selection,fullClass:true});
  assert.equal(r.ok,true);assert.equal(r.summary.question_records.accounted_students,2);
  assert.equal(r.summary.question_alignment.status,'no_scanned_students');
  assert.deepEqual(r.summary.result_counts,{correct:0,incorrect:0,partial_credit:0,not_scored:0});
  assert.equal(calls.some(call=>call.url.pathname.includes('/checksheet/')),false);
});
test('hasOriginPaper false skips paper requests and keeps the student unjudged, as the official page does',async()=>{
  install({roster:[{userId:'s1',score:55,hasOriginPaper:true,rank:1},{userId:'s2',score:12,hasOriginPaper:false,rank:-1}]});
  const r=await zhixueProbe({...selection,fullClass:true});
  assert.equal(r.ok,true);assert.equal(r.summary.question_records.exported_students,1);
  assert.equal(r.summary.question_records.no_original_paper_students,1);
  assert.equal(r.summary.question_records.not_scanned_students,0);
  assert.equal(r.summary.question_records.failures.length,0);
  const missing=r.data.unavailable_students[0];
  assert.equal(missing.availability,'no_original_paper');assert.equal(missing.reason_source,'roster_has_origin_paper');
  assert.equal(missing.roster_score,12);assert.equal(missing.rank_code,-1);assert.deepEqual(missing.questions,[]);
  assert.equal(calls.filter(call=>call.url.pathname.includes('/checksheet/')).length,1);
  assert.equal(calls.some(call=>call.url.pathname.includes('getNewCheckSheet')),false);
});
test('without hasOriginPaper only rank codes -2 and -3 mean no original paper',async()=>{
  install({roster:[{userId:'s1',score:40,rank:-1},{userId:'s2',score:0,rank:-2},{userId:'s3',score:0,rank:-3}]});
  const r=await zhixueProbe({...selection,fullClass:true});
  assert.equal(r.ok,true);assert.equal(r.summary.question_records.exported_students,1);
  assert.deepEqual(r.data.unavailable_students.map(row=>[row.reason_source,row.rank_code]),[['roster_rank_code',-2],['roster_rank_code',-3]]);
  assert.equal(calls.filter(call=>call.url.pathname.includes('/checksheet/')).length,1);
});
test('an explicit hasOriginPaper true is still read even with a negative rank',async()=>{
  install({roster:[{userId:'s1',score:30,hasOriginPaper:true,rank:-2}]});
  const r=await zhixueProbe({...selection,fullClass:true});
  assert.equal(r.ok,true);assert.equal(r.summary.question_records.exported_students,1);
  assert.equal(r.data.unavailable_students.length,0);
});
