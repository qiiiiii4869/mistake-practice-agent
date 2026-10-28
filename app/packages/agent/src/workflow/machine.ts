import { createActor, setup, type SnapshotFrom } from 'xstate';
import type { GenerationMode, WorkflowState } from './types.ts';

export const workflowMachine = setup({ types: {} as {
  context: { mode: GenerationMode }; input: { mode: GenerationMode };
  events: { type: 'NEXT' | 'MORE' | 'RETRY' | 'CANCEL' | 'FAIL' | 'PARTIAL' | 'PAUSE' | 'RESUME'|'SKIP_GUIDANCE' };
}}).createMachine({
  id: 'reportWorkflow', initial: 'idle', context: ({ input }) => ({ mode: input.mode }),
  on: { CANCEL: '.cancelled', FAIL: '.failed', PARTIAL: '.partial', PAUSE: '.recoverable' },
  states: {
    idle: { on: { NEXT: 'preflight' } }, preflight: { on: { NEXT: 'authorizing' } },
    authorizing: { on: { NEXT: 'rendering' } }, rendering: { on: { NEXT: 'recognizing' } },
    recognizing: { on: { NEXT: 'aligning' } }, aligning: { on: { NEXT: 'extracting' } },
    extracting: { on: { NEXT: 'retrieving' } }, retrieving: { on: { NEXT: 'verifyingFacts' } },
    verifyingFacts: { on: { NEXT: 'merging' } }, merging: { on: { NEXT: 'selectingTargets' } },
    selectingTargets: { on: { NEXT: [ { guard: ({ context }) => context.mode === 'dictation', target: 'clozing' }, { target: 'generatingExercises' } ] } },
    clozing: { on: { NEXT: 'validatingCloze' } }, validatingCloze: { on: { NEXT: 'assembling', MORE: 'clozing' } },
    generatingExercises: { on: { NEXT: 'solving' } }, solving: { on: { NEXT: 'validatingExercise', RETRY: 'generatingExercises' } },
    validatingExercise: { on: { NEXT: 'assembling', MORE: 'generatingExercises' } }, assembling: { on: { NEXT: 'aggregatingEvidence' } },
    aggregatingEvidence: { on: { NEXT: 'writingGuidance',SKIP_GUIDANCE:'validatingGuidance' } }, writingGuidance: { on: { NEXT: 'validatingGuidance' } },
    validatingGuidance: { on: { NEXT: 'contentReady' } },
    // A content checkpoint is not an exported/settled report. Export stages arrive in phase B.
    contentReady: { type: 'final' }, partial: { type: 'final' }, failed: { type: 'final' }, cancelled: { type: 'final' },
    recoverable: { on: { RESUME: 'preflight' } },
  },
});
export function createWorkflowActor(mode: GenerationMode, snapshot?: unknown) {
  return createActor(workflowMachine, { input: { mode }, ...(snapshot ? { snapshot: snapshot as SnapshotFrom<typeof workflowMachine> } : {}) });
}
export function actorState(actor: ReturnType<typeof createWorkflowActor>): WorkflowState {
  return actor.getSnapshot().value as WorkflowState;
}
