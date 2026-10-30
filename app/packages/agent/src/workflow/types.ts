import type { Workspace } from '../../../core/src/index.ts';

export const WORKFLOW_VERSION = 'report-workflow-v1';
export const PROMPT_VERSION = 'report-prompts-v12';
export type GenerationMode = 'dictation' | 'exercise';
export type ExecutionMode = 'mock' | 'real';
export type WorkflowState = 'idle' | 'preflight' | 'authorizing' | 'rendering' | 'recognizing' | 'aligning'
  | 'extracting' | 'retrieving' | 'verifyingFacts' | 'merging' | 'selectingTargets' | 'clozing'
  | 'validatingCloze' | 'generatingExercises' | 'solving' | 'validatingExercise' | 'assembling'
  | 'aggregatingEvidence' | 'writingGuidance' | 'validatingGuidance' | 'contentReady' | 'partial'
  | 'failed' | 'cancelled' | 'recoverable';
export type ModelStage = 'recognize' | 'extract' | 'verifyFact' | 'cloze' | 'blindFill' | 'exercise' | 'solve' | 'guidance';
export interface ContentSettings {
  maxItems: number; difficulty: 'basic' | 'same' | 'advanced'; coverageThreshold: number;
}
export interface FrozenInput {
  schemaVersion: 1; ownerId: string; workspace: Workspace; mode: GenerationMode;
  settings: ContentSettings; knowledgeRevision: string; workflowVersion: string; promptVersion: string; contentHash: string;
  testScope?: { questionNumbers: string[] };
  recognitionPolicy?:{keepFirstNumbers:string[]};
}
export interface ExportProfile {
  exportId: string; runId: string; layout: 'individual' | 'combined'; includeAnswers: boolean;
  templateVersion: string; printSettings: { duplex: boolean }; exportHash: string;
}
export interface SourceUnit {
  unitId: string; sourceNumbers: string[]; pageIds: string[]; stem: string; material: string;
  options: string[]; availability: 'usable' | 'isolated'; alignmentStatus: 'recognized_by_machine' | 'ambiguous';
}
export type RecognitionReason='matched'|'format_only'|'content_mismatch'|'low_confidence'|'duplicate_number'|'warning'|'missing'|'invalid_structure';
export interface RecognitionCheck{
  sourceNumbers:string[];pageIndex:number;status:'usable'|'isolated'|'missing';reason:RecognitionReason;
  readings:{attempt:number;matches:number;confidence:'high'|'low'|'missing';warningCount:number;valid:boolean}[];
}
export interface EvidenceRef { documentId: string; page: number; text: string }
export interface FactCandidate {
  knowledgePoint: string; completeStatement: string; conditions: string[]; candidateAnswers: string[];
  context?:string;
}
export interface KnowledgeFact extends FactCandidate {
  factId: string; sourceNumbers: string[]; unitIds: string[]; evidenceRefs: EvidenceRef[];
  sourceMode: 'paper' | 'library'; factCheck: { accurate: boolean; supported: boolean; inScope: boolean };
}
export type ClozePart = { type: 'text'; text: string }
  | { type: 'blank'; blankId: string; answer: string; acceptedAnswers: string[] };
export interface ItemChecks { structure: boolean; independent: boolean; scope: boolean }
export type ValidationReason = 'invalid_structure' | 'unsupported_formula' | 'duplicate_blank_id' | 'answer_not_accepted'
  | 'answer_not_candidate' | 'non_specific_blank' | 'condition_removed' | 'statement_not_restored' | 'invalid_blank_count' | 'insufficient_context'
  | 'answer_visible' | 'blind_fill_ambiguous' | 'blind_fill_missing_conditions' | 'blind_fill_mapping' | 'blind_fill_answer_mismatch'
  | 'unsupported_exercise_type' | 'invalid_options' | 'missing_diagram' | 'original_copied' | 'invalid_duration'
  | 'invalid_numeric_answer' | 'solve_incomplete' | 'solve_out_of_scope' | 'solve_too_similar' | 'solve_answer_mismatch'
  | 'solve_scoring_mismatch' | 'solve_numeric_mismatch'|'repair_not_applied'|'fact_inaccurate'|'fact_unsupported'|'fact_context_incomplete';
