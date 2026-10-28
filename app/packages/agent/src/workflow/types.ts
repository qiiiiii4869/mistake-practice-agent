import type { ExamIdentity, Student, TeacherSettings } from '../../../core/src/index.ts';
import type { PaperPage } from '../../../paper/src/index.ts';

export const WORKFLOW_VERSION = '2.0.0-foundation';
export const PROMPT_VERSION = '2.0.0-draft';
export type WorkflowMode = 'dictation' | 'exercise';
export type ExportLayout = 'individual' | 'combined';
export interface ContentSettings {
  difficulty: TeacherSettings['difficulty']; includePartialCredit: boolean; partialCreditThreshold: number;
  maxBlanks: number; maxExercises: number; minCoverage: number;
}
// All identity-bearing fields remain local. Model requests must use separate DTOs.
export interface FrozenInput {
  schemaVersion: 2; ownerId: string; examIdentity: ExamIdentity; students: Student[];
  paperFiles: PaperPage[]; mode: WorkflowMode; contentSettings: ContentSettings;
  knowledgeRevision: number; workflowVersion: string; promptVersion: string; contentHash: string;
  rawWeakQuestions: {localStudentId: string; numbers: string[]; availability: Student['availability']}[];
}
export interface ExportProfile {
  schemaVersion: 2; runId: string; contentHash: string; layout: ExportLayout; includeAnswers: boolean;
  printSettings: {paper: 'a4'; font: string; fontSize: number}; templateVersion: string; exportHash: string;
}
export interface WorkflowRun {
  schemaVersion:2;runId:string;cloudJobId:string|null;requestKey:string;ownerId:string;mode:WorkflowMode;
  workflowVersion:string;promptVersion:string;contentHash:string;exportHash:string;state:string;
  policy:{maxCalls:number;maxTokens:number;deadline:number};counts:{calls:number;reservedTokens:number;knownTokens:number};
  createdAt:number;updatedAt:number;
}
export interface SourceUnit {
  unitId:string;sourceNumbers:string[];pageIds:string[];material:string;stem:string;options:string[];
  recognitionChecks:{readHashes:string[];alignmentStatus:'pending'|'aligned'|'isolated'};
  availability:'recognized_by_machine'|'incomplete'|'unsupported';
}
export interface CallRecord {
  callId:string;stage:string;unitIds:string[];requestHash:string;attempt:number;
  status:'reserved'|'sent'|'succeeded'|'failed'|'interrupted'|'unknown';reservedBudget:number;
  usage:{inputTokens:number;outputTokens:number}|null;startedAt:number;finishedAt:number|null;errorCode:string|null;
}
export interface KnowledgeFact {
  factId: string; sourceNumbers: string[]; knowledgePoint: string; completeStatement: string;
  conditions: string[]; evidenceRefs: string[]; sourceMode: 'library' | 'paper';
  factCheck: 'pending' | 'verified' | 'isolated';
}
export type ClozePart = {type:'text';text:string} | {type:'blank';blankId:string;answer:string;acceptedAnswers:string[]};
export interface ClozeItem {
  itemId:string;factId:string;sourceNumbers:string[];parts:ClozePart[];correction:string;
  checks:{structure:boolean;reconstruction:boolean;blindFill:boolean};status:'pending'|'verified'|'isolated';attempts:number;
}
export interface ExerciseItem {
  itemId:string;type:'single_choice'|'multiple_choice'|'short_answer'|'calculation';targetIds:string[];
  sourceNumbers:string[];stem:string;options:string[];materialRefs:string[];answer:string;
  rubric:string[];explanation:string;solveResult:{answer:string;explanation:string}|null;
  estimatedMinutes:number;questionCount:number;
  checks:{structure:boolean;scope:boolean;independentSolve:boolean;conditions:boolean;originality:boolean};
  status:'pending'|'verified'|'isolated';attempts:number;
}
export interface StudentAssignment {
  localStudentId:string;selectedTargets:string[];itemIds:string[];uncoveredTargets:string[];
  uncoveredSourceNumbers:string[];status:'complete'|'partial'|'no_targets'|'unavailable';
}
export interface KnowledgeEvidence {
  evidenceId:string;knowledgePointId:string;questionIds:string[];earnedScore:number;possibleScore:number;
  participantCount:number;lossCount:number;mappingStatus:'machine'|'unmapped';limitations:string[];
}
export interface TeachingAdvice {
  adviceId:string;evidenceIds:string[];priority:number;focus:string;classroomAction:string;followUp:string;
  limitations:string[];validationStatus:'pending'|'verified'|'fallback';
}
export interface ExportManifest {
  runId:string;contentHash:string;exportHash:string;mode:WorkflowMode;layout:ExportLayout;
  outputs:{role:'student'|'teacher';ownerId:string|null;relativePath:string;size:number;sha256:string;pages:number}[];
  coverage:number;qaReport:string;exportStatus:'pending'|'verified'|'failed';resultStatus:'complete'|'partial'|'failed';
}
