import { assertAnonymous } from '../index.ts';
import { assignStudents, mergeFacts, selectTargets } from './assignment.ts';
import { estimateBudget, recordUsage, reserveCall } from './budget.ts';
import { assertFrozen, digest, preflight } from './input.ts';
import { actorState, createWorkflowActor } from './machine.ts';
import { modelRequest } from './prompts.ts';
import { generateDictation } from './strategies/dictation.ts';
import { generateExercise } from './strategies/exercise.ts';
import { templateClassTeachingReport,validateClassTeachingReport,teachingReportInput } from './teachingAdvice.ts';
import { teachingEvidence,classOverview } from './teachingEvidence.ts';
import type { BudgetPolicy, FactCandidate, FrozenInput, InvokeModel, KnowledgeFact, ModelResponse, WorkflowPorts, WorkflowRun, WorkflowState,WorkflowTaskContext,CheckpointData } from './types.ts';
import { factPassed, invalid, list, normalize, object, validateEvidence, validateFactCheck, validateFacts, validateUnits,validationReason } from './validators.ts';
import {planBatches,remainingFits,sourceData,extractBatch,verificationData,verifyBatch} from './batchAnalysis.ts';
import {workflowErrorCode} from './errors.ts';
import {minimumFacts,minimumCloze,minimumExercise,minimumReport} from './minimumChecks.ts';

export interface RunOptions {
  input: FrozenInput; ports: WorkflowPorts; runId?: string; signal?: AbortSignal;
  policy?: Partial<BudgetPolicy>; resume?: boolean; retryUnknownCalls?: boolean;
  taskContext?:WorkflowTaskContext;
}
const activeOwners = new Map<string,{ runId: string; hash: string; promise: Promise<WorkflowRun> }>();

export function runWorkflow(options: RunOptions): Promise<WorkflowRun> {
  const input = structuredClone(options.input), runId = options.runId ?? crypto.randomUUID();
  const active = activeOwners.get(input.ownerId);
  if (active) {
    if (active.runId === runId && active.hash === input.contentHash) return active.promise;
    return Promise.reject(new Error('workflow_busy'));
  }
  const promise = execute({ ...options, input, runId }).finally(async()=>{try{await options.ports.store.endRun?.(input.ownerId,runId);}finally{activeOwners.delete(input.ownerId);}});
  activeOwners.set(input.ownerId,{ runId, hash: input.contentHash, promise });
  return promise;
}

