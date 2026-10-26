import type { ModelProvider, ModelRequest, QuestionKind } from './index.ts';

// An intentionally obvious, offline demo. It is never eligible for real export.
export function demoProvider(keyword: string, kinds: Record<string,{kind:QuestionKind;group:string}> = {}): ModelProvider {
  return {mode:'mock', async call(request: ModelRequest) {
    if (request.stage === 'annotate') {
      const original = request.data.original as {number:string}; const rule=kinds[original.number];
      return { knowledgePoints:[keyword],keywords:[keyword],kind:rule?.kind ?? 'text',materialGroup:rule?.kind === 'shared_material' ? rule.group : null };
    }
    if (request.stage === 'generate') return {exercises:Array.from({length:Number(request.data.count)},(_,i)=>({
      stem:`【离线演示 ${i+1}】请对照知识库，说明“${keyword}”的主要内容。`, options:[], answer:'演示答案，须接入真实模型后重新生成',
      explanation:'此内容用于验证流程，不是可分发的补练题。', knowledgePoints:[keyword],sourceIndexes:[0],
    }))};
    return { answer:'演示答案，须接入真实模型后重新生成',complete:true,inScope:true,tooSimilar:false,explanation:'离线固定返回，只验证独立调用和比对流程，不证明题目质量。' };
  }};
}
