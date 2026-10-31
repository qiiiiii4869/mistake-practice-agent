import type {ValidationReason,WorkflowRun,RecognitionReason} from './types.ts';

export const recognitionMessages:Record<RecognitionReason,string>={matched:'两次独立识题一致',format_only:'两次识题仅有标点或排版格式差异',
  content_mismatch:'多次识题的实质内容仍不一致，未继续提炼知识点',low_confidence:'题目识别置信度不足，未继续提炼知识点',
  duplicate_number:'存在未确认处理规则的重复题号',warning:'当前题目仍有识别警告或条件缺失',missing:'所选页未找到足够的完整题目识别结果',
  invalid_structure:'卷面识别返回结构不完整'};

export const validationMessages:Record<ValidationReason,string>={
  fact_inaccurate:'独立核验认为知识句存在事实错误',fact_unsupported:'独立核验未找到足够的文字或学科依据',fact_context_incomplete:'独立核验认为背景、限定条件或适用范围不完整',
  repair_not_applied:'模型修复仍使用前一轮未通过的挖空位置，改用程序候选重新检查',
  invalid_structure:'模型返回的字段或数据结构不完整',unsupported_formula:'包含当前排版组件不支持的公式',
  duplicate_blank_id:'填空编号重复',answer_not_accepted:'可接受答案列表缺少标准答案',answer_not_candidate:'挖空答案不是完整知识句中的有效片段',
  non_specific_blank:'挖空只考泛用动词或可任意替换的举例，缺少明确知识目标',
  condition_removed:'挖空删除了必要限定条件',statement_not_restored:'填回答案后无法逐字还原完整知识句',invalid_blank_count:'空数不符合每条一至两个空的限制',
  insufficient_context:'保留的上下文不足',answer_visible:'答案已出现在同条可见文本中',blind_fill_ambiguous:'独立盲填发现多个合理答案',
  blind_fill_missing_conditions:'独立盲填认为必要条件不足',blind_fill_mapping:'盲填返回的空号或数量不对应',blind_fill_answer_mismatch:'盲填答案不在已声明的可接受答案中',
  unsupported_exercise_type:'题型暂不支持',invalid_options:'选项、答案集合或题型结构不一致',missing_diagram:'题干引用了未提供的图形',
  original_copied:'题干与原题完全相同',invalid_duration:'预计作答时长不符合限制',invalid_numeric_answer:'计算结果、单位或显示答案不一致',
  solve_incomplete:'独立解题认为条件不足或无法求解',solve_out_of_scope:'独立解题认为超出知识目标范围',solve_too_similar:'独立解题认为过于照搬原题',
  solve_answer_mismatch:'独立解题的答案集合不一致',solve_scoring_mismatch:'独立简答评分点不一致或存在矛盾',solve_numeric_mismatch:'独立计算结果或单位不一致',
};
export const failureMessages:Record<string,string>={recognition_ambiguous:'卷面多次识别仍有歧义',recognition_missing:'所选页中未找到完整题干',
  no_targets_no_model_calls:'本次没有纳入的失分目标，未调用模型',text_evidence_insufficient:'仅凭题干和选项文字无法提炼可核验知识点，已跳过图示依赖内容',fact_extraction_failed:'知识句提炼未通过结构检查',fact_check_failed:'知识句事实或适用范围未通过核验',
  item_validation_failed:'该知识点的候选内容未通过检查',item_generation_exhausted:'该考点生成已发起3次仍失败，已跳过并继续其他题',duplicate_item:'与已通过的内容重复'};
export function workflowAudit(run:WorkflowRun){
  return {schemaVersion:1,runId:run.runId,mode:run.mode,state:run.state,startedAt:run.startedAt,
    callCount:run.calls.length,knownTokens:run.calls.reduce((n,c)=>n+(c.usage??0),0),unknownCalls:run.calls.filter(c=>c.usage===null).length,
    passedItems:run.items.filter(i=>i.status==='passed').length,failedItems:run.items.filter(i=>i.status!=='passed').length,
    skippedItems:run.skipped.length,coverage:run.assignments.filter(a=>a.rawWeakNumbers.length).map(a=>a.coverage),
    calls:run.calls.map(c=>({stage:c.stage,status:c.status,attempt:c.attempt,usage:c.usage,startedAt:c.startedAt,finishedAt:c.finishedAt??null})),
    validations:run.validationAttempts.map(v=>({sourceNumbers:v.sourceNumbers,stage:v.stage,attempt:v.attempt,reason:v.reason})),
    recognitions:run.recognitionChecks.map(c=>({sourceNumbers:c.sourceNumbers,pageIndex:c.pageIndex,status:c.status,reason:c.reason,readings:c.readings})),
    skipped:run.skipped.filter(s=>Object.hasOwn(failureMessages,s.reason)).map(s=>({sourceNumbers:s.sourceNumbers,reason:s.reason})),
    errorCode:run.errorCode??null};
}
