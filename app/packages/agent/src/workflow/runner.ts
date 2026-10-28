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
import type { BudgetPolicy, FactCandidate, FrozenInput, InvokeModel, KnowledgeFact, ModelResponse, WorkflowPorts, WorkflowRun, WorkflowState } from './types.ts';
import { factPassed, invalid, list, normalize, object, validateEvidence, validateFactCheck, validateFacts, validateUnits,validationReason } from './validators.ts';

export interface RunOptions {
  input: FrozenInput; ports: WorkflowPorts; runId?: string; signal?: AbortSignal;
  policy?: Partial<BudgetPolicy>; resume?: boolean; retryUnknownCalls?: boolean;
}
const activeOwners = new Map<string,{ runId: string; hash: string; promise: Promise<WorkflowRun> }>();

export function runWorkflow(options: RunOptions): Promise<WorkflowRun> {
  const input = structuredClone(options.input), runId = options.runId ?? crypto.randomUUID();
  const active = activeOwners.get(input.ownerId);
  if (active) {
    if (active.runId === runId && active.hash === input.contentHash) return active.promise;
    return Promise.reject(new Error('workflow_busy'));
  }
  const promise = execute({ ...options, input, runId }).finally(() => activeOwners.delete(input.ownerId));
  activeOwners.set(input.ownerId,{ runId, hash: input.contentHash, promise });
  return promise;
}

