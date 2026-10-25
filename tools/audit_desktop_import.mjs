// Read real files in place. Persist only anonymous aggregate evidence, never student rows.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { auditExport, parseExportText, workspaceFromExport, validateWorkspace, analyze } from '../app/packages/core/src/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.join(os.homedir(), 'Downloads', 'zhixue-auto-export');
try {
  const files = await fs.readdir(folder);
  const candidates = await Promise.all(files.filter(n=>/^student-class.*\.json$/.test(n)).map(async name=>({name,mtime:(await fs.stat(path.join(folder,name))).mtimeMs})));
  candidates.sort((a,b)=>b.mtime-a.mtime);
  if(!candidates.length)throw Error('full_class_download_not_found');
  const raw = await fs.readFile(path.join(folder,candidates[0].name),'utf8'), data = parseExportText(raw);
  let verification;
  for(const name of files.filter(n=>/^verification-full.*\.json$/.test(n))) {
    const v=parseExportText(await fs.readFile(path.join(folder,name),'utf8'));
    if(v.summary?.finished_at===data.summary?.finished_at){verification=v;break;}
  }
  if(!verification)throw Error('matching_verification_not_found');
  const {audit} = auditExport(data,verification);
  const workspace=validateWorkspace(workspaceFromExport(data,'chrome_extension',{},verification));
  const analysis=analyze(workspace);
  const previous=JSON.parse(await fs.readFile(path.join(root,'output/full-class-verification-audit.json'),'utf8'));
  const hash=crypto.createHash('sha256').update(raw.replace(/^\uFEFF/,''),'utf8').digest('hex');
  const parity = previous.data_file_sha256===hash && previous.roster_student_count===audit.rosterCount
    && previous.total_question_records===audit.questionRecords
    && Object.keys(audit.resultCounts).every(k=>previous.result_counts[k]===audit.resultCounts[k]);
  if(!parity)throw Error('python_baseline_mismatch');
  const report={checked_at:new Date().toISOString(),source:'existing_chrome_extension_export',
    typescript_import_verified:true,python_baseline_matches:true,data_file_sha256:hash,
    roster_student_count:audit.rosterCount,exported_student_count:audit.exportedCount,
    not_scanned_student_count:audit.notScannedCount,no_original_paper_student_count:audit.noPaperCount,
    total_question_records:audit.questionRecords,result_counts:audit.resultCounts,
    analyzed_question_count:analysis.questions.length,raw_data_copied_into_project:false};
  await fs.writeFile(path.join(root,'output/desktop-import-verification-audit.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} catch(error) {
  console.error(JSON.stringify({verified:false,reason:/^[a-z_]+$/.test(error.message)?error.message:'audit_failed'}));
  process.exitCode=1;
}
