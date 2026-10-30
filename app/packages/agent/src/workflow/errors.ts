// Tauri rejects with strings; providers may reject with Error objects. Persist
// only approved symbolic codes, never raw messages, payloads, names or secrets.
const boundaryCodes=new Set([
  'invalid_input','invalid_model_request','invalid_model_output','storage_conflict','storage_failed','state_unavailable',
  'session_required','session_expired','credits_exhausted','generation_busy','generation_expired','generation_not_found',
  'account_network_failed','account_service_failed','account_invalid_response','account_disabled','account_inactive',
  'local_window_required','https_required','idempotency_conflict','knowledge_invalid_query',
]);
export function workflowErrorCode(error:unknown):string{
 const code=typeof error==='string'?error:error instanceof Error?error.message:'';
 return /^(workflow_|model_|paper_)[a-z_]{1,80}$/.test(code)||boundaryCodes.has(code)?code:'workflow_failed';
}
