import {setupWorkflow,mockWorkflowModel} from './workflow_fixture.mjs';
import {runWorkflow} from '../app/packages/agent/src/workflow/index.ts';

export async function workflowPdfFixture(mode='exercise',{stress=false}={}){
  const facts=[
    {knowledgePoint:'合成知识甲',completeStatement:'合成能量关系包含 H₂O、CO₂、F₁、α、β 以及 $E=\\frac{1}{2}mv^{2}$，约定标记为甲项。',conditions:[],candidateAnswers:['甲项']},
    {knowledgePoint:'合成知识乙'+(stress?'与长期材料条件的准确区分'.repeat(12):''),completeStatement:(stress?'本句仅为分页验证材料，保留完整限定背景，不用于教学。'.repeat(24):'')+'合成实验的约定标记为乙项。',conditions:[],candidateAnswers:['乙项']},
    {knowledgePoint:'合成知识丙',completeStatement:'合成比例关系为 3∶1，约定标记为丙项。',conditions:[],candidateAnswers:['丙项']},
    {knowledgePoint:'合成知识丁',completeStatement:'合成计算的约定标记为丁项。',conditions:[],candidateAnswers:['丁项']},
  ];
  const answerById=new Map();
  const model=mockWorkflowModel((r,response)=>{
    if(r.stage==='extract'){const group=r.data.original.sourceNumbers[0]==='1'?facts.slice(0,2):facts.slice(2);
      response.value={facts:group};group.forEach((f,i)=>answerById.set(`${r.data.original.unitId}-fact-${i+1}`,f.candidateAnswers[0]));}
    if(r.stage==='blindFill')response.value={answers:[{blankId:'b1',value:answerById.get(r.data.contentId)}],ambiguous:false,missingConditions:false};
    const kinds={'unit-1-fact-1':'single_choice','unit-1-fact-2':'multiple_choice','unit-2-fact-1':'short_answer','unit-2-fact-2':'calculation'};
    if(r.stage==='exercise'){
      const type=kinds[r.data.contentId],choice=type.endsWith('choice');
      response.value={type,stem:`本题为合成排版题（${type}）：请按材料中的约定作答。${type==='calculation'?' 已知 $v=\\frac{2}{1}$，求所需距离。':''}`,
        material:stress?'合成材料段落：记录甲组与乙组在限定条件下的步骤，仅验证跨页排版与续题关联。'.repeat(50):'合成材料中显示 H₂O、CO₂、F₁ 与 α，比例为 3∶1。',
        options:choice?[{id:'A',text:'符合合成约定的选项甲'},{id:'B',text:'合成干扰项'},{id:'C',text:'符合合成约定的选项乙'}]:[],
        answer:type==='single_choice'?['A']:type==='multiple_choice'?['A','C']:type==='calculation'?['2m']:['解释合成约定'],
        rubric:['指出限定条件','保留推理步骤'],explanation:'依据合成材料逐项核对条件，仅用于排版验收。',estimatedMinutes:3,
        ...(type==='calculation'?{numericAnswer:{value:2,unit:'m'}}:{})};
    }
    if(r.stage==='solve'){
      const type=kinds[r.data.contentId];response.value={complete:true,inScope:true,tooSimilar:false,
        ...(type==='single_choice'?{answer:['A']}:type==='multiple_choice'?{answer:['A','C']}:type==='calculation'?{numericAnswer:{value:2,unit:'m'}}:{keyPoints:['指出限定条件','保留推理步骤'],contradiction:false})};
    }
    if(r.stage==='guidance'&&stress){response.value.overview='对照原始考试证据核查概念与条件。'.repeat(20);response.value.advice.forEach(a=>a.classroomAction='对照原题梳理条件，安排有依据的课堂解释。'.repeat(20));}
    return response;
  });
  const s=await setupWorkflow({mode,model});
  // Give both scored synthetic students all four targets.
  const workspace=structuredClone(s.input.workspace);for(const student of workspace.students.filter(s=>s.availability==='scored'))for(const q of student.questions){q.score=0;q.result='incorrect';}
  const {freezeInput}=await import('../app/packages/agent/src/workflow/index.ts');
  const input=await freezeInput({ownerId:s.input.ownerId,workspace,mode});
  const run=await runWorkflow({input,ports:s.ports});
  if(run.state!=='contentReady')throw new Error('synthetic_pdf_fixture_incomplete');
  return {input,run,model};
}
