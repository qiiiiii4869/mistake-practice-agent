use serde::{Deserialize,Serialize};
use std::io::Write;
use tauri::WebviewWindow;

#[derive(Deserialize,Serialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Audit{
    schema_version:u32,run_id:String,mode:String,state:String,started_at:u64,call_count:usize,known_tokens:u64,unknown_calls:usize,
    passed_items:usize,failed_items:usize,skipped_items:usize,coverage:Vec<f64>,calls:Vec<Call>,validations:Vec<Validation>,error_code:Option<String>,
    #[serde(default)]recognitions:Vec<Recognition>,#[serde(default)]skipped:Vec<Skipped>,
}
#[derive(Deserialize,Serialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Call{stage:String,status:String,attempt:u32,usage:Option<u64>,started_at:u64,finished_at:Option<u64>}
#[derive(Deserialize,Serialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Validation{source_numbers:Vec<String>,stage:String,attempt:u32,reason:String}
#[derive(Deserialize,Serialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Recognition{source_numbers:Vec<String>,page_index:u32,status:String,reason:String,readings:Vec<Reading>}
#[derive(Deserialize,Serialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Reading{attempt:u32,matches:usize,confidence:String,warning_count:usize,valid:bool}
#[derive(Deserialize,Serialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Skipped{source_numbers:Vec<String>,reason:String}
fn valid_numbers(numbers:&[String])->bool{!numbers.is_empty()&&numbers.len()<=80&&numbers.iter().all(|n|!n.is_empty()&&n.len()<=40&&n.chars().all(|c|c.is_ascii_digit()||c=='.'||c=='．'))}
fn validate(report:&Audit)->Result<(),String>{
    let bad=||"workflow_diagnostic_invalid".to_owned();
    let uuid=report.run_id.len()==36&&report.run_id.bytes().all(|b|b.is_ascii_hexdigit()||b==b'-');
    if report.schema_version!=1||!uuid||!["dictation","exercise"].contains(&report.mode.as_str())
      ||!["contentReady","partial","failed","cancelled","recoverable"].contains(&report.state.as_str())
      ||report.calls.len()>300||report.call_count!=report.calls.len()||report.coverage.len()>100||report.coverage.iter().any(|v|!v.is_finite()||!(0.0..=1.0).contains(v))
      ||report.validations.len()>500||report.passed_items>240||report.failed_items>240||report.skipped_items>500{return Err(bad());}
    let mut tokens=0u64;let mut unknown=0;
    for call in &report.calls{
      if !["recognize","extract","verifyFact","cloze","blindFill","exercise","solve","guidance"].contains(&call.stage.as_str())
        ||!["pending","completed","unknown"].contains(&call.status.as_str())||!(1..=2).contains(&call.attempt){return Err(bad());}
      match call.usage{Some(n)=>{tokens=tokens.checked_add(n).ok_or_else(bad)?;},None=>unknown+=1}
    }
    if tokens!=report.known_tokens||unknown!=report.unknown_calls{return Err(bad());}
    if report.recognitions.len()>2400||report.skipped.len()>500{return Err(bad());}
    for r in &report.recognitions{
      if !valid_numbers(&r.source_numbers)||!(1..=30).contains(&r.page_index)||!["usable","isolated","missing"].contains(&r.status.as_str())
        ||!["matched","format_only","content_mismatch","low_confidence","duplicate_number","warning","missing","invalid_structure"].contains(&r.reason.as_str())
        ||r.readings.len()<2||r.readings.len()>3||r.readings.iter().any(|v|!(1..=3).contains(&v.attempt)||v.matches>100||v.warning_count>120||!["high","low","missing"].contains(&v.confidence.as_str())){return Err(bad());}
    }
    for s in &report.skipped{if !valid_numbers(&s.source_numbers)||!["recognition_ambiguous","recognition_missing","no_targets_no_model_calls","text_evidence_insufficient","fact_extraction_failed","fact_check_failed","item_validation_failed","duplicate_item"].contains(&s.reason.as_str()){return Err(bad());}}
    let reasons=["fact_inaccurate","fact_unsupported","fact_context_incomplete","invalid_structure","unsupported_formula","duplicate_blank_id","answer_not_accepted","answer_not_candidate","non_specific_blank","condition_removed",
      "statement_not_restored","invalid_blank_count","insufficient_context","answer_visible","blind_fill_ambiguous","blind_fill_missing_conditions",
      "blind_fill_mapping","blind_fill_answer_mismatch","unsupported_exercise_type","invalid_options","missing_diagram","original_copied","invalid_duration",
      "invalid_numeric_answer","solve_incomplete","solve_out_of_scope","solve_too_similar","solve_answer_mismatch","solve_scoring_mismatch","solve_numeric_mismatch","repair_not_applied"];
    for v in &report.validations{
      if !["verifyFact","cloze","blindFill","exercise","solve"].contains(&v.stage.as_str())||!(1..=2).contains(&v.attempt)||!reasons.contains(&v.reason.as_str())
        ||v.source_numbers.is_empty()||v.source_numbers.len()>80||v.source_numbers.iter().any(|n|n.is_empty()||n.len()>40||!n.chars().all(|c|c.is_ascii_digit()||c=='.'||c=='．')){return Err(bad());}
    }
    if report.error_code.as_ref().is_some_and(|e|e.len()>80||e.is_empty()||!e.bytes().all(|b|b.is_ascii_lowercase()||b==b'_')){return Err(bad());}
    Ok(())
}
#[tauri::command]pub(crate) fn workflow_save_diagnostic(window:WebviewWindow,app:tauri::AppHandle,report:Audit)->Result<(),String>{
    super::require_main(&window)?;validate(&report)?;
    let path=super::account::user_folder(&app)?.join("diagnostics").join("workflow-runs");
    std::fs::create_dir_all(&path).map_err(|_|"workflow_diagnostic_write_failed")?;
    let bytes=serde_json::to_vec_pretty(&report).map_err(|_|"workflow_diagnostic_invalid")?;
    if bytes.len()>256*1024{return Err("workflow_diagnostic_invalid".into());}
    let mut file=tempfile::NamedTempFile::new_in(&path).map_err(|_|"workflow_diagnostic_write_failed")?;
    file.write_all(&bytes).map_err(|_|"workflow_diagnostic_write_failed")?;
    file.as_file().sync_all().map_err(|_|"workflow_diagnostic_write_failed")?;
    file.persist(path.join(format!("{}.json",report.run_id))).map_err(|_|"workflow_diagnostic_write_failed")?;
    Ok(())
}