export interface ValidationAttempt { factId:string;sourceNumbers:string[];stage:'verifyFact'|'cloze'|'blindFill'|'exercise'|'solve';attempt:number;reason:ValidationReason }
export interface ClozeItem {
  itemId: string; mode: 'dictation'; factId: string; sourceNumbers: string[]; parts: ClozePart[];
  correction: string; checks: ItemChecks; status: 'passed' | 'failed'; attempts: number;
  authoring?:'model'|'deterministic';
  context?:string;
}
export interface ExerciseItem {
  itemId: string; mode: 'exercise'; factId: string; sourceNumbers: string[];
  type: 'single_choice' | 'multiple_choice' | 'short_answer' | 'calculation'; stem: string;
  options: { id: string; text: string }[]; material: string; answer: string[]; rubric: string[];
  explanation: string; estimatedMinutes: number; checks: ItemChecks; status: 'passed' | 'failed'; attempts: number;
  numericAnswer?: { value: number; unit: string };
}
export type ContentItem = ClozeItem | ExerciseItem;
export interface StudentTargets {
  localStudentId: string; rawWeakNumbers: string[]; selectedTargets: string[]; excludedTargets: string[];
  outOfScopeNumbers?: string[];
}
export interface StudentAssignment extends StudentTargets {
  itemIds: string[]; uncoveredTargets: string[]; uncoveredNumbers: string[]; coverage: number;
  status: 'ready' | 'partial' | 'no_targets' | 'unavailable';
}
export interface QuestionPerformance {
  questionNumber:string;participantCount:number;correctCount:number;partialCount:number;incorrectCount:number;
  correctRate:number|null;earnedScore:number;possibleScore:number;scoreRate:number|null;knowledgePointIds:string[];
}
export interface KnowledgeEvidence {
  evidenceId: string; knowledgePointId: string; knowledgePoint: string; questionNumbers: string[];
  earnedScore: number; possibleScore: number; participantCount: number; lossCount: number;
  scoreRate: number | null; lossRate: number | null; limitations: string[];
  questionStats:QuestionPerformance[];
}
export interface EvidenceSummary {
  rows: KnowledgeEvidence[]; questions:QuestionPerformance[];mappedQuestions: number; totalQuestions: number;
  mappedFullScore: number; totalFullScore: number; unmappedNumbers: string[];
  classOverview:ClassOverview;
}
export interface ScoreBand{
  bandId:string;minRate:number;maxRate:number;includeMax:boolean;studentCount:number;meanScoreRate:number|null;
  questionStats:{questionNumber:string;correctCount:number;participantCount:number;correctRate:number|null}[];
}
export interface ClassOverview{
  rosterCount:number;scoredCount:number;notScannedCount:number;noOriginalPaperCount:number;notScorableCount:number;
  fullScore:number;meanScore:number|null;medianScore:number|null;minScore:number|null;maxScore:number|null;standardDeviation:number|null;
  scoreBands:ScoreBand[];
}
export interface TeachingAdvice {
  adviceId: string; evidenceIds: string[]; priority: number; focus: string;
  classroomAction: string; followUp: string; limitations: string[];
  validationStatus: 'passed'; generatedBy: 'model' | 'template';
}
export interface ClassTeachingReport{
  overview:string;priorities:TeachingAdvice[];groupActions:{bandId:string;action:string}[];followUp:string;
  generatedBy:'model'|'template';mappingStatus:'complete'|'partial';limitations:string[];
}
export interface BudgetPolicy {
  maxCalls: number; maxTokens: number; maxOutputTokens: number; maxInputBytes: number;
  maxRunMs: number; requestTimeoutMs: number; maxNetworkRetries: number;
}
export interface CallRecord {
  callId: string; stage: ModelStage; requestHash: string; attempt: number;
  scopeId: string;
  status: 'pending' | 'completed' | 'unknown'; reservedTokens: number; usage: number | null;
  startedAt: number; finishedAt?: number;
  errorCode?:string;
}
export type CheckpointData=Pick<WorkflowRun,'units'|'facts'|'items'|'draftFacts'|'unitEvidence'|'targets'|'assignments'|'evidence'|'advice'|'teacherReport'|'skipped'|'validationAttempts'|'recognitionChecks'>;
export interface WorkflowCloudBinding {jobId:string;requestKey:string;leaseUntil:number;expiresAt:number;status:'active'|'suspended'|'ended'}
export interface WorkflowTaskContext {workspaceRevision?:number}
export interface WorkflowRun {
  runId: string; contentHash: string; mode: GenerationMode; executionMode: ExecutionMode;
  workflowVersion: string; promptVersion: string; state: WorkflowState;
  modelConfiguration: string; analysisCacheHit?: boolean;
  startedAt: number; policy: BudgetPolicy; calls: CallRecord[]; machineSnapshot: unknown;
  units: SourceUnit[]; facts: KnowledgeFact[]; items: ContentItem[];
  draftFacts: Record<string, FactCandidate[]>; unitEvidence: Record<string, EvidenceRef[]>;
  targets: StudentTargets[]; assignments: StudentAssignment[]; evidence: EvidenceSummary;
  advice: TeachingAdvice[]; skipped: { sourceNumbers: string[]; reason: string }[];
  teacherReport:ClassTeachingReport|null;
  checkpoints: string[]; errorCode?: string;errorStage?:WorkflowState;
  analysisBatches?:string[][];verificationBatches?:string[][];
  validationAttempts: ValidationAttempt[];
  recognitionChecks:RecognitionCheck[];
  frame?:{id:string;callStart:number;data:CheckpointData};
  cloud?:WorkflowCloudBinding;
}
export interface ModelRequest { stage: ModelStage; instruction: string; data: Record<string, unknown> }
export type InvokeModel = (stage: ModelStage, data: Record<string, unknown>) => Promise<unknown>;
export interface ModelResponse { value: unknown; usage?: { totalTokens: number } }
export interface WorkflowModel {
  executionMode: ExecutionMode;
  // Explicit provider/model configuration version; absence disables shared analysis caching.
  cacheKey?: string;
  call(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}
export interface WorkflowStore {
  durable?:boolean;
  beginRun?(input:FrozenInput,runId:string,context:WorkflowTaskContext,onLeaseLost:()=>void):Promise<void>;
  endRun?(ownerId:string,runId:string):Promise<void>;
  completeCall?(ownerId:string,run:WorkflowRun,callId:string,response:ModelResponse):Promise<void>;
  loadResponse?(ownerId:string,runId:string,callId:string):Promise<ModelResponse|null>;
  save(ownerId: string, run: WorkflowRun): Promise<void>;
  load(ownerId: string, runId: string): Promise<WorkflowRun | null>;
  loadAnalysis(ownerId: string, cacheKey: string): Promise<AnalysisCache | null>;
  saveAnalysis(ownerId: string, cacheKey: string, value: AnalysisCache): Promise<void>;
}
export interface AnalysisCache {
  units: SourceUnit[]; facts: KnowledgeFact[]; draftFacts: Record<string,FactCandidate[]>;
  unitEvidence: Record<string,EvidenceRef[]>;
}
export interface WorkflowPorts {
  model: WorkflowModel; store: WorkflowStore;
  authorize?(input: FrozenInput, policy: BudgetPolicy, signal: AbortSignal): Promise<WorkflowCloudBinding|void>;
  release?(outcome: 'partial' | 'failed' | 'cancelled',run?:WorkflowRun): Promise<'suspended'|'ended'|void>;
  persistDiagnostics?(run:WorkflowRun):Promise<void>;
  prepareUnits(input: FrozenInput, signal: AbortSignal, invoke?: InvokeModel,report?:(check:RecognitionCheck)=>void): Promise<SourceUnit[]>;
  retrieve(query: string, signal: AbortSignal): Promise<EvidenceRef[]>;
  retrieveForOriginal?(unit: SourceUnit, signal: AbortSignal): Promise<EvidenceRef[]>;
  now?: () => number; onProgress?: (state: WorkflowState) => void;
}
export interface ExportManifest {
  runId: string; contentHash: string; exportHash: string; mode: GenerationMode;
  layout: ExportProfile['layout']; outputs: { role: 'student' | 'teacher'; ownerId: string | null;
    relativePath: string; size: number; sha256: string; pages: number }[];
  exportStatus: 'staging' | 'verified'; qaReport: string;
}
