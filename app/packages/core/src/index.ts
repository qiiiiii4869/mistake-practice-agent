import { validateBatch } from '../../agent/src/storage.ts';
import type { AgentBatch } from '../../agent/src/index.ts';
import { validatePaper, type Paper } from '../../paper/src/index.ts';
export type { Paper } from '../../paper/src/index.ts';
export type ResultLabel = 'correct' | 'incorrect' | 'partial_credit' | 'not_scored';
export type Availability = 'scored' | 'not_scanned' | 'no_original_paper';
export interface QuestionResult {
  number: string;
  label: string;
  score: number;
  fullScore: number;
  result: ResultLabel;
}
export interface Student {
  id: string;
  name: string;
  availability: Availability;
  reasonSource: string | null;
  rosterScore: number | null;
  rankCode: number | null;
  classRank?: number | null;
  gradeRank?: number | null;
  questions: QuestionResult[];
}
export interface ExamIdentity {
  id: string; name: string;
  subjectId: string; subjectName: string;
  classId: string; className: string;
}
export interface TeacherSettings {
  variantsPerQuestion: number;
  maxQuestionsPerStudent: number;
  includePartialCredit: boolean;
  partialCreditThreshold: number;
  difficulty: 'basic' | 'same' | 'advanced';
}
export interface Workspace {
  schemaVersion: 1;
  source: { kind: 'zhixue_webview' | 'chrome_extension'; finishedAt: string };
  exam: ExamIdentity;
  students: Student[];
  overview?: ExamOverview;
  settings: TeacherSettings;
  paper?: Paper;
  practice?: AgentBatch;
}
export interface ExamOverview {
  status: 'received' | 'unavailable';
  classMax: number | null; classAvg: number | null; gradeMax: number | null; gradeAvg: number | null;
  topClassAvg?: number | null;
  topClassName?: string | null;
}
export interface ExamHistory {
  examId: string; examName: string; classId: string; className: string; subjectName: string; finishedAt: string;
  classAvg?: number | null; gradeAvg?: number | null; topClassAvg?: number | null;
  students: {id: string; name: string; score: number; fullScore: number; classRank?: number | null}[];
}
export interface StoredWorkspace { revision: number; snapshot: Workspace | null }
export interface Audit {
  rosterCount: number; exportedCount: number; notScannedCount: number; noPaperCount: number;
  questionRecords: number; questionNumbers: string[];
  resultCounts: Record<ResultLabel, number>;
}
export const defaultSettings: TeacherSettings = {
  variantsPerQuestion: 1, maxQuestionsPerStudent: 5, includePartialCredit: true,
  partialCreditThreshold: 100, difficulty: 'same',
};

export class DataError extends Error {
  constructor(code: string) { super(code); this.name = 'DataError'; }
}
const fail = (code: string): never => { throw new DataError(code); };
type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Obj : fail('invalid_data_shape');
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : fail('invalid_data_shape');
const text = (value: unknown, max = 300): string => typeof value === 'string' && value.length <= max
  ? value : fail('invalid_text');
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) fail('missing_identifier');
  return text(value);
};
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value)
  ? value : fail('invalid_score');
