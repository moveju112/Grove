//! PC-003: 실제 CLI의 첫 시작·재시작·시작 실패. 데이터와 프로세스는 모두 시험 소유다.

#[path = "common/cli_process.rs"]
mod cli_process;
use cli_process::Running;
use serde_json::{Value, json};
use std::path::Path;
use std::process::{Command, Output};
use std::time::Duration;

fn grove() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_grove"));
    // 호스트의 실제 서버 설정·사용자 데이터와 분리한다.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GROVE_") {
            command.env_remove(key);
        }
    }
    command.env("GROVE_LOG", "off").env("NO_COLOR", "1");
    command
}

fn serve(data: &Path, listen: &str, json_output: bool) -> Command {
    let mut command = grove();
    command.args(["serve", "--data-dir"]).arg(data).args(["--listen", listen]);
    if json_output {
        command.arg("--json");
    }
    command
}

fn assert_no_token(output: &str, token: &str) {
    assert!(!output.contains(token.trim()), "owner token 원문을 출력하면 안 된다");
}

fn failed(mut command: Command, code: i32, error_code: &str, path: &Path) -> Value {
    let mut process = Running::spawn({
        command.arg("--json");
        command
    });
    let (status, stdout, stderr) = process.finish();
    assert_eq!(status.code(), Some(code), "시작 오류 종류별 종료 코드");
    let report: Value = serde_json::from_str(&stdout).expect("실패 stdout은 단일 JSON이어야 한다");
    assert_eq!(report["status"], "failed");
    assert_eq!(report["ready"], false);
    assert_eq!(report["error"]["code"], error_code);
    assert_eq!(report["error"]["exit_code"], code);
    assert!(!report["error"]["cause"].as_str().unwrap().is_empty());
    assert!(!report["error"]["action"].as_str().unwrap().is_empty());
    assert_eq!(report["data_dir"], json!(path));
    assert_eq!(report["owner_token_file"], json!(path.join("owner-token")));
    assert!(!format!("{stdout}{stderr}").contains("stack backtrace"));
    report
}

#[test]
fn first_start_and_replayed_restart_preserve_data_token_and_health_contract() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data with spaces");
    let mut first = Running::spawn(serve(&data, "127.0.0.1:0", true));
    let ready: Value = serde_json::from_str(&first.ready(true)).unwrap();
    assert_eq!(ready["status"], "ready");
    assert_eq!(ready["ready"], true);
    assert_eq!(ready["mode"], "first_start");
    assert_eq!(ready["data_dir"], json!(data));
    assert_eq!(ready["db_path"], json!(data.join("grove.db")));
    assert_eq!(ready["owner_token_file"], json!(data.join("owner-token")));
    let base = format!("http://{}", ready["listen"].as_str().unwrap());
    assert_eq!(ready["url"], format!("{base}/"));
    assert_eq!(ready["health_url"], format!("{base}/api/v1/health"));
    assert!(!ready["listen"].as_str().unwrap().ends_with(":0"), "실제 바인딩된 포트를 안내한다");
    let health: Value = reqwest::blocking::Client::builder().timeout(Duration::from_secs(5)).build().unwrap()
        .get(ready["health_url"].as_str().unwrap()).send().unwrap().json().unwrap();
    assert_eq!(health["status"], "ready");
    assert_eq!(health["version"], grove::VERSION);
    assert_eq!(health["protocol"], grove::PROTOCOL_VERSION);
    assert_eq!(health["schema"], grove::store::MIGRATIONS.len());
    let token = std::fs::read_to_string(data.join("owner-token")).unwrap();
    let connection = rusqlite::Connection::open(data.join("grove.db")).unwrap();
    connection.execute_batch("CREATE TABLE pc003_fixture (value TEXT); INSERT INTO pc003_fixture VALUES ('preserved')").unwrap();
    drop(connection);
    let (status, stdout, stderr) = first.stop();
    assert!(status.success());
    assert_no_token(&format!("{stdout}{stderr}"), &token);
    assert_eq!(serde_json::from_str::<Value>(&stdout).unwrap(), ready);

    // 준비 안내의 인자 배열을 그대로 재사용한다. 경로의 공백도 보존해야 한다.
    let mut command = grove();
    for arg in ready["restart_args"].as_array().unwrap() {
        command.arg(arg.as_str().unwrap());
    }
    let mut restart = Running::spawn({
        command.arg("--json");
        command
    });
    let again: Value = serde_json::from_str(&restart.ready(true)).unwrap();
    assert_eq!(again["mode"], "restart");
    assert_eq!(again["listen"], ready["listen"]);
    assert!(std::fs::read_to_string(data.join("owner-token")).unwrap() == token, "재시작은 토큰을 바꾸지 않는다");
    let connection = rusqlite::Connection::open(data.join("grove.db")).unwrap();
    assert_eq!(connection.query_row("SELECT value FROM pc003_fixture", [], |r| r.get::<_, String>(0)).unwrap(), "preserved");
    drop(connection);
    let (status, stdout, stderr) = restart.stop();
    assert!(status.success());
    assert_no_token(&format!("{stdout}{stderr}"), &token);
    let version: Output = grove().args(["--version", "--json"]).output().unwrap();
    assert!(version.status.success());
    assert_eq!(serde_json::from_slice::<Value>(&version.stdout).unwrap()["version"], grove::VERSION);
}

