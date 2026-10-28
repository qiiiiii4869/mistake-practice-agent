import { assign, setup, createActor } from 'xstate';
import type { WorkflowMode } from './types.ts';

export const commonStages=['preflight','authorizing','rendering','recognizing','aligning','extracting','retrieving','verifyingFacts','merging','selectingTargets'] as const;
export const endingStages=['assembling','aggregatingEvidence','writingGuidance','validatingGuidance','exporting','validatingPdf','settling'] as const;
export const allStages=[...commonStages,'clozing','validatingCloze','generatingExercises','solving','validatingExercise',...endingStages] as const;
export type Stage=typeof allStages[number];
interface Binding {ownerId:string;contentHash:string;exportHash:string;mode:WorkflowMode}
interface Context extends Binding {stage:Stage|'idle';pdfVerified:boolean}
type Event={type:'START'}|{type:'STEP_DONE';stage:Stage}|{type:'CANCEL'}|{type:'FAIL';recoverable:boolean}
  |{type:'RECOVER';ownerId:string;contentHash:string;cloudConfirmed:boolean}
  |{type:'PDF_VERIFIED';contentHash:string;exportHash:string;allOutputsVerified:boolean;coveragePassed:boolean}
  |{type:'SETTLED';contentHash:string;exportHash:string}|{type:'SETTLEMENT_FAILED'};

const next:Partial<Record<Stage,Stage>>={preflight:'authorizing',authorizing:'rendering',rendering:'recognizing',recognizing:'aligning',aligning:'extracting',extracting:'retrieving',retrieving:'verifyingFacts',verifyingFacts:'merging',merging:'selectingTargets',clozing:'validatingCloze',validatingCloze:'assembling',generatingExercises:'solving',solving:'validatingExercise',validatingExercise:'assembling',assembling:'aggregatingEvidence',aggregatingEvidence:'writingGuidance',writingGuidance:'validatingGuidance',validatingGuidance:'exporting',exporting:'validatingPdf'};
export const workflowMachine=setup({types:{context:{} as Context,input:{} as Binding,events:{} as Event}}).createMachine({
  id:'reportWorkflow',initial:'idle',context:({input})=>{if(!input.ownerId||!['dictation','exercise'].includes(input.mode)||! /^[a-f0-9]{64}$/.test(input.contentHash)||! /^[a-f0-9]{64}$/.test(input.exportHash))throw new Error('workflow_invalid_binding');return {ownerId:input.ownerId,contentHash:input.contentHash,exportHash:input.exportHash,mode:input.mode,stage:'idle',pdfVerified:false};},
  on:{
    CANCEL:{guard:({context})=>context.stage!=='idle'&&context.stage!=='settling',target:'.cancelled'},
    FAIL:[{guard:({context})=>context.stage==='settling',target:'.pendingSettlement'},
      {guard:({event})=>event.recoverable,target:'.recoverable'},{target:'.failed'}],
  },
  states:{
    idle:{on:{START:'preflight'}},
    ...Object.fromEntries(allStages.map(stage=>[stage,{
      entry:assign({stage:()=>stage}),
      on:stage==='selectingTargets'?{STEP_DONE:[
        {guard:({context,event}:{context:Context;event:Event})=>event.type==='STEP_DONE'&&event.stage===stage&&context.mode==='dictation',target:'clozing'},
        {guard:({context,event}:{context:Context;event:Event})=>event.type==='STEP_DONE'&&event.stage===stage&&context.mode==='exercise',target:'generatingExercises'},
      ]}:stage==='validatingPdf'?{PDF_VERIFIED:{
        guard:({context,event}:{context:Context;event:Event})=>event.type==='PDF_VERIFIED'&&event.contentHash===context.contentHash&&event.exportHash===context.exportHash&&event.allOutputsVerified&&event.coveragePassed,
        target:'settling',actions:assign({pdfVerified:()=>true}),
      }}:stage==='settling'?{
        SETTLED:{guard:({context,event}:{context:Context;event:Event})=>event.type==='SETTLED'&&context.pdfVerified&&event.contentHash===context.contentHash&&event.exportHash===context.exportHash,target:'completed'},
        SETTLEMENT_FAILED:'pendingSettlement',CANCEL:{},
      }:{STEP_DONE:{guard:({event}:{event:Event})=>event.type==='STEP_DONE'&&event.stage===stage,target:next[stage]}},
    }])),
    recoverable:{on:{RECOVER:allStages.filter(s=>s!=='settling').map(stage=>({
      guard:({context,event})=>event.cloudConfirmed&&event.ownerId===context.ownerId&&event.contentHash===context.contentHash&&context.stage===stage,target:stage,
    }))}},
    pendingSettlement:{on:{RECOVER:{guard:({context,event})=>context.pdfVerified&&event.cloudConfirmed&&event.ownerId===context.ownerId&&event.contentHash===context.contentHash,target:'settling'},CANCEL:{}}},
    partial:{type:'final'},failed:{type:'final'},cancelled:{type:'final'},completed:{type:'final'},
  },
});

export const createWorkflowActor=(input:Binding)=>createActor(workflowMachine,{input});