async function execute(options: RunOptions & { runId: string }): Promise<WorkflowRun> {
  const { input, ports, runId, signal } = options, now = ports.now ?? Date.now;
  await assertFrozen(input);
  if (ports.model.executionMode === 'real' && (!ports.authorize || !ports.release)) throw new Error('workflow_authorization_required');
  if (!/^[\w-]{1,100}$/.test(runId)) throw new Error('workflow_invalid_run_id');
  const shape = preflight(input), estimated = estimateBudget(input.mode,shape.hasTargets ? shape.pages : 0,shape.hasTargets ? shape.units : 0);
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
    if (run.calls.some(c => c.status !== 'completed') && !options.retryUnknownCalls) throw new Error('workflow_unknown_call_requires_decision');
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
  current.validationAttempts??=[];
  current.recognitionChecks??=[];
  const analysisKey = ports.model.cacheKey ? await digest({ ownerId: input.ownerId, exam: input.workspace.exam,
    paper: input.workspace.paper, numbers: [...new Set(input.workspace.students.flatMap(s => s.questions.map(q => q.number)))],
    scope: input.testScope,
    knowledgeRevision: input.knowledgeRevision, modelConfiguration: ports.model.cacheKey, executionMode: ports.model.executionMode,
    workflowVersion: input.workflowVersion, promptVersion: input.promptVersion }) : null;
  const cached = analysisKey && shape.hasTargets && (!current.checkpoints.length || current.analysisCacheHit) ? await ports.store.loadAnalysis(input.ownerId,analysisKey) : null;
  if (current.analysisCacheHit && !cached) throw new Error('workflow_analysis_cache_missing');
  delete current.errorCode;
  const actor = createWorkflowActor(input.mode);
  actor.start();
  const save = async () => { current.machineSnapshot = actor.getPersistedSnapshot(); await ports.store.save(input.ownerId,current); };
  const check = () => {
    if (signal?.aborted) throw new Error('workflow_cancelled');
    if (now() - current.startedAt >= current.policy.maxRunMs) throw new Error('workflow_deadline');
  };
  const next = async (expected: WorkflowState) => {
    check(); actor.send({ type: 'NEXT' }); current.state = actorState(actor);
    if (current.state !== expected) throw new Error('workflow_invalid_transition');
    await save(); ports.onProgress?.(current.state);
  };
  const checkpoint = async (id: string, action: () => Promise<void>) => {
    if (current.checkpoints.includes(id)) return;
    check(); await action(); check(); current.checkpoints.push(id); await save();
  };
  const names = input.workspace.students.map(s => s.name);
  let networkRetries = current.calls.filter(c => c.attempt > 1).length;
  const invoke: InvokeModel = async (stage,data) => {
    const request = modelRequest(stage,data);
    assertAnonymous(request,names);
    const serialized = JSON.stringify(request), requestHash = await digest(request);
    const scopeId = typeof data.contentId === 'string' ? data.contentId
      : data.original && typeof data.original === 'object' && 'unitId' in data.original ? String(data.original.unitId) : 'batch';
    for (let attempt = 1; attempt <= 2; attempt++) {
      check();
      const images=stage==='recognize'?1:0;
      const call = reserveCall(current.policy,current.calls,stage,requestHash,new TextEncoder().encode(serialized).byteLength,now(),current.startedAt,attempt,
        stage==='recognize'?String(data.pageId):scopeId,images);
      current.calls.push(call); await save();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: () => void = () => {};
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
        await save(); check();
        if (current.calls.reduce((sum,c) => sum + (c.usage ?? c.reservedTokens),0) > current.policy.maxTokens) throw new Error('workflow_budget_exceeded');
        if (JSON.stringify(response.value)?.length > 100_000) return invalid();
        assertAnonymous(response.value,names);
        return response.value;
      } catch (error) {
        if (call.status === 'pending') { call.status = 'unknown'; call.finishedAt = now(); await save(); }
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
  const extract = async (unitId: string,repair?:{facts:FactCandidate[];checks:KnowledgeFact['factCheck'][]}): Promise<FactCandidate[]> => validateFacts(await invoke('extract',{
    subject: input.workspace.exam.subjectName, original: modelUnit(unitId),...(repair?{repair}:{}) }));
  try {
    await next('preflight'); await next('authorizing');
    if(shape.hasTargets&&ports.authorize)await ports.authorize(input,current.policy,signal??new AbortController().signal);
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
    for (const unit of current.units.filter(u => !cached && u.availability === 'usable')) {
      await checkpoint(`extract:${unit.unitId}`,async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
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
        const query = current.draftFacts[unit.unitId].map(f => f.knowledgePoint).join(' ');
        current.unitEvidence[unit.unitId] = validateEvidence(await ports.retrieve(query,signal ?? new AbortController().signal));
      });
    }
    await next('verifyingFacts');
    for (const unit of current.units.filter(u => !cached && current.draftFacts[u.unitId])) {
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
    await next('merging'); await checkpoint('merge',async () => { current.facts = mergeFacts(current.facts); });
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
    for (const fact of current.facts.filter(f => targetIds.has(f.factId))) {
      await checkpoint(`item:${fact.factId}`,async () => {
        const scopedInvoke: InvokeModel = (stage,data) => invoke(stage,{ ...data,contentId: fact.factId });
        const report=(failure:WorkflowRun['validationAttempts'][number])=>{current.validationAttempts.push(failure);};
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
        if (seen.has(key)) { item.status = 'failed'; current.skipped.push({ sourceNumbers: item.sourceNumbers, reason: 'duplicate_item' }); }
        else if (item.status === 'passed') seen.add(key);
      }
      current.assignments = assignStudents(input,current.targets,current.items,current.facts);
    });
    await next('aggregatingEvidence'); await checkpoint('evidence',async () => { current.evidence = teachingEvidence(input,current.facts); });
    if(input.testScope){
      check();actor.send({type:'SKIP_GUIDANCE'});current.state=actorState(actor);current.advice=[];current.teacherReport=null;await save();
    }else{
    await next('writingGuidance'); await checkpoint('advice',async () => {
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
    if (current.assignments.some(a => a.status === 'partial')||current.skipped.some(s=>s.reason==='fact_check_failed')) { actor.send({ type: 'PARTIAL' }); current.state = 'partial'; await save(); }
    else await next('contentReady');
  } catch (error) {
    const code = error instanceof Error ? error.message : 'workflow_failed';
    current.errorCode = /^(workflow_|model_|paper_)[a-z_]+$/.test(code) ? code : 'workflow_failed';
    const event = code === 'workflow_cancelled' ? 'CANCEL' : ['workflow_request_timeout','workflow_deadline','workflow_network_error'].includes(code) ? 'PAUSE' : 'FAIL';
    actor.send({ type: event }); current.state = actorState(actor);
    await save(); ports.onProgress?.(current.state);
  } finally {
    actor.stop();
    if(shape.hasTargets&&ports.release){try{await ports.release(current.state==='cancelled'?'cancelled':current.state==='failed'||current.state==='recoverable'?'failed':'partial');}
      catch{current.errorCode=current.errorCode??'workflow_release_pending';await ports.store.save(input.ownerId,current);}}
    if(ports.persistDiagnostics){try{await ports.persistDiagnostics(structuredClone(current));}catch{current.errorCode=current.errorCode??'workflow_diagnostic_write_failed';}}
  }
  return structuredClone(current);
}