#[test]
fn human_guidance_covers_first_start_restart_paths_and_wildcard_address() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    for mode in ["첫 시작", "재시작"] {
        let mut server = Running::spawn(serve(&data, "0.0.0.0:0", false));
        let ready = server.ready(false);
        assert!(ready.contains(&format!("서버 준비 완료 ({mode})")));
        assert!(ready.contains(&format!("데이터 위치: {}", data.display())));
        assert!(ready.contains("첫 기기 등록: 서버 터미널에서 grove pairing set-password"));
        assert!(ready.contains("grove pairing create"));
        assert!(ready.contains("재시작:"));
        assert!(ready.contains("grove doctor --data-dir"));
        let url = ready.lines().find_map(|l| l.strip_prefix("접속 주소: ")).unwrap();
        assert!(url.starts_with("http://127.0.0.1:"), "전체 바인딩은 실제 접속 가능한 loopback 주소로 안내한다");
        let token = std::fs::read_to_string(data.join("owner-token")).unwrap();
        let (status, stdout, stderr) = server.stop();
        assert!(status.success());
        assert_no_token(&format!("{stdout}{stderr}"), &token);
    }
}

#[test]
fn occupied_port_has_cause_action_address_and_distinct_exit_code() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let listen = listener.local_addr().unwrap().to_string();
    let report = failed(serve(&data, &listen, false), 10, "port_in_use", &data);
    assert_eq!(report["listen"], listen);
    assert_eq!(report["doctor_args"][0], "doctor");
    assert!(!data.join("grove.db").exists(), "포트 충돌은 DB 초기화 전에 중단한다");
    // --json이 없는 시작 실패도 같은 원인·조치·경로를 제공한다.
    let mut process = Running::spawn(serve(&data, &listen, false));
    let (status, stdout, stderr) = process.finish();
    assert_eq!(status.code(), Some(10));
    assert!(stdout.is_empty());
    for required in ["이미 사용 중", "조치:", "--listen", data.to_str().unwrap(), &listen] {
        assert!(stderr.contains(required), "사람용 오류 안내 누락");
    }
}

#[test]
fn same_data_directory_is_refused_without_changing_the_running_server() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let mut server = Running::spawn(serve(&data, "127.0.0.1:0", true));
    assert_eq!(serde_json::from_str::<Value>(&server.ready(true)).unwrap()["ready"], true);
    let token = std::fs::read_to_string(data.join("owner-token")).unwrap();
    let report = failed(serve(&data, "127.0.0.1:0", false), 14, "already_running", &data);
    assert_eq!(report["error"]["path"], json!(data.join("grove.lock")));
    assert_no_token(&report.to_string(), &token);
    assert!(std::fs::read_to_string(data.join("owner-token")).unwrap() == token, "중복 시작은 토큰을 바꾸지 않는다");
    let (status, stdout, stderr) = server.stop();
    assert!(status.success());
    assert_no_token(&format!("{stdout}{stderr}"), &token);
}

