import { analyze, type Workspace, type Paper } from '../../core/src/index.ts';
import { validatePaper, validateRecognition } from '../../paper/src/index.ts';
import { assertAnonymous } from './index.ts';

// Called only by the explicit generation action. No recognition on file import.
export async function preparePaper(workspace: Workspace, recognize: (pageId: string) => Promise<unknown>,
  progress: (message: string) => void, signal?: AbortSignal): Promise<Paper> {
  const numbers = analyze(workspace).audit.questionNumbers;
  const paper = validatePaper(workspace.paper, numbers);
  if (!paper.pages.length) throw new Error('paper_required');
  const check = () => { if (signal?.aborted) throw new Error('agent_cancelled'); };
  const normalize = (s: string) => s.normalize('NFKC').replace(/\s/g, '');
  const questions = new Map<string, Paper['questions'][number]>();
  for (const [index, page] of paper.pages.entries()) {
    check(); progress(`读取空白卷第 ${index + 1} / ${paper.pages.length} 页…`);
    const first = validateRecognition(await recognize(page.id), numbers); check();
    assertAnonymous(first, workspace.students.map(s => s.name));
    progress(`核对第 ${index + 1} 页的题号、题干、选项与共用材料…`);
    const second = validateRecognition(await recognize(page.id), numbers); check();
    assertAnonymous(second, workspace.students.map(s => s.name));
    if (first.questions.length !== second.questions.length || first.warnings.length || second.warnings.length)
      throw new Error('paper_check_required');
    for (const q of first.questions) {
      const other = second.questions.find(item => item.number === q.number);
      if (q.confidence !== 'high' || other?.confidence !== 'high' || normalize(q.stem) !== normalize(other.stem))
        throw new Error('paper_check_required');
      const prior = questions.get(q.number);
      if (prior && normalize(prior.stem) !== normalize(q.stem)) throw new Error('paper_check_required');
      questions.set(q.number, { number: q.number, pageId: prior?.pageId ?? page.id, stem: q.stem, confirmed: true });
    }
  }
  check();
  if (analyze(workspace).questions.some(q => q.weakStudents > 0 && !questions.has(q.number)))
    throw new Error('paper_questions_missing');
  return validatePaper({ pages: paper.pages, questions: [...questions.values()] }, numbers);
}
