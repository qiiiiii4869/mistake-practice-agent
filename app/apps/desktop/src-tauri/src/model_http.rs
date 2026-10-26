use serde_json::Value;
use std::time::Duration;

pub(crate) async fn call(key:&str,payload:&Value)->Result<Value,String>{
    // Fixed official destination, no redirects, system proxy, remote assets or retry.
    let client=reqwest::Client::builder().https_only(true).no_proxy().redirect(reqwest::redirect::Policy::none()).retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(180)).build().map_err(|_|"model_network_failed")?;
    let mut response=client.post(crate::model::ENDPOINT).bearer_auth(key).json(payload).send().await.map_err(|_|"model_network_failed")?;
    let status=response.status().as_u16();
    if response.content_length().is_some_and(|n|n>2*1024*1024){return Err("invalid_model_output".into());}
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|"model_network_failed")?{
        if bytes.len()+chunk.len()>2*1024*1024{return Err("invalid_model_output".into());}bytes.extend_from_slice(&chunk);
    }
    let body=serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
    if !(200..300).contains(&status){return Err(crate::model::status_error(status,&body).into());}
    if bytes.windows(key.len()).any(|w|w==key.as_bytes()){return Err("invalid_model_output".into());}
    Ok(body)
}