#[test]
fn newer_schema_has_safe_recovery_guidance_and_preserves_version() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir(&data).unwrap();
    let path = data.join("grove.db");
    let newer = grove::store::MIGRATIONS.len() + 1;
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.pragma_update(None, "user_version", newer).unwrap();
    drop(connection);
    let report = failed(serve(&data, "127.0.0.1:0", false), 13, "schema_mismatch", &data);
    assert_eq!(report["error"]["path"], json!(path));
    assert!(report["error"]["action"].as_str().unwrap().contains("덮어쓰지"));
    let connection = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(connection.query_row("PRAGMA user_version", [], |r| r.get::<_, usize>(0)).unwrap(), newer);
    assert!(!data.join("owner-token").exists());
}

#[test]
fn sqlite_writer_lock_has_a_different_code_and_is_not_removed() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir(&data).unwrap();
    let path = data.join("grove.db");
    // migration과 WAL 변환 전의 실제 외부 DB 잠금으로 시작 경합을 재현한다.
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TABLE pc003_fixture (value TEXT); BEGIN EXCLUSIVE; INSERT INTO pc003_fixture VALUES ('held')").unwrap();
    let report = failed(serve(&data, "127.0.0.1:0", false), 12, "database_busy", &data);
    assert_eq!(report["error"]["path"], json!(path));
    assert!(report["error"]["action"].as_str().unwrap().contains("삭제하지"));
    connection.execute_batch("COMMIT").unwrap();
    assert_eq!(connection.query_row("SELECT value FROM pc003_fixture", [], |r| r.get::<_, String>(0)).unwrap(), "held");
}

#[cfg(unix)]
#[test]
fn permission_error_reports_path_without_changing_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir(&data).unwrap();
    std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o500)).unwrap();
    let mut command = serve(&data, "127.0.0.1:0", false);
    if unsafe { libc::geteuid() } == 0 {
        // root라도 실제 비특권 자식의 접근 거부를 시험한다. 새 권한을 획득하지 않는다.
        use std::os::unix::process::CommandExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        command.uid(65534).gid(65534);
    }
    let report = failed(command, 11, "data_permission", &data);
    assert!(report["error"]["path"].as_str().unwrap().starts_with(data.to_str().unwrap()));
    assert_eq!(std::fs::metadata(&data).unwrap().permissions().mode() & 0o777, 0o500);
    assert!(!data.join("grove.db").exists());
    std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn invalid_environment_is_safe_machine_readable_and_side_effect_free() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let mut command = serve(&data, "127.0.0.1:0", true);
    command.env("GROVE_WEB_BASE", "../invalid");
    let mut process = Running::spawn(command);
    let (status, stdout, _) = process.finish();
    assert_eq!(status.code(), Some(2));
    let report: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(report["error"]["code"], "configuration");
    assert_eq!(report["ready"], false);
    assert!(!data.exists());
}

#[test]
fn invalid_serve_arguments_remain_machine_readable() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    for args in [
        vec!["serve", "--json", "--listen", "invalid"],
        vec!["--json", "--listen"],
        vec!["serve", "--json", "--offline"],
    ] {
        let mut command = grove();
        command.args(args).env("GROVE_DATA_DIR", &data);
        let mut process = Running::spawn(command);
        let (status, stdout, _) = process.finish();
        assert_eq!(status.code(), Some(2));
        let report: Value = serde_json::from_str(&stdout).unwrap();
        assert_eq!(report["error"]["code"], "configuration");
        assert_eq!(report["ready"], false);
        assert!(!data.exists());
    }
}