#[cfg(test)]mod tests{
    use super::*;use serde_json::json;
    fn sample()->serde_json::Value{json!({"schemaVersion":1,"runId":"00000000-0000-4000-8000-000000000001","mode":"dictation","state":"partial","startedAt":1,
      "callCount":1,"knownTokens":20,"unknownCalls":0,"passedItems":2,"failedItems":0,"skippedItems":1,"coverage":[0.6666667],
      "calls":[{"stage":"cloze","status":"completed","attempt":1,"usage":20,"startedAt":1,"finishedAt":2}],
      "validations":[{"sourceNumbers":["1"],"stage":"cloze","attempt":1,"reason":"statement_not_restored"}],"errorCode":null})}
    #[test]fn diagnostic_schema_accepts_counts_and_rejects_private_or_unstructured_data(){
      let report:Audit=serde_json::from_value(sample()).unwrap();validate(&report).unwrap();
      let mut v=sample();v["validations"][0]["reason"]=json!("non_specific_blank");validate(&serde_json::from_value::<Audit>(v).unwrap()).unwrap();
      for reason in ["fact_inaccurate","fact_unsupported","fact_context_incomplete"]{let mut v=sample();v["validations"][0]["stage"]=json!("verifyFact");v["validations"][0]["reason"]=json!(reason);validate(&serde_json::from_value::<Audit>(v).unwrap()).unwrap();}
      for field in ["modelKey","names","students","answers","response","instruction"]{let mut v=sample();v[field]=json!("private");assert!(serde_json::from_value::<Audit>(v).is_err());}
      let mut v=sample();v["validations"][0]["reason"]=json!("arbitrary-provider-text");assert!(validate(&serde_json::from_value::<Audit>(v).unwrap()).is_err());
      let mut v=sample();v["knownTokens"]=json!(0);assert!(validate(&serde_json::from_value::<Audit>(v).unwrap()).is_err());
      let mut v=sample();v["validations"][0]["sourceNumbers"]=json!(["不能写入姓名"]);assert!(validate(&serde_json::from_value::<Audit>(v).unwrap()).is_err());
    }
    #[test]fn recognition_diagnostic_preserves_reason_without_transcribing_source_material(){
      let mut v=sample();v["recognitions"]=json!([{"sourceNumbers":["3"],"pageIndex":1,"status":"isolated","reason":"content_mismatch",
        "readings":[{"attempt":1,"matches":1,"confidence":"high","warningCount":0,"valid":true},{"attempt":2,"matches":1,"confidence":"high","warningCount":0,"valid":true}]}]);
      v["skipped"]=json!([{"sourceNumbers":["3"],"reason":"recognition_ambiguous"}]);
      let r:Audit=serde_json::from_value(v.clone()).unwrap();validate(&r).unwrap();
      v["skipped"][0]["reason"]=json!("text_evidence_insufficient");validate(&serde_json::from_value::<Audit>(v.clone()).unwrap()).unwrap();
      v["recognitions"][0]["readings"][0]["stem"]=json!("private original text");assert!(serde_json::from_value::<Audit>(v).is_err());
    }
}