async function execute(options: RunOptions & { runId: string }): Promise<WorkflowRun> {
  const { input, ports, runId } = options, now = ports.now ?? Date.now;
  const leaseController=new AbortController(),signal=options.signal?AbortSignal.any([options.signal,leaseController.signal]):leaseController.signal;
  await assertFrozen(input);
  if (ports.model.executionMode === 'real' && (!ports.authorize || !ports.release)) throw new Error('workflow_authorization_required');
  if (!/^[\w-]{1,100}$/.test(runId)) throw new Error('workflow_invalid_run_id');
  const shape = preflight(input),batched=!input.testScope&&shape.units>6;
  const minimum=input.validationLevel==='minimum';
  const estimated = minimum?{...estimateBudget(input.mode,shape.hasTargets?shape.pages:0,0,true),maxCalls:300}
    :estimateBudget(input.mode,shape.hasTargets ? shape.pages : 0,shape.hasTargets ? shape.units : 0,batched);
  const policy = { ...estimated, ...options.policy };
  for (const [key,value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < (key === 'maxNetworkRetries' ? 0 : 1) || value > estimated[key as keyof BudgetPolicy])
      throw new Error('workflow_invalid_budget');
  }
  let run = await ports.store.load(input.ownerId,runId);
  if (run) {
    if (run.contentHash !== input.contentHash || run.mode !== input.mode || run.executionMode !== ports.model.executionMode
      || run.workflowVersion !== input.workflowVersion || run.promptVersion !== input.promptVersion
      || run.modelConfiguration !== (ports.model.cacheKey ?? 'unversioned')) throw new Error('workflow_stale_run');
    if (run.state === 'contentReady' || run.state === 'partial') return run;
    if (!options.resume) throw new Error('workflow_resume_required');
    // Restored counters and original deadlines are retained, including unknown usage.
    const resolvedRetry=(i:number)=>run!.calls[i].attempt===1&&run!.calls[i+1]?.attempt===2&&run!.calls[i+1].status==='completed'
      &&run!.calls[i+1].requestHash===run!.calls[i].requestHash&&run!.calls[i+1].scopeId===run!.calls[i].scopeId;
    if (run.calls.some((c,i) => c.status !== 'completed'&&!resolvedRetry(i)) && !options.retryUnknownCalls) throw new Error('workflow_unknown_call_requires_decision');
    run.calls.filter(c => c.status === 'pending').forEach(c => { c.status = 'unknown'; });
  } else {
    if (options.resume) throw new Error('workflow_run_not_found');
    run = { runId, contentHash: input.contentHash, mode: input.mode, executionMode: ports.model.executionMode,
      workflowVersion: input.workflowVersion, promptVersion: input.promptVersion, modelConfiguration: ports.model.cacheKey ?? 'unversioned',
      state: 'idle', startedAt: now(), policy,
      calls: [], machineSnapshot: null, units: [], facts: [], items: [], draftFacts: {}, unitEvidence: {}, targets: [], assignments: [],
      evidence: { rows: [],questions:[],classOverview:classOverview(input), mappedQuestions: 0, totalQuestions: 0, mappedFullScore: 0, totalFullScore: 0, unmappedNumbers: [] },
      advice: [],teacherReport:null, skipped: [], checkpoints: [],validationAttempts:[],recognitionChecks:[] };
  }
  const current = run;
  await ports.store.beginRun?.(input,runId,options.taskContext??{},()=>leaseController.abort());
  current.validationAttempts??=[];
  current.recognitionChecks??=[];
  const analysisKey = ports.model.cacheKey ? await digest({ ownerId: input.ownerId, exam: input.workspace.exam,
    paper: input.workspace.paper, numbers: [...new Set(input.workspace.students.flatMap(s => s.questions.map(q => q.number)))],
    scope: input.testScope,
    validationLevel:input.validationLevel,
    segmentationVersion:input.segmentationVersion,
    recognitionPolicy:input.recognitionPolicy,
    knowledgeRevision: input.knowledgeRevision, modelConfiguration: ports.model.cacheKey, executionMode: ports.model.executionMode,
    workflowVersion: input.workflowVersion, promptVersion: input.promptVersion }) : null;
  const cached = analysisKey && shape.hasTargets && (!current.checkpoints.length || current.analysisCacheHit) ? await ports.store.loadAnalysis(input.ownerId,analysisKey) : null;
  if (current.analysisCacheHit && !cached) throw new Error('workflow_analysis_cache_missing');
  delete current.errorCode;
  delete current.errorStage;
  const actor = createWorkflowActor(input.mode);
  actor.start();
  const save = async () => { current.machineSnapshot = actor.getPersistedSnapshot(); await ports.store.save(input.ownerId,current); };
  const check = () => {
    if (signal?.aborted) throw new Error('workflow_cancelled');
    if (!options.resume&&now() - current.startedAt >= current.policy.maxRunMs) throw new Error('workflow_deadline');
  };
  const next = async (expected: WorkflowState) => {
    check(); actor.send({ type: 'NEXT' }); current.state = actorState(actor);
    if (current.state !== expected) throw new Error('workflow_invalid_transition');
    await save(); ports.onProgress?.(current.state);
  };
  const dataKeys=['units','facts','items','draftFacts','unitEvidence','targets','assignments','evidence','advice','teacherReport','skipped','validationAttempts','recognitionChecks'] as const;
  let replayCursor:number|null=null;
  const checkpoint = async (id: string, action: () => Promise<void>) => {
    if (current.checkpoints.includes(id)) return;
    check();
    if(current.frame){if(current.frame.id!==id)throw new Error('workflow_checkpoint_mismatch');
      Object.assign(current,structuredClone(current.frame.data));}
    else{current.frame={id,callStart:current.calls.length,data:Object.fromEntries(dataKeys.map(k=>[k,structuredClone(current[k])])) as CheckpointData};await save();}
    replayCursor=current.frame.callStart;
    await action();check();current.checkpoints.push(id);delete current.frame;replayCursor=null;await save();
  };
  let authorized=false;
  const authorize=async()=>{if(authorized||!shape.hasTargets||!ports.authorize)return;
    const cloud=await ports.authorize(input,current.policy,signal);authorized=true;
    if(cloud){current.cloud=cloud;await save();}
  };
  const names = input.workspace.students.map(s => s.name);
  let networkRetries = current.calls.filter(c => c.attempt > 1).length;
  const invoke: InvokeModel = async (stage,data) => {
    const request = modelRequest(stage,['extract','verifyFact','cloze','blindFill','exercise','solve'].includes(stage)
      ?{...data,subject:input.workspace.exam.subjectName}:data);
    assertAnonymous(request,names);
    const serialized = JSON.stringify(request), requestHash = await digest(request);
    const scopeId = typeof data.contentId === 'string' ? data.contentId
      : data.original && typeof data.original === 'object' && 'unitId' in data.original ? String(data.original.unitId) : 'batch';
    const callScope=stage==='recognize'?String(data.pageId):scopeId;
    for (let attempt = 1; attempt <= 2; attempt++) {
      check();
      if(replayCursor!==null&&replayCursor<current.calls.length){
        const previous=current.calls[replayCursor++];
        if(previous.stage!==stage||previous.scopeId!==callScope||previous.requestHash!==requestHash||previous.attempt!==attempt)throw new Error('workflow_replay_mismatch');
        if(previous.status==='completed'){
          const response=await ports.store.loadResponse?.(input.ownerId,runId,previous.callId);
          if(response){assertAnonymous(response.value,names);return structuredClone(response.value);}
          if(previous.errorCode)throw new Error(previous.errorCode);
          throw new Error('workflow_result_missing');
        }
        const continuation=current.calls[replayCursor];
        if(attempt===1&&continuation?.attempt===2&&continuation.status==='completed'&&continuation.requestHash===requestHash&&continuation.scopeId===callScope)continue;
        if(attempt===1&&options.retryUnknownCalls&&networkRetries<current.policy.maxNetworkRetries){networkRetries++;continue;}
        throw new Error('workflow_unknown_call_requires_decision');
      }
      if(now()-current.startedAt>=current.policy.maxRunMs)throw new Error('workflow_deadline');
      await authorize();
      const images=stage==='recognize'?1:0;
      const call = reserveCall(current.policy,current.calls,stage,requestHash,new TextEncoder().encode(serialized).byteLength,now(),current.startedAt,attempt,
        callScope,images);
      current.calls.push(call); await save();
      if(replayCursor!==null)replayCursor++;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: () => void = () => {};
      let receiptSaved=false;
      try {
        check();
        const interrupted = new Promise<never>((_,reject) => {
          onAbort = () => { controller.abort(); reject(new Error('workflow_cancelled')); };
          signal?.addEventListener('abort',onAbort,{ once: true });
          timer = setTimeout(() => { controller.abort(); reject(new Error('workflow_request_timeout')); },
            Math.min(current.policy.requestTimeoutMs,Math.max(1,current.policy.maxRunMs - (now() - current.startedAt))));
          if (signal?.aborted) onAbort();
        });
        const response: ModelResponse = await Promise.race([ports.model.call(structuredClone(request),controller.signal),interrupted]);
        recordUsage(call,response.usage?.totalTokens,now());
        try{if(JSON.stringify(response.value)?.length>100_000)return invalid();assertAnonymous(response.value,names);}
        catch(error){call.errorCode=error instanceof Error?error.message:'workflow_invalid_output';await save();throw error;}
        current.machineSnapshot=actor.getPersistedSnapshot();
        if(ports.store.completeCall)await ports.store.completeCall(input.ownerId,current,call.callId,response);else await save();
        receiptSaved=true;
        check();
        if (current.calls.reduce((sum,c) => sum + (c.usage ?? c.reservedTokens),0) > current.policy.maxTokens) throw new Error('workflow_budget_exceeded');
        return response.value;
      } catch (error) {
        if (call.status === 'pending'||(call.status==='completed'&&!receiptSaved&&!call.errorCode)) {
          call.status = 'unknown'; call.finishedAt = now();const code=error instanceof Error?error.message:'';
          call.errorCode=/^(workflow_|model_|paper_)[a-z_]+$/.test(code)?code:'workflow_failed';await save();
        }
        // Only explicitly classified network failures retry once; timeouts retain unknown status and pause.
        if (error instanceof Error && error.message === 'workflow_network_error' && attempt === 1 && networkRetries < current.policy.maxNetworkRetries) {
          networkRetries++; continue;
        }
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort',onAbort);
      }
    }
    throw new Error('workflow_network_error');
  };
  const modelUnit = (unitId: string) => {
    const u = current.units.find(u => u.unitId === unitId)!;
    return { unitId, sourceNumbers: u.sourceNumbers, stem: u.stem, material: u.material, options: u.options };
  };
  const extract = async (unitId: string,repair?:{facts:FactCandidate[];checks:KnowledgeFact['factCheck'][]}): Promise<FactCandidate[]> => (minimum?minimumFacts:validateFacts)(await invoke('extract',{
    subject: input.workspace.exam.subjectName, original: modelUnit(unitId),...(current.unitEvidence[unitId]?.length?{evidence:current.unitEvidence[unitId]}:{}),...(repair?{repair}:{}) }));
  try {
    await next('preflight'); await next('authorizing');
    if(!(options.resume&&ports.store.durable))await authorize();
    await next('rendering'); await next('recognizing');
    await checkpoint('recognition',async () => {
      if (cached) { current.analysisCacheHit = true; current.units = validateUnits(cached.units,input); current.draftFacts = cached.draftFacts;
        current.unitEvidence = cached.unitEvidence; current.facts = cached.facts; }
      else if (shape.hasTargets) current.units = validateUnits(await ports.prepareUnits(structuredClone(input),signal ?? new AbortController().signal,invoke,check=>current.recognitionChecks.push(check)),input);
    });
    await next('aligning');
    await checkpoint('alignment',async () => {
      for (const unit of current.units.filter(u => u.availability === 'isolated')) current.skipped.push({ sourceNumbers: unit.sourceNumbers, reason: 'recognition_ambiguous' });
      const numbers = input.testScope?.questionNumbers??[...new Set(input.workspace.students.flatMap(s => s.questions.map(q => q.number)))];
      for (const number of numbers.filter(n => !current.units.some(u => u.sourceNumbers.includes(n))))
        current.skipped.push({ sourceNumbers: [number], reason: shape.hasTargets ? 'recognition_missing' : 'no_targets_no_model_calls' });
    });
    await next('extracting');
    if(!cached&&ports.retrieveForOriginal)for(const unit of current.units.filter(u=>u.availability==='usable')){
      await checkpoint(`source-evidence:${unit.unitId}`,async()=>{
        current.unitEvidence[unit.unitId]=validateEvidence(await ports.retrieveForOriginal!(unit,signal??new AbortController().signal));
      });
    }
    if(batched&&!cached){
      await checkpoint('analysis-batch-plan',async()=>{
        const size=(units:typeof current.units)=>new TextEncoder().encode(JSON.stringify(modelRequest('extract',{subject:input.workspace.exam.subjectName,contentId:'extract-batch-plan',groups:units.map(u=>({unitId:u.unitId,original:sourceData(u),...(current.unitEvidence[u.unitId]?.length?{evidence:current.unitEvidence[u.unitId]}:{})}))}))).length;
        current.analysisBatches=planBatches(current.units.filter(u=>u.availability==='usable'),size,current.policy.maxInputBytes);
        const usable=current.units.filter(u=>u.availability==='usable').length;
        remainingFits(current,current.analysisBatches.length+(minimum?3*usable:3*Math.ceil(usable/2)+12*shape.units)+2);
      });
      for(const [i,ids]of current.analysisBatches!.entries())await checkpoint(`extract-batch:${i}`,()=>extractBatch(current,ids,invoke,input.workspace.exam.subjectName,minimum));
    }
    for (const unit of current.units.filter(u => !cached && u.availability === 'usable')) {
      if(batched)continue;
      await checkpoint(`extract:${unit.unitId}`,async () => {
        for (let attempt = 0; attempt < (minimum?1:2); attempt++) {
          try {
            const facts=await extract(unit.unitId);
            if(facts.length)current.draftFacts[unit.unitId]=facts;
            else current.skipped.push({sourceNumbers:unit.sourceNumbers,reason:'text_evidence_insufficient'});
            return;
          }
          catch (error) { if (!(error instanceof Error) || error.message !== 'workflow_invalid_output') throw error; }
        }
        current.skipped.push({ sourceNumbers: unit.sourceNumbers, reason: 'fact_extraction_failed' });
      });
    }
    await next('retrieving');
    for (const unit of current.units.filter(u => !cached && current.draftFacts[u.unitId])) {
      await checkpoint(`retrieve:${unit.unitId}`,async () => {
        // Old checkpoints may contain facts:[]. Complete that checkpoint locally
        // so a saved retrieval frame cannot block its valid neighbours on resume.
        const facts = current.draftFacts[unit.unitId];
        if (!facts.length) { current.unitEvidence[unit.unitId] = []; return; }
        const query = facts.map(f => f.knowledgePoint).join(' ');
        const retrieved=validateEvidence(await ports.retrieve(query,signal ?? new AbortController().signal));
        const seen=new Set<string>();
        current.unitEvidence[unit.unitId] = [...retrieved,...(current.unitEvidence[unit.unitId]??[])].filter(e=>{const key=`${e.documentId}:${e.page}:${e.text}`;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,6);
      });
    }
    await next('verifyingFacts');
    if(minimum&&!cached)await checkpoint('minimum-fact-drafts',async()=>{
      // TEMPORARILY DISABLED: fact verification and its repair loops.
      for(const unit of current.units)for(const [index,fact]of(current.draftFacts[unit.unitId]??[]).entries()){
        const evidence=current.unitEvidence[unit.unitId]??[];
        current.facts.push({...fact,factId:`${unit.unitId}-fact-${index+1}`,sourceNumbers:[...unit.sourceNumbers],unitIds:[unit.unitId],evidenceRefs:structuredClone(evidence),
          sourceMode:evidence.length?'library':'paper',reviewStatus:'unchecked',factCheck:{accurate:false,supported:false,inScope:false}});
      }
    });
    if(batched&&!cached&&!minimum){
      await checkpoint('verification-batch-plan',async()=>{
        const units=current.units.filter(u=>current.draftFacts[u.unitId]?.length);
        const size=(values:typeof current.units)=>new TextEncoder().encode(JSON.stringify(modelRequest('verifyFact',{subject:input.workspace.exam.subjectName,contentId:'verify-batch-plan',groups:verificationData(current,values.map(u=>u.unitId))}))).length;
        // Keep independent reasoning bounded to six facts per request while
        // still sharing extraction across larger groups.
        current.verificationBatches=planBatches(units,size,current.policy.maxInputBytes,current.policy.maxInputBytes,2);
        const facts=Object.values(current.draftFacts).reduce((n,f)=>n+f.length,0);
        remainingFits(current,3*current.verificationBatches.length+4*facts+2);
      });
      for(const [i,ids]of current.verificationBatches!.entries())await checkpoint(`verify-batch:${i}`,()=>verifyBatch(current,ids,invoke,input.workspace.exam.subjectName,save));
    }
    for (const unit of current.units.filter(u => !cached && current.draftFacts[u.unitId]?.length)) {
      if(batched||minimum)continue;
      await checkpoint(`verify:${unit.unitId}`,async () => {
        const id=(slot:number)=>`${unit.unitId}-fact-${slot}`;
        let pending=current.draftFacts[unit.unitId].map((fact,index)=>({fact,slot:index+1}))
          .filter(p=>!current.facts.some(f=>f.factId===id(p.slot)));
        const report=(slot:number,attempt:number,reason:WorkflowRun['validationAttempts'][number]['reason'])=>{
          current.validationAttempts.push({factId:id(slot),sourceNumbers:[...unit.sourceNumbers],stage:'verifyFact',attempt,reason});
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          if(!pending.length)break;
          let checks:KnowledgeFact['factCheck'][]=[];
          try {
            const evidence = current.unitEvidence[unit.unitId] ?? [];
            checks = list(object(await invoke('verifyFact',{ original: modelUnit(unit.unitId), facts: pending.map(p=>p.fact), evidence })).checks,3).map(validateFactCheck);
            if (checks.length !== pending.length) return invalid();
            const facts: KnowledgeFact[] = pending.map((p,i) => ({ ...p.fact, factId:id(p.slot),
              sourceNumbers: [...unit.sourceNumbers], unitIds: [unit.unitId], evidenceRefs: structuredClone(evidence),
              sourceMode: evidence.length ? 'library' : 'paper', factCheck: checks[i] }));
            // Passing facts survive every later repair, malformed response and cancellation.
            for(const fact of facts.filter(factPassed))if(!current.facts.some(f=>f.factId===fact.factId))current.facts.push(fact);
            const rejected=pending.flatMap((p,i)=>factPassed(facts[i])?[]:[{...p,check:checks[i]}]);
            for(const p of rejected){
              if(!p.check.accurate)report(p.slot,attempt+1,'fact_inaccurate');
              if(!p.check.supported)report(p.slot,attempt+1,'fact_unsupported');
              if(!p.check.inScope)report(p.slot,attempt+1,'fact_context_incomplete');
            }
            pending=rejected;checks=rejected.map(p=>p.check);
            await save();
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'workflow_invalid_output') throw error;
            pending.forEach(p=>report(p.slot,attempt+1,validationReason(error)));checks=[];
          }
          if (!pending.length||attempt === 1 || current.calls.filter(c => c.stage === 'extract' && c.scopeId===unit.unitId && c.attempt===1).length >= 2) break;
          try {
            const repaired=await extract(unit.unitId,checks.length?{facts:pending.map(p=>p.fact),checks}:undefined);
            if(!repaired.length)break;
            if(repaired.length!==pending.length)return invalid();
            pending=pending.map((p,i)=>({...p,fact:repaired[i]}));
            for(const p of pending)current.draftFacts[unit.unitId][p.slot-1]=p.fact;
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'workflow_invalid_output') throw error;
            pending.forEach(p=>report(p.slot,attempt+2,validationReason(error)));break;
          }
        }
        if (pending.length) current.skipped.push({ sourceNumbers: unit.sourceNumbers, reason: 'fact_check_failed' });
      });
    }
    await next('merging'); await checkpoint('merge',async () => { current.facts = mergeFacts(current.facts,minimum); });
    if (analysisKey && !cached && shape.hasTargets && !current.skipped.length) await ports.store.saveAnalysis(input.ownerId,analysisKey,{
      units: current.units, facts: current.facts, draftFacts: current.draftFacts, unitEvidence: current.unitEvidence });
    await next('selectingTargets'); await checkpoint('targets',async () => { current.targets = selectTargets(input,current.facts); });
    await next(input.mode === 'dictation' ? 'clozing' : 'generatingExercises');
    const generatePhase = async () => {
      if (['validatingCloze','validatingExercise'].includes(current.state)) {
        check(); actor.send({ type: 'MORE' }); current.state = actorState(actor); await save(); ports.onProgress?.(current.state);
      } else if (current.state === 'solving') {
        check(); actor.send({ type: 'RETRY' }); current.state = actorState(actor); await save(); ports.onProgress?.(current.state);
      }
    };
    const targetIds = new Set(current.targets.flatMap(t => t.selectedTargets));
    if(batched){
      const pending=current.facts.filter(f=>targetIds.has(f.factId)&&!current.checkpoints.includes(`item:${f.factId}`));
      const remaining=pending.reduce((sum,f)=>sum+Math.max(0,(minimum?1:4)-current.calls.filter(c=>c.scopeId===f.factId&&c.attempt===1).length),0);
      remainingFits(current,remaining+Math.max(0,2-current.calls.filter(c=>c.stage==='guidance'&&c.attempt===1).length));
    }
    for (const fact of current.facts.filter(f => targetIds.has(f.factId))) {
      await checkpoint(`item:${fact.factId}`,async () => {
        const scopedInvoke: InvokeModel = (stage,data) => invoke(stage,{ ...data,contentId: fact.factId });
        const report=(failure:WorkflowRun['validationAttempts'][number])=>{current.validationAttempts.push(failure);};
        if(minimum){
          // TEMPORARILY DISABLED: exact restoration, content scope, candidate
          // matching, blind filling / independent solving and content retries.
          try{
            const raw=input.mode==='dictation'?await scopedInvoke('cloze',{statement:fact.completeStatement,context:fact.context??'',conditions:fact.conditions,candidateAnswers:fact.candidateAnswers,attempt:1,repair:null})
              :await scopedInvoke('exercise',{fact:{knowledgePoint:fact.knowledgePoint,statement:fact.completeStatement,context:fact.context??'',conditions:fact.conditions},originals:current.units.filter(u=>fact.unitIds.includes(u.unitId)).map(u=>({stem:u.stem,material:u.material,options:u.options})),difficulty:input.settings.difficulty,attempt:1});
            current.items.push(input.mode==='dictation'?minimumCloze(raw,fact,`cloze-${fact.factId}`,1):minimumExercise(raw,fact,`exercise-${fact.factId}`,1));
          }catch(error){if(!(error instanceof Error)||error.message!=='workflow_invalid_output')throw error;current.skipped.push({sourceNumbers:fact.sourceNumbers,reason:'item_validation_failed'});}
          return;
        }
        const item = input.mode === 'dictation'
          ? await generateDictation(fact,scopedInvoke,{ generating: generatePhase, validating: () => next('validatingCloze') },report)
          : await generateExercise(fact,input,current.units,scopedInvoke,{ generating: generatePhase,
            solving: () => next('solving'), validating: () => next('validatingExercise') },report);
        if (item) current.items.push(item);
        if (!item || item.status !== 'passed') current.skipped.push({ sourceNumbers: fact.sourceNumbers, reason: 'item_validation_failed' });
      });
    }
    if (current.state === 'generatingExercises') { await next('solving'); await next('validatingExercise'); }
    else if (current.state === 'clozing') await next('validatingCloze');
    await next('assembling'); await checkpoint('assignments',async () => {
      const seen = new Set<string>();
      for (const item of current.items) {
        const key = item.mode === 'exercise' ? normalize(item.stem + item.material) : JSON.stringify(item.parts);
        if (!minimum&&seen.has(key)) { item.status = 'failed'; current.skipped.push({ sourceNumbers: item.sourceNumbers, reason: 'duplicate_item' }); }
        else if (item.status === 'passed') seen.add(key);
      }
      current.assignments = assignStudents(input,current.targets,current.items,current.facts);
    });
    await next('aggregatingEvidence'); await checkpoint('evidence',async () => { current.evidence = teachingEvidence(input,current.facts); });
    if(input.testScope){
      check();actor.send({type:'SKIP_GUIDANCE'});current.state=actorState(actor);current.advice=[];current.teacherReport=null;await save();
    }else{
    await next('writingGuidance'); await checkpoint('advice',async () => {
      if(minimum){
        // TEMPORARILY DISABLED: strict narrative/coverage checks and retries.
        if(current.evidence.mappedQuestions&&shape.hasTargets){current.teacherReport=minimumReport(await invoke('guidance',{...teachingReportInput(current.evidence),attempt:1}),current.evidence);}
        else current.teacherReport=minimumReport({},current.evidence);
        current.advice=current.teacherReport.priorities;return;
      }
      // A single-question/subset test is only a content test. Teacher guidance
      // belongs to one final report of the entire frozen exam, never per item.
      if(current.evidence.mappedQuestions&&shape.hasTargets) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try { current.teacherReport=validateClassTeachingReport(await invoke('guidance',{...teachingReportInput(current.evidence),attempt}),current.evidence);
            current.advice=current.teacherReport.priorities;return; }
          catch (error) { if (!(error instanceof Error) || error.message !== 'workflow_invalid_output') throw error; }
        }
      }
      current.teacherReport=templateClassTeachingReport(current.evidence);current.advice=current.teacherReport.priorities;
    });
    await next('validatingGuidance');
    }
    if (!minimum&&(current.assignments.some(a => a.status === 'partial')||current.skipped.some(s=>s.reason==='fact_check_failed'))) { actor.send({ type: 'PARTIAL' }); current.state = 'partial'; await save(); }
    else await next('contentReady');
  } catch (error) {
    const code = workflowErrorCode(error);
    current.errorCode = code;
    current.errorStage=current.state;
    const event = code === 'workflow_cancelled' ? 'CANCEL' : ['workflow_request_timeout','workflow_deadline','workflow_network_error','workflow_storage_failed','workflow_unknown_call_requires_decision','workflow_result_missing','workflow_budget_estimate_exceeded','workflow_batch_input_exceeded','workflow_budget_exceeded','model_output_truncated','model_service_unavailable','model_response_aborted'].includes(code) ? 'PAUSE' : 'FAIL';
    actor.send({ type: event }); current.state = actorState(actor);
    await save(); ports.onProgress?.(current.state);
  } finally {
    actor.stop();
    if(shape.hasTargets&&ports.release){try{const status=await ports.release(current.state==='cancelled'?'cancelled':current.state==='failed'||current.state==='recoverable'?'failed':'partial',current);
      if(status&&current.cloud){current.cloud.status=status;await ports.store.save(input.ownerId,current);}}
      catch{current.errorCode=current.errorCode??'workflow_release_pending';await ports.store.save(input.ownerId,current);}}
    if(ports.persistDiagnostics){try{await ports.persistDiagnostics(structuredClone(current));}catch{current.errorCode=current.errorCode??'workflow_diagnostic_write_failed';}}
  }
  return structuredClone(current);
}
