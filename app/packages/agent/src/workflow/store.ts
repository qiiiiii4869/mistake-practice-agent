import type { AnalysisCache, WorkflowRun, WorkflowStore } from './types.ts';

// A clone-on-read/write port for deterministic tests. Durable SQLite is phase C.
export class MemoryWorkflowStore implements WorkflowStore {
  private records = new Map<string, WorkflowRun>();
  private analysis = new Map<string, AnalysisCache>();
  async save(ownerId: string, run: WorkflowRun): Promise<void> {
    this.records.set(`${ownerId}:${run.runId}`, structuredClone(run));
  }
  async load(ownerId: string, runId: string): Promise<WorkflowRun | null> {
    return structuredClone(this.records.get(`${ownerId}:${runId}`) ?? null);
  }
  async loadAnalysis(ownerId: string, cacheKey: string): Promise<AnalysisCache | null> {
    return structuredClone(this.analysis.get(`${ownerId}:${cacheKey}`) ?? null);
  }
  async saveAnalysis(ownerId: string, cacheKey: string, value: AnalysisCache): Promise<void> {
    this.analysis.set(`${ownerId}:${cacheKey}`,structuredClone(value));
  }
}
