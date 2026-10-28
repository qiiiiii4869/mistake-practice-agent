import { analyze, validateWorkspace, type Workspace } from '../../../core/src/index.ts';
import { WORKFLOW_VERSION, PROMPT_VERSION, type ContentSettings, type ExportProfile, type FrozenInput, type WorkflowMode } from './types.ts';

function canonical(value:unknown):string {
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  const obj=value as Record<string,unknown>;
  return `{${Object.keys(obj).sort().map(key=>`${JSON.stringify(key)}:${canonical(obj[key])}`).join(',')}}`;
}
async function hash(value:unknown):Promise<string>{
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
}
function deepFreeze<T>(value:T):T{
  if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;
}
export async function freezeInput(workspace:Workspace,ownerId:string,mode:WorkflowMode,knowledgeRevision:number,settings:ContentSettings):Promise<FrozenInput>{
  if(!ownerId.trim()||ownerId.length>100||!['dictation','exercise'].includes(mode)||!Number.isSafeInteger(knowledgeRevision)||knowledgeRevision<0)throw new Error('workflow_invalid_input');
  if(Object.keys(settings).some(k=>!['difficulty','includePartialCredit','partialCreditThreshold','maxBlanks','maxExercises','minCoverage'].includes(k))||!['basic','same','advanced'].includes(settings.difficulty)||typeof settings.includePartialCredit!=='boolean'
    ||!Number.isFinite(settings.partialCreditThreshold)||settings.partialCreditThreshold<0||settings.partialCreditThreshold>100
    ||!Number.isSafeInteger(settings.maxBlanks)||settings.maxBlanks<1||settings.maxBlanks>24
    ||!Number.isSafeInteger(settings.maxExercises)||settings.maxExercises<1||settings.maxExercises>10
    ||!Number.isFinite(settings.minCoverage)||settings.minCoverage<=0||settings.minCoverage>1)throw new Error('workflow_invalid_settings');
  const checked=validateWorkspace(workspace);
  if(checked.students.length>100)throw new Error('workflow_student_limit');
  // Use the selected settings to freeze loss targets, including true zero scores.
  const analysis=analyze({...checked,settings:{...checked.settings,...settings}});
  if(analysis.audit.questionNumbers.length>80)throw new Error('workflow_unit_limit');
  const value={schemaVersion:2 as const,ownerId,examIdentity:checked.exam,students:checked.students,
    paperFiles:checked.paper?.pages??[],mode,contentSettings:settings,knowledgeRevision,
    workflowVersion:WORKFLOW_VERSION,promptVersion:PROMPT_VERSION,
    rawWeakQuestions:analysis.students.map(s=>({localStudentId:s.id,numbers:s.weakQuestions,availability:s.availability as FrozenInput['rawWeakQuestions'][number]['availability']}))};
  const copy=structuredClone(value);
  return deepFreeze({...copy,contentHash:await hash(copy)});
}
export async function createExportProfile(input:FrozenInput,profile:Omit<ExportProfile,'schemaVersion'|'contentHash'|'exportHash'>):Promise<ExportProfile>{
  if(!profile.runId.trim()||!['individual','combined'].includes(profile.layout)||typeof profile.includeAnswers!=='boolean'
    ||profile.printSettings.paper!=='a4'||!profile.printSettings.font.trim()||!Number.isFinite(profile.printSettings.fontSize)
    ||profile.printSettings.fontSize<8||profile.printSettings.fontSize>30||!profile.templateVersion.trim())throw new Error('workflow_invalid_export');
  if(Object.keys(profile).some(k=>!['runId','layout','includeAnswers','printSettings','templateVersion'].includes(k))||Object.keys(profile.printSettings).some(k=>!['paper','font','fontSize'].includes(k)))throw new Error('workflow_invalid_export');
  const copy=structuredClone({schemaVersion:2 as const,...profile,contentHash:input.contentHash});
  return deepFreeze({...copy,exportHash:await hash(copy)});
}
