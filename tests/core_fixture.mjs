export function fixture() {
  const questions = [{question_number:1,score:2,full_score:2,result:'correct',lost_points:false},
    {question_number:2,score:1,full_score:3,result:'partial_credit',lost_points:true}];
  return {ok:true,summary:{status:'passed_live_full_class_export',export_scope:'full_class_scores_only',
    authentication:'verified_teacher_session',finished_at:'SYNTHETIC_TEST_TIME',roster:{student_count:2},
    question_records:{exported_students:2,question_count:4,failures:[],unprocessed_students:0},
    result_counts:{correct:2,incorrect:0,partial_credit:2,not_scored:0}},
    data:{exam_id:'synthetic-exam',subject_id:'synthetic-paper',class_id:'synthetic-class',students:[
      {student_id:'SYNTHETIC_1',student_name:'模拟学生甲',questions:structuredClone(questions)},
      {student_id:'SYNTHETIC_2',student_name:'模拟学生乙',questions:structuredClone(questions)}],unavailable_students:[]}};
}
export function addUnavailable(data, availability='not_scanned') {
  data.data.unavailable_students.push({student_id:'SYNTHETIC_3',student_name:'模拟学生丙',availability,
    reason_source:availability === 'not_scanned' ? 'roster_score_column' : 'roster_has_origin_paper',
    roster_score:12,rank_code:-1,questions:[]});
  data.summary.roster.student_count++;
  data.summary.question_records[availability === 'not_scanned' ? 'not_scanned_students' : 'no_original_paper_students'] = 1;
}
