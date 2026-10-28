// Development-only phase A demo: synthetic responses, no HTTP, no real student data.
import { runWorkflow } from '../app/packages/agent/src/workflow/index.ts';
import { setupWorkflow } from '../tests/workflow_fixture.mjs';

const results=[];
for(const mode of ['dictation','exercise'])for(const library of [false,true]){
  const s=await setupWorkflow({mode,library});
  const run=await runWorkflow({...s,runId:`demo-${mode}-${library?'library':'paper'}`});
  const summary={mode,source:library?'library':'paper',state:run.state,executionMode:run.executionMode,
    facts:run.facts.length,validatedItems:run.items.filter(i=>i.status==='passed').length,
    students:run.assignments.length,targetStudents:run.assignments.filter(s=>s.selectedTargets.length).length,
    teacherAdvice:run.advice.length,modelCalls:run.calls.length};
  results.push(process.argv.includes('--summary')?summary:{...summary,sampleItem:run.items[0],evidence:run.evidence,advice:run.advice});
}
console.log(JSON.stringify({phase:'A',synthetic:true,pdfExported:false,settled:false,results},null,2));
if(results.some(r=>r.state!=='contentReady'))process.exitCode=1;
