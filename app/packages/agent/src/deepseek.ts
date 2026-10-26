import type { ModelProvider,ModelRequest } from './index.ts';
export const DEEPSEEK_MODEL='deepseek-flash';
export interface DeepseekStatus {configured:boolean;quotaExhausted:boolean;model:string;usage:{promptTokens:number;completionTokens:number;totalTokens:number}}
export function deepseekProvider(transport:(request:ModelRequest)=>Promise<unknown>):ModelProvider {
  let exhausted=false;
  return {mode:'real',async call(request){
    if(exhausted)throw new Error('model_quota_exhausted');
    try{return await transport(structuredClone(request));}
    catch(error){
      const code=error instanceof Error?error.message:String(error);
      if(code==='model_quota_exhausted')exhausted=true;
      const known=['model_quota_exhausted','model_auth_failed','model_key_required','model_invalid_key','model_rate_limited','model_busy','model_network_failed','model_service_failed','model_output_truncated','invalid_model_output','invalid_model_request','model_privacy_blocked','model_no_workspace'];
      throw new Error(known.includes(code)?code:'model_service_failed');
    }
  }};
}
