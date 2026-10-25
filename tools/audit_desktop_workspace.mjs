// Read only the application database in place. Output contains no student identifiers or names.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, validateWorkspace } from '../app/packages/core/src/index.ts';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try {
  if(!process.env.LOCALAPPDATA)throw Error('local_app_data_not_found');
  const folder=path.join(process.env.LOCALAPPDATA,'com.local.mistake-agent');
  const db=new DatabaseSync(path.join(folder,'workspace.sqlite'),{readOnly:true});
  let row;
  try {row=db.prepare('SELECT revision, payload FROM active_workspace WHERE id=1').get();}finally{db.close();}
  if(!row?.payload)throw Error('no_saved_workspace');
  const workspace=validateWorkspace(JSON.parse(row.payload));
  const {audit,questions}=analyze(workspace);
  const native=JSON.parse(await fs.readFile(path.join(folder,'diagnostics','desktop-class-verification.json'),'utf8'));
  const baseline=JSON.parse(await fs.readFile(path.join(root,'output','full-class-verification-audit.json'),'utf8'));
  if(workspace.source.kind!=='zhixue_webview'||native.live_full_class_scores_verified!==true)throw Error('not_a_live_desktop_read');
  const agrees=baseline.roster_student_count===audit.rosterCount && baseline.exported_student_count===audit.exportedCount
    && baseline.total_question_records===audit.questionRecords && baseline.no_original_paper_student_count===audit.noPaperCount
    && baseline.not_scanned_student_count===audit.notScannedCount
    && Object.keys(audit.resultCounts).every(k=>baseline.result_counts[k]===audit.resultCounts[k])
    && JSON.stringify(baseline.question_numbers)===JSON.stringify(audit.questionNumbers)
    && native.total_question_records===audit.questionRecords && native.roster_student_count===audit.rosterCount;
  if(!agrees)throw Error('baseline_or_storage_mismatch');
  const report={checked_at:new Date().toISOString(),source_finished_at:workspace.source.finishedAt,
    live_desktop_full_class_verified:true,sqlite_restore_revalidated:true,python_baseline_matches:true,
    roster_student_count:audit.rosterCount,exported_student_count:audit.exportedCount,
    not_scanned_student_count:audit.notScannedCount,no_original_paper_student_count:audit.noPaperCount,
    total_question_records:audit.questionRecords,result_counts:audit.resultCounts,
    analyzed_question_count:questions.length,single_active_exam:true,raw_data_copied_into_project:false};
  await fs.writeFile(path.join(root,'output','desktop-full-class-verification-audit.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} catch(error) {
  console.error(JSON.stringify({verified:false,reason:/^[a-z_]+$/.test(error.message)?error.message:'audit_failed'}));
  process.exitCode=1;
}
