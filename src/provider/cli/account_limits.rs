use super::{GroupGuard, read_line};
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use tokio::io::{AsyncWriteExt, BufReader};

/// 공식 app-server의 읽기 전용 계정 API. thread·turn·모델 요청을 만들지 않는다.
pub(super) async fn read(executable: &std::path::Path) -> Result<Value, &'static str> {
    request(executable, "account/rateLimits/read", json!({})).await
}

pub(super) async fn request(executable: &std::path::Path, method: &str, params: Value) -> Result<Value, &'static str> {
    tokio::time::timeout(Duration::from_secs(12), async {
        let scratch = tempfile::Builder::new().prefix("grove-usage-").tempdir().map_err(|_| "unavailable")?;
        let mut command = tokio::process::Command::new(executable);
        command.arg("app-server").current_dir(scratch.path())
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        for (key, _) in std::env::vars_os() {
            if key.to_str().is_some_and(|key| key.starts_with("GROVE_")) { command.env_remove(key); }
        }
        let tag = crate::util::new_id();
        crate::procs::prepare(&mut command, &tag);
        let mut child = command.spawn().map_err(|_| "unavailable")?;
        let _guard = GroupGuard(crate::procs::adopt(&mut child, &tag).map_err(|_| "unavailable")?);
        let mut input = child.stdin.take().expect("stdin");
        let mut output = BufReader::new(child.stdout.take().expect("stdout"));
        let init = json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"grove","version":crate::VERSION}}});
        input.write_all(format!("{init}\n").as_bytes()).await.map_err(|_| "unavailable")?;
        let mut bytes = 0;
        while let Some(line) = read_line(&mut output).await.map_err(|_| "invalid")? {
            bytes += line.len();
            if bytes > 1024 * 1024 { return Err("invalid"); }
            let value: Value = serde_json::from_slice(&line).map_err(|_| "invalid")?;
            if value["id"] == 1 {
                if value.get("error").is_some() { return Err("unavailable"); }
                let call = json!({"id":2,"method":method,"params":params});
                input.write_all(format!("{{\"method\":\"initialized\"}}\n{call}\n").as_bytes())
                    .await.map_err(|_| "unavailable")?;
            } else if value["id"] == 2 {
                if value.get("error").is_some() { return Err("unavailable"); }
                return value.get("result").cloned().ok_or("invalid");
            }
        }
        Err("unavailable")
    }).await.map_err(|_| "timeout")?
}
