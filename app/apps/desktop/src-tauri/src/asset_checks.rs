// Verify packaged modules using the same MIME detector as Tauri's asset responder.
#[cfg(test)]mod tests {
    use std::{fs,path::Path};
    #[test]fn packaged_javascript_is_served_as_javascript(){
        let assets=Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist/assets");
        let mut count=0;
        for entry in fs::read_dir(&assets).expect("build frontend assets before native tests"){
            let path=entry.unwrap().path();
            if !matches!(path.extension().and_then(|s|s.to_str()),Some("js"|"mjs")){continue;}
            count+=1;let bytes=fs::read(&path).unwrap();
            let mime=tauri::utils::mime_type::MimeType::parse(&bytes,&path.to_string_lossy());
            assert_eq!(mime,"text/javascript","module {} would be rejected by WebView",path.file_name().unwrap().to_string_lossy());
        }
        assert!(count>0,"native module MIME check did not inspect any build assets");
    }
}