const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  ? value : fail('invalid_count');
const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const x = object(a), y = object(b), keys = Object.keys(x);
    return keys.length === Object.keys(y).length && keys.every(k => Object.hasOwn(y, k) && same(x[k], y[k]));
  }
  return false;
};
function rejectSecrets(value: unknown, allowTextUrls = false): void {
  if (!allowTextUrls && typeof value === 'string' && /https?:\/\//i.test(value)) fail('unexpected_credentials_or_remote_media');
  if (Array.isArray(value)) { value.forEach(v => rejectSecrets(v, allowTextUrls)); return; }
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (/^(token|cookie|authorization|password|image_url|student_answer|subjective_answer_present)$/i.test(key)) {
      fail('unexpected_credentials_or_remote_media');
    }
    rejectSecrets(item, allowTextUrls);
  }
}
export function parseExportText(raw: string): unknown {
  if (new TextEncoder().encode(raw).length > 16 * 1024 * 1024) fail('file_too_large');
  try { return JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { return fail('invalid_json'); }
}
export function scoreLabel(score: number, fullScore: number): ResultLabel {
  if (!Number.isFinite(score) || !Number.isFinite(fullScore) || score < 0 || fullScore < score) fail('invalid_score');
  return fullScore === 0 ? 'not_scored' : score === fullScore ? 'correct' : score === 0 ? 'incorrect' : 'partial_credit';
}
export function validateSettings(value: unknown): TeacherSettings {
  const s = object(value);
  const variantsPerQuestion = count(s.variantsPerQuestion), maxQuestionsPerStudent = count(s.maxQuestionsPerStudent);
  const partialCreditThreshold = count(s.partialCreditThreshold);
  if (variantsPerQuestion < 1 || variantsPerQuestion > 10 || maxQuestionsPerStudent < 1 || maxQuestionsPerStudent > 100
    || partialCreditThreshold > 100 || typeof s.includePartialCredit !== 'boolean'
    || !['basic', 'same', 'advanced'].includes(String(s.difficulty))) fail('invalid_settings');
  return { variantsPerQuestion, maxQuestionsPerStudent, partialCreditThreshold,
    includePartialCredit: s.includePartialCredit as boolean, difficulty: s.difficulty as TeacherSettings['difficulty'] };
}

function importStudent(value: unknown, unavailable: boolean): Student {
  const s = object(value);
  const student: Student = { id: id(s.student_id), name: text(s.student_name ?? ''),
    availability: 'scored', reasonSource: null, rosterScore: null, rankCode: null, questions: [] };
  if (s.roster_score != null) student.rosterScore = number(s.roster_score);
  for (const [field, value] of [['classRank', s.class_rank], ['gradeRank', s.grade_rank]] as const) {
    if (value != null) {
      const rank = count(value);
      if (rank < 1) fail('invalid_count');
      student[field] = rank;
    }
  }
  const questions = array(s.questions);
  if (unavailable) {
    if (s.availability === 'not_scanned' && s.reason_source === 'roster_score_column') student.availability = 'not_scanned';
    else if (s.availability === 'no_original_paper' && ['roster_has_origin_paper', 'roster_rank_code'].includes(String(s.reason_source))) student.availability = 'no_original_paper';
    else fail('invalid_unavailable_student');
    if (questions.length) fail('invalid_unavailable_student');
    student.reasonSource = String(s.reason_source);
    if (s.rank_code != null) student.rankCode = number(s.rank_code);
  } else {
    if (s.availability != null && s.availability !== 'scored') fail('invalid_unavailable_student');
    if (!questions.length || questions.length > 1000) fail('empty_or_oversized_question_list');
    student.questions = questions.map(value => {
      const q = object(value);
      const num = String(q.question_number ?? '');
      if (!/^[0-9]+(?:[.．][0-9]+)*$/.test(num) || num.length > 40) fail('invalid_question_number');
      const score = number(q.score), fullScore = number(q.full_score), result = scoreLabel(score, fullScore);
      if (q.result !== result || q.lost_points !== (score < fullScore)) fail('incorrect_result_label');
      return { number: num, label: text(q.question_label ?? num), score, fullScore, result };
    });
    if (new Set(student.questions.map(q => q.number)).size !== student.questions.length) fail('duplicate_question_numbers');
  }
  return student;
}

function importOverview(value: unknown, camelCase = false): ExamOverview {
  const o = object(value);
  rejectSecrets(o);
  if (o.status !== 'received' && o.status !== 'unavailable') fail('invalid_data_shape');
  const metric = (key: string) => {
    const v = o[key];
    if (v == null) return null;
    const n = number(v);
    if (n < 0) fail('invalid_score');
    return n;
  };
  return {status: o.status as ExamOverview['status'], classMax: metric(camelCase ? 'classMax' : 'class_max'),
    classAvg: metric(camelCase ? 'classAvg' : 'class_avg'), gradeMax: metric(camelCase ? 'gradeMax' : 'grade_max'),
    gradeAvg: metric(camelCase ? 'gradeAvg' : 'grade_avg'),
    ...(o[camelCase ? 'topClassAvg' : 'top_class_avg'] == null ? {} : {topClassAvg: metric(camelCase ? 'topClassAvg' : 'top_class_avg')}),
    ...(o[camelCase ? 'topClassName' : 'top_class_name'] == null ? {} : {topClassName: text(o[camelCase ? 'topClassName' : 'top_class_name'])})};
}

export function comparisonScores(workspace: Workspace) {
  const reference = workspace.students.find(s => s.availability === 'scored');
  const fullScore = reference?.questions.reduce((sum,q) => sum + q.fullScore, 0) ?? 0;
  if (fullScore <= 0) return [];
  return workspace.students.flatMap(student => {
    if (student.availability === 'not_scanned') return [];
    const roster = student.rosterScore;
    const score = roster != null && roster >= 0 && roster <= fullScore ? roster
      : student.availability === 'scored' ? student.questions.reduce((sum,q) => sum + q.score, 0) : null;
    return score == null ? [] : [{id:student.id, name:student.name, score, fullScore, classRank:student.classRank ?? null}];
  });
}
export function compareExams(current: Workspace, previous: ExamHistory) {
  const old = new Map(previous.students.map(student => [student.id, student]));
  return comparisonScores(current).flatMap(student => {
    const prior = old.get(student.id);
    const {score, fullScore} = student;
    const currentRank = student.classRank, previousRank = prior?.classRank;
    if (!prior || score <= 0 || prior.score <= 0 || !Number.isSafeInteger(currentRank) || !Number.isSafeInteger(previousRank)
      || currentRank! <= 0 || previousRank! <= 0) return [];
    return [{id:student.id, name:student.name || prior.name, score, fullScore,
      previousScore:prior.score, previousFullScore:prior.fullScore,
      currentRank:currentRank!, previousRank:previousRank!, change: previousRank! - currentRank!}];
  });
}

function auditStudents(students: Student[]): Audit {
  if (!students.length || students.length > 2000) fail('invalid_student_count');
  if (new Set(students.map(s => s.id)).size !== students.length) fail('duplicate_student_identifiers');
  const scored = students.filter(s => s.availability === 'scored');
  // Keep parity with Python audit: an entirely unavailable class cannot become a usable exercise exam.
  if (!scored.length) fail('no_scanned_students');
  const reference = new Map(scored[0].questions.map(q => [q.number, q.fullScore]));
  const resultCounts = { correct: 0, incorrect: 0, partial_credit: 0, not_scored: 0 };
  let questionRecords = 0;
  for (const student of scored) {
    if (student.questions.length !== reference.size || student.questions.some(q => reference.get(q.number) !== q.fullScore)) {
      fail('question_number_or_full_score_mismatch');
    }
    for (const q of student.questions) { resultCounts[q.result]++; questionRecords++; }
  }
  return { rosterCount: students.length, exportedCount: scored.length,
    notScannedCount: students.filter(s => s.availability === 'not_scanned').length,
    noPaperCount: students.filter(s => s.availability === 'no_original_paper').length,
    questionRecords, questionNumbers: [...reference.keys()], resultCounts };
}

export function auditExport(value: unknown, verification?: unknown): { audit: Audit; students: Student[]; data: Obj; finishedAt: string } {
  rejectSecrets(value);
  const root = object(value), summary = object(root.summary);
  if (root.ok !== true) fail('export_reported_failure');
  if (summary.status !== 'passed_live_full_class_export' || summary.export_scope !== 'full_class_scores_only') fail('not_a_full_class_export');
  if (summary.authentication !== 'verified_teacher_session') fail('teacher_session_not_verified');
  const data = object(root.data), records = object(summary.question_records);
  if (verification !== undefined) {
    rejectSecrets(verification);
    const v = object(verification);
    if (v.ok !== true || !same(v.summary, summary)) fail('verification_summary_mismatch');
  }
  if (array(records.failures).length || count(records.unprocessed_students) !== 0) fail('incomplete_student_processing');
  const students = array(data.students).map(s => importStudent(s, false));
  students.push(...array(data.unavailable_students ?? []).map(s => importStudent(s, true)));
  const audit = auditStudents(students);
  if (audit.rosterCount !== count(object(summary.roster).student_count)
    || audit.exportedCount !== count(records.exported_students)
    || audit.notScannedCount !== count(records.not_scanned_students ?? 0)
    || audit.noPaperCount !== count(records.no_original_paper_students ?? 0)) fail('student_count_mismatch');
  if (audit.questionRecords !== count(records.question_count) || !same(audit.resultCounts, summary.result_counts)) fail('question_totals_mismatch');
  if (records.requested_students != null && count(records.requested_students) !== audit.rosterCount) fail('student_count_mismatch');
  if (records.accounted_students != null && count(records.accounted_students) !== audit.rosterCount) fail('student_count_mismatch');
  if (records.processed_students != null && count(records.processed_students) !== audit.rosterCount) fail('incomplete_student_processing');
  return { audit, students, data, finishedAt: id(summary.finished_at) };
}

export function workspaceFromExport(value: unknown, kind: Workspace['source']['kind'], names: Partial<ExamIdentity> = {}, verification?: unknown): Workspace {
  const { students, data, finishedAt } = auditExport(value, verification);
  const exam: ExamIdentity = { id: id(data.exam_id), subjectId: id(data.subject_id), classId: id(data.class_id),
    name: text(names.name ?? '导入考试'), subjectName: text(names.subjectName ?? '未命名学科'), className: text(names.className ?? '导入班级') };
  if ((names.id != null && names.id !== exam.id) || (names.subjectId != null && names.subjectId !== exam.subjectId)
    || (names.classId != null && names.classId !== exam.classId)) fail('selection_mismatch');
  return { schemaVersion: 1, source: { kind, finishedAt }, exam, students, settings: { ...defaultSettings },
    ...(data.overview === undefined ? {} : {overview: importOverview(data.overview)}) };
}

// Revalidate and project local persisted data before using it, including after upgrades.
export function validateWorkspace(value: unknown): Workspace {
  rejectSecrets(value, true);
  const w = object(value), source = object(w.source), exam = object(w.exam);
  rejectSecrets({source,exam,students:w.students,settings:w.settings});
  if (w.schemaVersion !== 1 || !['zhixue_webview', 'chrome_extension'].includes(String(source.kind))) fail('unsupported_workspace');
  const students = array(w.students).map(value => {
    const s = object(value);
    if (!['scored', 'not_scanned', 'no_original_paper'].includes(String(s.availability))) fail('invalid_unavailable_student');
    return importStudent({student_id: s.id, student_name: s.name, availability: s.availability,
      reason_source: s.reasonSource, roster_score: s.rosterScore, rank_code: s.rankCode, class_rank: s.classRank, grade_rank: s.gradeRank,
      questions: array(s.questions).map(value => {
        const q = object(value);
        return {question_number: q.number, question_label: q.label, score: q.score, full_score: q.fullScore,
          result: q.result, lost_points: number(q.score) < number(q.fullScore)};
      })}, s.availability !== 'scored');
  });
  auditStudents(students);
  const normalized: Workspace = { schemaVersion: 1, source: { kind: source.kind as Workspace['source']['kind'], finishedAt: id(source.finishedAt) },
    exam: { id: id(exam.id), name: text(exam.name), subjectId: id(exam.subjectId), subjectName: text(exam.subjectName),
      classId: id(exam.classId), className: text(exam.className) }, students, settings: validateSettings(w.settings),
    ...(w.overview === undefined ? {} : {overview: importOverview(w.overview, true)}),
    ...(w.paper === undefined ? {} : { paper: validatePaper(w.paper, students.find(s => s.availability === 'scored')!.questions.map(q => q.number)) }) };
  if (w.practice !== undefined) normalized.practice = validateBatch(w.practice, normalized);
  return normalized;
}

export function analyze(workspace: Workspace) {
  const audit = auditStudents(workspace.students), settings = validateSettings(workspace.settings);
  const isWeak = (q: QuestionResult) => q.result === 'incorrect' || (q.result === 'partial_credit'
    && settings.includePartialCredit && q.score / q.fullScore * 100 < settings.partialCreditThreshold);
  const rows = new Map(audit.questionNumbers.map(number => [number, {
    number, fullScore: 0, totalScore: 0, totalLost: 0, eligibleStudents: 0,
    weakStudents: 0, incorrectStudents: 0, partialStudents: 0, lostRate: 0,
  }]));
  const students = workspace.students.map(s => {
    let lostPoints = 0;
    for (const q of s.questions) {
      const row = rows.get(q.number)!;
      row.fullScore = q.fullScore; row.totalScore += q.score; row.totalLost += q.fullScore - q.score;
      row.eligibleStudents += q.fullScore > 0 ? 1 : 0;
      row.weakStudents += isWeak(q) ? 1 : 0;
      row.incorrectStudents += q.result === 'incorrect' ? 1 : 0;
      row.partialStudents += q.result === 'partial_credit' ? 1 : 0;
      lostPoints += q.fullScore - q.score;
    }
    return { id: s.id, name: s.name, availability: s.availability, lostPoints,
      weakQuestions: s.questions.filter(isWeak).map(q => q.number) };
  });
  for (const row of rows.values()) row.lostRate = row.fullScore > 0 ? row.totalLost / (row.fullScore * row.eligibleStudents) : 0;
  return { audit, questions: [...rows.values()], students };
}

export const dataErrorMessage = (error: unknown): string => {
  const code = error instanceof Error ? error.message : String(error);
  const messages: Record<string, string> = {
    invalid_practice: '本场出题或审核结果与当前资料不一致，请重新生成并核对。',
    invalid_json: '文件不是有效的 JSON。', file_too_large: '文件超过 16 MB，请检查是否选择了正确文件。',
    export_reported_failure: '导出记录包含失败，不能保存为完整班级。', not_a_full_class_export: '请选择全班逐题导出文件，样本文件不能作为全班数据。',
    teacher_session_not_verified: '源数据没有确认教师会话。', verification_summary_mismatch: '验证文件与成绩文件不是同一次导出。',
    student_count_mismatch: '名单人数与已读取、没扫、无原卷人数不一致。', duplicate_student_identifiers: '名单中有重复学生标识。',
    incomplete_student_processing: '仍有失败或未处理学生，不能视为完整班级。', no_scanned_students: '全班暂无可分析的逐题记录，不能生成补练。',
    incorrect_result_label: '对错标记与实际分数不一致。', invalid_score: '存在非法分数或得分超过满分。',
    question_number_or_full_score_mismatch: '不同学生的题号或满分不一致。', duplicate_question_numbers: '同一学生有重复题号。',
    question_totals_mismatch: '逐题记录数或对错汇总与实际数据不一致。', invalid_unavailable_student: '没扫或无原卷的记录缺少名单依据，或包含不应存在的对错判断。',
    unexpected_credentials_or_remote_media: '文件含会话凭据、作答原文或远程图片，不符合仅导入得分的格式。',
    selection_mismatch: '读取结果与所选考试、班级或学科不一致。', invalid_settings: '请检查题数、阈值和难度设置。',
    storage_conflict: '本机数据已在其他窗口改变，请重新打开程序后再试。', storage_failed: '本次本地存储未能确认完成，请重新打开程序核对。',
    unsupported_workspace: '本地数据版本暂不支持，请保留文件并核对程序版本。', missing_identifier: '成绩文件缺少考试、班级或学生标识。',
  };
  return messages[code] ?? `数据处理未通过（${/^[a-z_]{1,70}$/.test(code) ? code : 'invalid_data'}）。`;
};
