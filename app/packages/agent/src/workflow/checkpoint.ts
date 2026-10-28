import type { Budget } from './budget.ts';
import type { Stage } from './machine.ts';
import type { WorkflowMode } from './types.ts';
export type Json = null|boolean|number|string|Json[]|{[key:string]:Json};
export interface StageResult {
  value:Json;
  pdf?:{contentHash:string;exportHash:string;allOutputsVerified:boolean;coveragePassed:boolean};
  settlement?:{contentHash:string;exportHash:string;confirmed:boolean};
}
export interface Checkpoint {
  schemaVersion:2;workflowVersion:string;promptVersion:string;runId:string;ownerId:string;contentHash:string;exportHash:string;mode:WorkflowMode;
  revision:number;state:string;completed:Stage[];outputs:Partial<Record<Stage,StageResult>>;inFlight:Stage|null;
  budget:Budget;errorCode:string|null;
  calls:Record<string,{stage:Stage;requestHash:string;status:'sent'|'succeeded'|'unknown';usage:number|null;value?:Json}>;
}
export interface CheckpointStore {
  read(ownerId:string,runId:string):Checkpoint|null;
  write(value:Checkpoint,expectedRevision:number|null):Checkpoint;
  acquire(ownerId:string,runId:string):()=>void;
}
export function assertCheckpointSafe(value:unknown):void {
  const visit=(v:unknown,depth:number):void=>{
    if(depth>40)throw new Error('workflow_checkpoint_limit');
    if(v===null||typeof v==='boolean')return;
    if(typeof v==='number'&&Number.isFinite(v))return;
    if(typeof v==='string'){if(/\bBearer\s+\S+|\bsk-[a-zA-Z0-9_-]{12,}/i.test(v))throw new Error('workflow_checkpoint_secret');return;}
    if(Array.isArray(v)){v.forEach(x=>visit(x,depth+1));return;}
    if(v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype){
      for(const [key,item] of Object.entries(v)){
        if(/^(key|token|apikey|modelkey|sharedkey|modelapikey|sharedapikey|secret|password|authorization|headers|accesstoken|refreshtoken|sessiontoken|credentials)$/i.test(key.replace(/[_-]/g,'')))throw new Error('workflow_checkpoint_secret');
        visit(item,depth+1);
      }return;
    }
    throw new Error('workflow_checkpoint_invalid');
  };
  visit(value,0);if(new TextEncoder().encode(JSON.stringify(value)).length>16*1024*1024)throw new Error('workflow_checkpoint_limit');
}
export class MemoryCheckpointStore implements CheckpointStore {
  private values=new Map<string,Checkpoint>();private locks=new Map<string,string>();
  private key(ownerId:string,runId:string){return JSON.stringify([ownerId,runId]);}
  read(ownerId:string,runId:string){const value=this.values.get(this.key(ownerId,runId));return value?structuredClone(value):null;}
  write(value:Checkpoint,expectedRevision:number|null){
    assertCheckpointSafe(value);const key=this.key(value.ownerId,value.runId),old=this.values.get(key);
    if(expectedRevision===null?!!old:!old||old.revision!==expectedRevision)throw new Error('workflow_checkpoint_conflict');
    const next=structuredClone({...value,revision:(old?.revision??-1)+1});this.values.set(key,next);return structuredClone(next);
  }
  acquire(ownerId:string,runId:string){
    if(this.locks.has(ownerId))throw new Error('workflow_busy');
    this.locks.set(ownerId,runId);let released=false;
    return ()=>{if(!released&&this.locks.get(ownerId)===runId){this.locks.delete(ownerId);released=true;}};
  }
}
