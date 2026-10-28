import { workspaceFromExport } from '../app/packages/core/src/index.ts';
import { freezeInput, MemoryWorkflowStore } from '../app/packages/agent/src/workflow/index.ts';
import { fixture, addUnavailable } from './core_fixture.mjs';

export function workflowWorkspace() {
  const data = fixture(); addUnavailable(data);
  const w = workspaceFromExport(data,'chrome_extension');
  w.exam.subjectName = '生物';
  w.paper = { pages: [{ id: 'page-1', name: '合成空白卷.png', data: 'data:image/png;base64,aGVsbG8=' }], questions: [] };
  return w;
}
export function sourceUnits() {
  return [
    { unitId: 'unit-1', sourceNumbers: ['1'], pageIds: ['page-1'], stem: '说明光合作用中的能量转化。', material: '', options: [], availability: 'usable', alignmentStatus: 'recognized_by_machine' },
    { unitId: 'unit-2', sourceNumbers: ['2'], pageIds: ['page-1'], stem: '说明细胞分化的实质。', material: '', options: [], availability: 'usable', alignmentStatus: 'recognized_by_machine' },
  ];
}
export function factCandidate(number) {
  return number === '1'
    ? { knowledgePoint: '光合作用', completeStatement: '光合作用将光能转化为化学能。', conditions: [], candidateAnswers: ['化学能'] }
    : { knowledgePoint: '细胞分化', completeStatement: '细胞分化的实质是基因的选择性表达。', conditions: [], candidateAnswers: ['基因'] };
}
export function mockWorkflowModel(change) {
  const calls = [];
  const model = { executionMode: 'mock', calls, async call(request,signal) {
    calls.push(structuredClone(request));
    if (signal.aborted) throw new Error('workflow_cancelled');
    let value;
    const d = request.data;
    switch (request.stage) {
      case 'extract': value = { facts: [factCandidate(d.original.sourceNumbers[0])] }; break;
      case 'verifyFact': value = { checks: d.facts.map(() => ({ accurate: true, supported: true, inScope: true })) }; break;
      case 'cloze': {
        const answer = d.candidateAnswers[0], at = d.statement.indexOf(answer);
        value = { parts: [{ type: 'text', text: d.statement.slice(0,at) },
          { type: 'blank', blankId: 'b1', answer, acceptedAnswers: [answer] },
          { type: 'text', text: d.statement.slice(at + answer.length) }], correction: '注意核心概念及其适用条件。' }; break;
      }
      case 'blindFill': value = { answers: [{ blankId: 'b1', value: JSON.stringify(d).includes('细胞分化') ? '基因' : '化学能' }], ambiguous: false, missingConditions: false }; break;
      case 'exercise': value = { type: 'single_choice', stem: `关于${d.fact.knowledgePoint}，下列说明正确的是？`, material: '',
        options: [{ id: 'A', text: d.fact.statement },{ id: 'B', text: '所有条件下均不发生变化。' }], answer: ['A'],
        rubric: ['指出核心概念与适用条件'], explanation: '根据完整知识陈述判断。', estimatedMinutes: 2 }; break;
      case 'solve': value = { answer: ['A'], complete: true, inScope: true, tooSimilar: false }; break;
      case 'guidance': value = {overview:'综合全班逐题表现、知识目标与总分分布安排统一讲评。',
        groupActions:d.classOverview.scoreBands.filter(b=>b.studentCount>0).map(b=>({bandId:b.bandId,action:'结合该得分区间的逐题表现安排分层巩固。'})),followUp:'统一讲评后安排独立短测再观察表现。',
        advice: d.evidence.map(e => ({ evidenceIds: [e.evidenceId], focus: `${e.knowledgePoint}相关题表现偏弱，建议核实。`,
        classroomAction: '对照原题梳理概念，请学生解释条件变化。', followUp: '用独立短练习观察学生能否说明依据。' })) }; break;
      default: throw new Error('unexpected_test_stage');
    }
    const response = { value, usage: { totalTokens: 100 } };
    return change ? await change(request,response,model) : response;
  }};
  return model;
}
export async function setupWorkflow({ mode = 'dictation', library = false, workspace = workflowWorkspace(), model = mockWorkflowModel(), ...rest } = {}) {
  const input = await freezeInput({ ownerId: 'synthetic-owner', workspace, mode, knowledgeRevision: library ? 'library-v1' : 'empty', ...rest });
  const store = new MemoryWorkflowStore();
  let prepareCalls = 0;
  const ports = { store, model, prepareUnits: async () => { prepareCalls++; return sourceUnits(); }, retrieve: async () => library
    ? [{ documentId: 'synthetic-book', page: 3, text: '细胞分化体现基因的选择性表达，光合作用发生能量转化。' }] : [] };
  return { input, ports, model, store, get prepareCalls() { return prepareCalls; } };
}
