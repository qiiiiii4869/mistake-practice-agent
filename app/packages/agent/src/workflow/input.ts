import { analyze, validateWorkspace, type Workspace } from '../../../core/src/index.ts';
import { PROMPT_VERSION, WORKFLOW_VERSION, type ContentSettings, type ExportProfile, type FrozenInput, type GenerationMode } from './types.ts';
import {assertPaperExamMatch} from '../../../paper/src/examMatch.ts';
import {BIOLOGY_AUTHORING_VERSION} from '../../../knowledge/src/biologyAuthoring.ts';
import {isBiology} from '../../../knowledge/src/biology.ts';
import {KNOWLEDGE_RETRIEVAL_VERSION} from '../../../knowledge/src/index.ts';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined)
    .sort(([a],[b]) => a.localeCompare(b, 'en')).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2,'0')).join('');
}
export async function freezeInput(options: {
  ownerId: string; workspace: Workspace; mode: GenerationMode; knowledgeRevision?: string; settings?: Partial<ContentSettings>;
  testScope?: { questionNumbers: string[] };
  validationLevel?:'minimum';
  recognitionPolicy?:{keepFirstNumbers:string[]};
}): Promise<FrozenInput> {
  if (!/^[\w-]{1,100}$/.test(options.ownerId) || !['dictation','exercise'].includes(options.mode)) throw new Error('workflow_invalid_input');
  const workspace = validateWorkspace(structuredClone(options.workspace));
  delete workspace.practice;
  const settings: ContentSettings = { maxItems: options.mode === 'dictation' ? 16 : 5,
    difficulty: workspace.settings.difficulty, coverageThreshold: 0.8, ...options.settings };
  if (!Number.isInteger(settings.maxItems) || settings.maxItems < 1 || settings.maxItems > (options.mode === 'dictation' ? 24 : 10)
    || !['basic','same','advanced'].includes(settings.difficulty)
    || !Number.isFinite(settings.coverageThreshold) || settings.coverageThreshold <= 0 || settings.coverageThreshold > 1)
    throw new Error('workflow_invalid_settings');
  let testScope: FrozenInput['testScope'];
  if(options.testScope){const numbers=options.testScope.questionNumbers,all=analyze(workspace).audit.questionNumbers;
    if(!Array.isArray(numbers)||!numbers.length||numbers.length>6||new Set(numbers).size!==numbers.length||numbers.some(n=>!all.includes(n)))throw new Error('workflow_invalid_scope');
    testScope={questionNumbers:[...numbers]};}
  if(options.validationLevel!==undefined&&options.validationLevel!=='minimum')throw new Error('workflow_invalid_settings');
  const input = { schemaVersion: 1 as const, ownerId: options.ownerId, workspace, mode: options.mode,
    segmentationVersion:'printed-headings-v1' as const,
    assignmentVersion:'personal-coverage-v1' as const,
    retrievalVersion:KNOWLEDGE_RETRIEVAL_VERSION,
    ...(isBiology(workspace.exam.subjectName)?{authoringVersion:BIOLOGY_AUTHORING_VERSION}:{}),
    ...(options.validationLevel?{validationLevel:options.validationLevel}:{}),
    ...(testScope?{testScope}:{}),
    ...(options.recognitionPolicy?{recognitionPolicy:structuredClone(options.recognitionPolicy)}:{}),
    settings, knowledgeRevision: options.knowledgeRevision ?? 'empty', workflowVersion: WORKFLOW_VERSION, promptVersion: PROMPT_VERSION };
  if(input.recognitionPolicy){const values=input.recognitionPolicy.keepFirstNumbers,all=testScope?.questionNumbers??analyze(workspace).audit.questionNumbers;
    if(!Array.isArray(values)||new Set(values).size!==values.length||values.some(n=>!all.includes(n)))throw new Error('workflow_invalid_scope');}
  return { ...input, contentHash: await digest(input) };
}
export async function assertFrozen(input: FrozenInput): Promise<void> {
  const { contentHash, ...body } = input;
  if (body.workflowVersion !== WORKFLOW_VERSION || body.promptVersion !== PROMPT_VERSION || await digest(body) !== contentHash)
    throw new Error('workflow_stale_input');
  validateWorkspace(body.workspace);
  if(body.segmentationVersion!==undefined&&body.segmentationVersion!=='printed-headings-v1')throw new Error('workflow_invalid_settings');
  if(body.assignmentVersion!==undefined&&body.assignmentVersion!=='personal-coverage-v1')throw new Error('workflow_invalid_settings');
  if(body.retrievalVersion!==undefined&&body.retrievalVersion!==KNOWLEDGE_RETRIEVAL_VERSION)throw new Error('workflow_invalid_settings');
  if(body.authoringVersion!==undefined&&(!isBiology(body.workspace.exam.subjectName)||body.authoringVersion!==BIOLOGY_AUTHORING_VERSION))throw new Error('workflow_invalid_settings');
  if(body.validationLevel!==undefined&&body.validationLevel!=='minimum')throw new Error('workflow_invalid_settings');
}
export async function exportProfile(input: FrozenInput, runId: string, layout: ExportProfile['layout'], includeAnswers = true): Promise<ExportProfile> {
  if (!['individual','combined'].includes(layout)) throw new Error('workflow_invalid_export');
  const body = { runId, layout, includeAnswers, templateVersion: 'report-template-v1', printSettings: { duplex: false } };
  return { ...body, exportId: crypto.randomUUID(), exportHash: await digest({ contentHash: input.contentHash, ...body }) };
}
export function preflight(input: FrozenInput): { units: number; pages: number; hasTargets: boolean } {
  const { audit, students } = analyze(input.workspace);
  const pages = input.workspace.paper?.pages.length ?? 0;
  if (input.workspace.students.length > 100 || audit.questionNumbers.length > 80 || pages > 30) throw new Error('workflow_input_limit');
  const hasTargets = students.some(s => s.weakQuestions.some(n=>!input.testScope||input.testScope.questionNumbers.includes(n)));
  if (hasTargets && !pages) throw new Error('paper_required');
  if(hasTargets)assertPaperExamMatch(input.workspace);
  return { units: input.testScope?.questionNumbers.length??audit.questionNumbers.length, pages, hasTargets };
}
