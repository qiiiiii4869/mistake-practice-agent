// A separate process intentionally exits without running finally blocks.
import {readFile,appendFile} from 'node:fs/promises';
import {setupWorkflow} from './workflow_fixture.mjs';
import {SqliteWorkflowStore,runWorkflow} from '../app/packages/agent/src/workflow/index.ts';
import {recognizeWorkflowUnits} from '../app/packages/agent/src/workflow/recognition.ts';
import {sqliteProbeTransport} from '../tools/workflow-store-transport.mjs';
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const transport=sqliteProbeTransport(config.database,{now:()=>1000});
const s=await setupWorkflow(),store=new SqliteWorkflowStore(transport.invoke,s.input.ownerId);
if(config.recognition)s.ports.prepareUnits=(input,signal,invoke,report)=>recognizeWorkflowUnits(input,invoke,[],report);
const baseCall=s.ports.model.call.bind(s.ports.model);
s.ports.model.call=async(request,signal)=>{await appendFile(config.log,request.stage+'\n');if(config.pending&&request.stage==='cloze')process.exit(24);
 if(request.stage==='recognize')return {value:{questions:[{number:'1',paragraphs:['说明光合作用中的能量转化。'],confidence:'high'},{number:'2',paragraphs:['说明细胞分化的实质。'],confidence:'high'}],warnings:[]},usage:{totalTokens:20}};
 return baseCall(request,signal);};
const commit=store.completeCall.bind(store);
store.completeCall=async(owner,run,id,response)=>{await commit(owner,run,id,response);if(!config.pending&&run.calls.at(-1).stage===(config.stage??'cloze'))process.exit(23);};
await runWorkflow({input:s.input,ports:{...s.ports,store},runId:config.runId});
process.exit(90);
