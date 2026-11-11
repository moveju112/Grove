//! 설치·업데이트(UPDATE). 서버와 같은 실행 파일의 CLI로 동작하는 일시적 updater다(상주 업데이트 데몬 없음).
//!
//! 설치 디렉터리 구조
//!   install.json          data_dir·listen·service 방식
//!   trusted-keys.json     서명 검증 키(회전·폐기 반영)
//!   releases/<id>/        풀어 둔 패키지(grove, web/, licenses/, manifest.json)
//!   current, previous     실행할 release id를 담은 포인터 파일(symlink 대신: Windows 호환, 원자적 교체)
//!   candidates/           다운로드·검증 중인 후보(완료 전에는 releases로 옮기지 않음)
//!   backups/              적용 전 DB snapshot·실패한 DB 보관
//!   update-state.json     수동·자동 공통 상태 머신
//!   update.lock           동시 업데이트 방지
//!   logs/server.log       process 방식 서버 출력
//!
//! 적용 순서(apply): lock → 서명 확인 → 이미 적용 확인 → 다운로드·hash → 압축 해제·파일 hash·`version --json` 대조 →
//! 호환성(schema 다운그레이드 거부) → 실행 중 작업 확인(있으면 보류) → snapshot → snapshot 복사본에서 migration 시험 →
//! 정지 → 포인터 전환 → 시작 → readiness(health·버전·인증 조회·웹) → 실패 시 복구 → 결과 기록.

use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// 빌드에 내장하는 신뢰 키. 실제 배포 서명 키는 소유자가 만들어 넣는다(비어 있으면 설치 시 `--trust-key` 필요).
const BUILTIN_KEYS: &[(&str, &str)] = &[];

// ---------- 공통 ----------

fn now() -> String {
    crate::util::fmt_time(time::OffsetDateTime::now_utc())
}

/// 정렬된 키의 JSON(서명 대상). 의존성 feature에 따라 serde_json 맵 순서가 달라지지 않게 직접 정렬한다.
pub fn canonical(v: &Value) -> Vec<u8> {
    fn canon(v: &Value) -> Value {
        match v {
            Value::Object(m) => {
                let sorted: BTreeMap<&String, Value> = m.iter().map(|(k, v)| (k, canon(v))).collect();
                let mut out = serde_json::Map::new();
                for (k, v) in sorted {
                    out.insert(k.clone(), v);
                }
                Value::Object(out)
            }
            Value::Array(a) => Value::Array(a.iter().map(canon).collect()),
            x => x.clone(),
        }
    }
    // 정렬된 맵을 순서대로 직렬화(serde_json::Map이 BTreeMap이든 IndexMap이든 삽입 순서 = 정렬 순서).
    serde_json::to_vec(&canon(v)).expect("json")
}

pub fn key_id(pk: &VerifyingKey) -> String {
    crate::util::sha256_hex(pk.as_bytes())[..16].to_string()
}

fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, data).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

fn read_json<T: for<'a> Deserialize<'a>>(path: &Path) -> Result<T, String> {
    let t = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&t).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("windows", "x86_64") => "windows-x64",
        ("windows", "aarch64") => "windows-arm64",
        ("macos", "aarch64") => "macos-arm64",
        _ => "unsupported",
    }
}

fn exe_name() -> &'static str {
    if cfg!(windows) { "grove.exe" } else { "grove" }
}

/// 버전 비교(major.minor.patch, pre-release는 정식보다 낮음).
pub fn cmp_version(a: &str, b: &str) -> std::cmp::Ordering {
    fn parse(v: &str) -> (Vec<u64>, Option<String>) {
        let v = v.split('+').next().unwrap_or(v);
        let (core, pre) = match v.split_once('-') {
            Some((c, p)) => (c, Some(p.to_string())),
            None => (v, None),
        };
        (core.split('.').map(|x| x.parse().unwrap_or(0)).collect(), pre)
    }
    let (ca, pa) = parse(a);
    let (cb, pb) = parse(b);
    ca.cmp(&cb).then_with(|| match (pa, pb) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(x), Some(y)) => x.cmp(&y),
    })
}

// ---------- 서명된 release manifest ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedKey {
    pub key_id: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Release {
    pub product: String,
    pub channel: String,
    pub version: String,
    pub protocol: u32,
    pub schema: usize,
    pub issued_at: String,
    pub artifacts: BTreeMap<String, Artifact>,
    #[serde(default)]
    pub rotate_keys: Vec<TrustedKey>,
    #[serde(default)]
    pub revoke_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Trust {
    pub keys: Vec<TrustedKey>,
    #[serde(default)]
    pub revoked: Vec<String>,
}

impl Trust {
    fn with_builtin(mut self) -> Self {
        for (id, pk) in BUILTIN_KEYS {
            if !self.keys.iter().any(|k| k.key_id == *id) {
                self.keys.push(TrustedKey { key_id: id.to_string(), public_key: pk.to_string() });
            }
        }
        self
    }
    fn find(&self, id: &str) -> Option<VerifyingKey> {
        if self.revoked.iter().any(|r| r == id) {
            return None;
        }
        let k = self.keys.iter().find(|k| k.key_id == id)?;
        let bytes: [u8; 32] = B64.decode(&k.public_key).ok()?.try_into().ok()?;
        VerifyingKey::from_bytes(&bytes).ok()
    }
}

/// 서명 확인. 신뢰 키 중 하나라도 유효한 서명이면 통과한다. 통과한 manifest의 키 회전·폐기를 Trust에 반영한다.
pub fn verify_manifest(text: &str, trust: &mut Trust) -> Result<Release, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("manifest 형식 오류: {e}"))?;
    let signed = v.get("signed").ok_or("manifest에 signed가 없습니다")?;
    let sigs = v["signatures"].as_array().ok_or("manifest에 서명이 없습니다")?;
    let msg = canonical(signed);
    let ok = sigs.iter().any(|s| {
        let (Some(id), Some(sig)) = (s["key_id"].as_str(), s["sig"].as_str()) else { return false };
        let Some(pk) = trust.find(id) else { return false };
        let Ok(bytes) = B64.decode(sig) else { return false };
        let Ok(sig) = Signature::from_slice(&bytes) else { return false };
        pk.verify(&msg, &sig).is_ok()
    });
    if !ok {
        return Err("신뢰하는 키의 유효한 서명이 없습니다(변조·폐기된 키·알 수 없는 키)".into());
    }
    let r: Release = serde_json::from_value(signed.clone()).map_err(|e| format!("manifest 내용 오류: {e}"))?;
    if r.product != "grove" {
        return Err(format!("다른 제품의 manifest입니다: {}", r.product));
    }
    for k in &r.rotate_keys {
        if !trust.keys.iter().any(|x| x.key_id == k.key_id) {
            trust.keys.push(k.clone());
        }
    }
    for id in &r.revoke_keys {
        if !trust.revoked.contains(id) {
            trust.revoked.push(id.clone());
        }
    }
    Ok(r)
}

pub fn sign_release(release: &Value, keys: &[SigningKey]) -> Value {
    let msg = canonical(release);
    let sigs: Vec<Value> = keys.iter().map(|k| json!({ "key_id": key_id(&k.verifying_key()), "sig": B64.encode(k.sign(&msg).to_bytes()) })).collect();
    json!({ "signed": release, "signatures": sigs })
}

pub fn load_signing_key(path: &Path) -> Result<SigningKey, String> {
    let t = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let bytes: [u8; 32] = B64.decode(t.trim()).map_err(|e| e.to_string())?.try_into().map_err(|_| "키 길이 오류".to_string())?;
    Ok(SigningKey::from_bytes(&bytes))
}

// ---------- 설치 ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallCfg {
    pub data_dir: PathBuf,
    pub listen: String,
    /// "process"(updater가 직접 띄움) | "systemd-user:<unit>"
    pub service: String,
}

pub struct Install {
    pub root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct State {
    pub state: String,
    pub current: Option<String>,
    pub target: Option<String>,
    pub detail: Value,
    pub updated_at: String,
}

impl Install {
    pub fn cfg(&self) -> Result<InstallCfg, String> {
        read_json(&self.root.join("install.json"))
    }
    pub fn trust(&self) -> Trust {
        read_json::<Trust>(&self.root.join("trusted-keys.json")).unwrap_or_default().with_builtin()
    }
    fn save_trust(&self, t: &Trust) -> Result<(), String> {
        write_atomic(&self.root.join("trusted-keys.json"), &serde_json::to_vec_pretty(t).unwrap())
    }
    pub fn pointer(&self, name: &str) -> Option<String> {
        std::fs::read_to_string(self.root.join(name)).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }
    fn set_pointer(&self, name: &str, id: &str) -> Result<(), String> {
        write_atomic(&self.root.join(name), id.as_bytes())
    }
    pub fn release_dir(&self, id: &str) -> PathBuf {
        self.root.join("releases").join(id)
    }
    pub fn release_manifest(&self, id: &str) -> Result<Value, String> {
        read_json(&self.release_dir(id).join("manifest.json"))
    }
    pub fn state(&self) -> State {
        read_json(&self.root.join("update-state.json")).unwrap_or(State { state: "idle".into(), ..Default::default() })
    }
    fn set_state(&self, state: &str, target: Option<&str>, detail: Value) {
        let s = State { state: state.into(), current: self.pointer("current"), target: target.map(String::from), detail, updated_at: now() };
        let _ = write_atomic(&self.root.join("update-state.json"), &serde_json::to_vec_pretty(&s).unwrap());
    }
    fn base_url(&self) -> Result<String, String> {
        Ok(format!("http://{}/api/v1", self.cfg()?.listen))
    }
    fn token(&self) -> Result<String, String> {
        let p = self.cfg()?.data_dir.join("owner-token");
        Ok(std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?.trim().to_string())
    }
}

/// 압축본을 디렉터리로 푼다. 경로 탈출(절대 경로·..)은 거부한다.
fn extract(archive: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let name = archive.to_string_lossy();
    if name.ends_with(".zip") {
        let f = std::fs::File::open(archive).map_err(|e| e.to_string())?;
        let mut z = zip::ZipArchive::new(f).map_err(|e| format!("zip: {e}"))?;
        for i in 0..z.len() {
            let mut e = z.by_index(i).map_err(|e| e.to_string())?;
            let rel = e.enclosed_name().ok_or_else(|| format!("허용되지 않는 경로: {:?}", e.name()))?;
            let out = dest.join(rel);
            if e.is_dir() {
                std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
                continue;
            }
            if let Some(p) = out.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut w = std::fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut e, &mut w).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            if let Some(mode) = e.unix_mode() {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode & 0o755));
            }
        }
    } else {
        let f = std::fs::File::open(archive).map_err(|e| e.to_string())?;
        let mut t = tar::Archive::new(flate2::read::GzDecoder::new(f));
        for e in t.entries().map_err(|e| e.to_string())? {
            let mut e = e.map_err(|e| e.to_string())?;
            // unpack_in은 dest 밖으로 나가는 항목을 쓰지 않고 false를 돌려준다.
            if !e.unpack_in(dest).map_err(|er| er.to_string())? {
                return Err(format!("허용되지 않는 경로: {}", e.path().map(|p| p.display().to_string()).unwrap_or_default()));
            }
        }
    }
    Ok(())
}

/// 풀린 패키지의 최상위 폴더(grove-<ver>-<target>)를 찾아 manifest의 파일 hash를 모두 확인한다.
fn verify_package_dir(dir: &Path) -> Result<(PathBuf, Value), String> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten().map(|e| e.path()).collect();
    if entries.len() != 1 || !entries[0].is_dir() {
        return Err("패키지 최상위 폴더가 하나여야 합니다".into());
    }
    let top = entries.remove(0);
    let m: Value = read_json(&top.join("manifest.json"))?;
    for f in m["files"].as_array().ok_or("manifest files 없음")? {
        let rel = f["path"].as_str().ok_or("파일 경로 없음")?;
        if rel.contains("..") || rel.starts_with('/') {
            return Err(format!("허용되지 않는 경로: {rel}"));
        }
        let data = std::fs::read(top.join(rel)).map_err(|e| format!("{rel}: {e}"))?;
        if crate::util::sha256_hex(&data) != f["sha256"].as_str().unwrap_or("") {
            return Err(format!("{rel}: hash 불일치"));
        }
    }
    Ok((top, m))
}

fn probe_version(bin: &Path) -> Result<Value, String> {
    let o = std::process::Command::new(bin).args(["version", "--json"]).output().map_err(|e| format!("{}: 실행 실패 {e}", bin.display()))?;
    if !o.status.success() { return Err("version --json 실행 실패".into()); }
    serde_json::from_slice(o.stdout.trim_ascii()).map_err(|e| format!("version --json 해석 실패: {e}"))
}

/// 패키지 압축본을 검증해 releases/<id>에 둔다. id = <version>-<archive sha 앞 12자>.
fn stage_release(inst: &Install, archive: &Path) -> Result<(String, Value), String> {
    let sha = crate::util::sha256_hex(&std::fs::read(archive).map_err(|e| e.to_string())?);
    let cand = inst.root.join("candidates").join(format!("{}.partial", &sha[..12]));
    let _ = std::fs::remove_dir_all(&cand);
    extract(archive, &cand)?;
    let (top, m) = verify_package_dir(&cand)?;
    let v = probe_version(&top.join(exe_name()))?;
    if (v["version"].as_str(), v["protocol"].as_u64(), v["schema"].as_u64()) != (m["version"].as_str(), m["protocol"].as_u64(), m["schema"].as_u64()) {
        return Err(format!("실행 파일 정보가 패키지 manifest와 다릅니다: {v}"));
    }
    let id = format!("{}-{}", m["version"].as_str().unwrap_or("?"), &sha[..12]);
    let dest = inst.release_dir(&id);
    if dest.exists() {
        // 같은 bytes로 이미 풀어 둔 release: 재사용(재시도·동일 hash 재설치)
        let _ = std::fs::remove_dir_all(&cand);
        return Ok((id, m));
    }
    std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::rename(&top, &dest).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&cand);
    Ok((id, m))
}

// ---------- 서비스 제어 ----------

fn http(method: &str, url: &str, token: Option<&str>) -> Result<(u16, Value), String> {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    rt.block_on(async {
        let c = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
        let mut rb = c.request(method.parse().unwrap(), url);
        if let Some(t) = token {
            rb = rb.bearer_auth(t).header("Idempotency-Key", crate::util::new_id());
        }
        let r = rb.send().await.map_err(|e| e.to_string())?;
        let st = r.status().as_u16();
        let text = r.text().await.unwrap_or_default();
        Ok((st, serde_json::from_str(&text).unwrap_or(Value::Null)))
    })
}

fn health(inst: &Install) -> Option<Value> {
    http("GET", &format!("{}/health", inst.base_url().ok()?), None).ok().filter(|(s, _)| *s == 200).map(|x| x.1)
}

pub fn start_service(inst: &Install) -> Result<(), String> {
    let cfg = inst.cfg()?;
    let id = inst.pointer("current").ok_or("current 포인터가 없습니다")?;
    if let Some(unit) = cfg.service.strip_prefix("systemd-user:") {
        let st = std::process::Command::new("systemctl").args(["--user", "start", unit]).status().map_err(|e| e.to_string())?;
        return if st.success() { Ok(()) } else { Err(format!("systemctl start {unit} 실패")) };
    }
    if health(inst).is_some() { return Err("서버 주소가 이미 응답합니다. 실행 중인 서버를 먼저 확인하세요".into()); }
    let dir = inst.release_dir(&id);
    let binary = dir.join(exe_name());
    let v = probe_version(&binary)?;
    let rotating = v["features"].as_array().is_some_and(|a| a.iter().any(|f| f == "file_log_rotation_v1"));
    let log_path = inst.root.join("logs").join("server.log");
    let log = crate::logging::prepare_file(&log_path).map_err(|e| format!("로그 준비 실패: {e}"))?;
    let mut cmd = std::process::Command::new(binary);
    cmd.args(["serve", "--listen", &cfg.listen, "--data-dir"])
        .arg(&cfg.data_dir)
        .env("GROVE_WEB_DIR", dir.join("web"))
        .stdin(std::process::Stdio::null());
    if rotating {
        drop(log); // 서버가 독립적인 회전 잠금을 소유한다.
        cmd.arg("--log-file").arg(log_path)
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    } else {
        // 기능 표식이 없는 이전 release로 되돌릴 때는 알 수 없는 인수를 보내지 않는다.
        cmd.stdout(log.try_clone().map_err(|e| e.to_string())?).stderr(log);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // updater가 끝나도 서버는 계속 실행
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0000_0008 | 0x0000_0200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    }
    let child = cmd.spawn().map_err(|e| format!("서버 시작 실패: {e}"))?;
    let _ = std::fs::write(inst.root.join("server.pid"), child.id().to_string());
    Ok(())
}

/// 정상 종료: 관리 API 종료 요청 → health가 끊길 때까지 대기. systemd 방식은 systemctl stop.
pub fn stop_service(inst: &Install) -> Result<(), String> {
    let cfg = inst.cfg()?;
    if let Some(unit) = cfg.service.strip_prefix("systemd-user:") {
        let st = std::process::Command::new("systemctl").args(["--user", "stop", unit]).status().map_err(|e| e.to_string())?;
        return if st.success() { Ok(()) } else { Err(format!("systemctl stop {unit} 실패")) };
    }
    if health(inst).is_none() {
        return Ok(());
    }
    let (st, _) = http("POST", &format!("{}/admin/shutdown", inst.base_url()?), Some(&inst.token()?))?;
    if st != 202 {
        return Err(format!("종료 요청 거부(HTTP {st})"));
    }
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(60) {
        if health(inst).is_none() && port_free(&cfg.listen) {
            // 잠금 파일이 풀릴 때까지(같은 데이터 디렉터리의 다음 서버가 시작할 수 있게)
            std::thread::sleep(Duration::from_millis(200));
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("60초 안에 서버가 종료되지 않았습니다".into())
}

fn port_free(listen: &str) -> bool {
    std::net::TcpStream::connect_timeout(&listen.parse().unwrap_or_else(|_| "127.0.0.1:0".parse().unwrap()), Duration::from_millis(200)).is_err()
}

/// readiness: 기동·API·인증·기본 기능을 따로 확인한다(UPDATE-009).
pub fn readiness(inst: &Install, want_version: &str, timeout: Duration) -> Result<Value, String> {
    let t0 = Instant::now();
    let base = inst.base_url()?;
    let mut last = String::from("응답 없음");
    while t0.elapsed() < timeout {
        if let Some(h) = health(inst) {
            if h["status"] != "ready" {
                last = format!("health {h}");
            } else if h["version"] != want_version {
                return Err(format!("다른 버전이 응답합니다: {}", h["version"]));
            } else {
                let token = inst.token()?;
                let (ps, _) = http("GET", &format!("{base}/projects"), Some(&token))?;
                let root = base.trim_end_matches("/api/v1");
                let (ws, _) = http("GET", &format!("{root}/"), None).unwrap_or((0, Value::Null));
                if ps == 200 && ws == 200 {
                    return Ok(json!({ "process": true, "health": h, "auth": ps, "web": ws }));
                }
                return Err(format!("기본 기능 확인 실패: 인증 조회 {ps}, 웹 {ws}"));
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(format!("{}초 안에 준비되지 않았습니다({last})", timeout.as_secs()))
}

// ---------- 결과 기록 ----------

fn write_receipt(inst: &Install, r: &Value) {
    let name = format!("{}-{}.json", now().replace([':', '.'], ""), r["id"].as_str().unwrap_or("x"));
    if let Ok(cfg) = inst.cfg() {
        let dir = cfg.data_dir.join("update-receipts");
        let _ = std::fs::create_dir_all(&dir);
        let _ = write_atomic(&dir.join(&name), &serde_json::to_vec_pretty(r).unwrap());
    }
    let dir = inst.root.join("receipts");
    let _ = std::fs::create_dir_all(&dir);
    let _ = write_atomic(&dir.join(&name), &serde_json::to_vec_pretty(r).unwrap());
    // 준비된 서버가 있으면 바로 알림으로 가져오게 한다(실패해도 파일은 남아 /updates로 조회 가능).
    if health(inst).is_some() {
        if let (Ok(base), Ok(tok)) = (inst.base_url(), inst.token()) {
            let _ = http("POST", &format!("{base}/admin/update-receipts/import"), Some(&tok));
        }
    }
}

fn fetch(src: &str, dest: &Path) -> Result<(), String> {
    if src.starts_with("http://") || src.starts_with("https://") {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
        let bytes = rt.block_on(async {
            let r = reqwest::get(src).await.map_err(|e| e.to_string())?;
            if !r.status().is_success() {
                return Err(format!("다운로드 실패: HTTP {}", r.status()));
            }
            r.bytes().await.map_err(|e| e.to_string())
        })?;
        std::fs::write(dest, &bytes).map_err(|e| e.to_string())
    } else {
        let p = src.strip_prefix("file://").unwrap_or(src);
        std::fs::copy(p, dest).map(|_| ()).map_err(|e| format!("{p}: {e}"))
    }
}

fn read_source(src: &str) -> Result<String, String> {
    let tmp = std::env::temp_dir().join(format!("grove-manifest-{}", crate::util::new_id()));
    fetch(src, &tmp)?;
    let t = std::fs::read_to_string(&tmp).map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&tmp);
    t
}

// ---------- 명령 ----------

/// 새 설치(UPDATE-002 새 설치). 이미 설치돼 있으면 거부하고 update를 안내한다.
pub fn install(root: &Path, package: &Path, data_dir: &Path, listen: &str, trust_keys: &[PathBuf], service: &str) -> Result<Value, String> {
    let inst = Install { root: root.to_path_buf() };
    if inst.pointer("current").is_some() {
        return Err(format!("{}: 이미 설치되어 있습니다. `grove update apply`를 쓰세요", root.display()));
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let mut trust = Trust::default();
    for k in trust_keys {
        let t = std::fs::read_to_string(k).map_err(|e| format!("{}: {e}", k.display()))?;
        let pk: [u8; 32] = B64.decode(t.trim()).map_err(|e| e.to_string())?.try_into().map_err(|_| "공개키 길이 오류".to_string())?;
        let vk = VerifyingKey::from_bytes(&pk).map_err(|e| e.to_string())?;
        trust.keys.push(TrustedKey { key_id: key_id(&vk), public_key: t.trim().to_string() });
    }
    inst.save_trust(&trust)?;
    let cfg = InstallCfg { data_dir: data_dir.to_path_buf(), listen: listen.to_string(), service: service.to_string() };
    write_atomic(&root.join("install.json"), &serde_json::to_vec_pretty(&cfg).unwrap())?;
    let (id, m) = stage_release(&inst, package)?;
    inst.set_pointer("current", &id)?;
    inst.set_state("idle", None, json!({ "installed": id }));
    Ok(json!({ "installed": id, "version": m["version"] }))
}

pub fn check(root: &Path, manifest_src: &str) -> Result<Value, String> {
    let inst = Install { root: root.to_path_buf() };
    let mut trust = inst.trust();
    let r = verify_manifest(&read_source(manifest_src)?, &mut trust)?;
    let cur = inst.pointer("current").ok_or("설치되어 있지 않습니다(`grove install`)")?;
    let cm = inst.release_manifest(&cur)?;
    let cv = cm["version"].as_str().unwrap_or("0");
    let kind = match cmp_version(&r.version, cv) {
        std::cmp::Ordering::Greater => "upgrade",
        std::cmp::Ordering::Equal => "same",
        std::cmp::Ordering::Less => "downgrade",
    };
    let has = r.artifacts.contains_key(platform());
    let out = json!({ "kind": kind, "current": cv, "available": r.version, "channel": r.channel, "platform": platform(), "artifact": has, "schema": r.schema, "protocol": r.protocol });
    inst.set_state(if kind == "upgrade" && has { "available" } else { "idle" }, Some(&r.version), out.clone());
    Ok(out)
}

pub struct ApplyOpts {
    pub force: bool,
    pub allow_downgrade: bool,
    pub ready_timeout: Duration,
}

/// 업데이트 적용. 수동·자동 모두 이 경로(UPDATE-003). 반환 JSON의 status: applied|already|deferred|rolled_back|failed.
pub fn apply(root: &Path, manifest_src: &str, o: &ApplyOpts) -> Result<Value, String> {
    let inst = Install { root: root.to_path_buf() };
    std::fs::create_dir_all(root.join("candidates")).map_err(|e| e.to_string())?;
    let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(root.join("update.lock")).map_err(|e| e.to_string())?;
    if lock.try_lock().is_err() {
        return Err("다른 업데이트가 진행 중입니다(update.lock)".into());
    }
    let id = crate::util::new_id();
    let mut trust = inst.trust();
    let r = verify_manifest(&read_source(manifest_src)?, &mut trust)?;
    let cur = inst.pointer("current").ok_or("설치되어 있지 않습니다")?;
    let cm = inst.release_manifest(&cur)?;
    let from = cm["version"].as_str().unwrap_or("0").to_string();
    let receipt = |status: &str, msg: String, extra: Value| -> Value {
        let mut v = json!({ "id": id, "status": status, "from_version": from, "to_version": r.version, "message": msg, "finished_at": now(), "platform": platform() });
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            o.extend(e.clone());
        }
        v
    };
    let art = r.artifacts.get(platform()).ok_or_else(|| format!("{} 배포물이 없습니다", platform()))?.clone();
    // 이미 적용됨: 같은 artifact hash로 만든 release가 현재면 아무것도 하지 않는다(재시도 안전, UPDATE-022).
    if cur.ends_with(&art.sha256[..12]) && health(&inst).is_some_and(|h| h["version"] == r.version) {
        inst.set_state("idle", Some(&r.version), json!({ "already": true }));
        return Ok(receipt("already", "이미 적용된 버전입니다".into(), json!({})));
    }
    if cmp_version(&r.version, &from) == std::cmp::Ordering::Less && !o.allow_downgrade {
        return Err(format!("다운그레이드({from} → {})는 --allow-downgrade가 필요합니다", r.version));
    }
    inst.set_state("downloading", Some(&r.version), json!({}));
    let cfg = inst.cfg()?;
    let ext = if art.url.ends_with(".zip") { "zip" } else { "tar.gz" };
    let file = root.join("candidates").join(format!("{}.{ext}", &art.sha256[..12]));
    if !(file.is_file() && crate::util::sha256_hex(&std::fs::read(&file).unwrap_or_default()) == art.sha256) {
        let part = file.with_extension("download");
        fetch(&art.url, &part)?;
        let data = std::fs::read(&part).map_err(|e| e.to_string())?;
        if data.len() as u64 != art.size || crate::util::sha256_hex(&data) != art.sha256 {
            let _ = std::fs::remove_file(&part);
            inst.set_state("failed", Some(&r.version), json!({ "error": "hash" }));
            return Err("다운로드한 파일의 크기·hash가 manifest와 다릅니다".into());
        }
        std::fs::rename(&part, &file).map_err(|e| e.to_string())?;
    }
    let (new_id, nm) = match stage_release(&inst, &file) {
        Ok(x) => x,
        Err(e) => {
            inst.set_state("failed", Some(&r.version), json!({ "error": e }));
            return Err(e);
        }
    };
    if nm["version"] != r.version || nm["schema"].as_u64() != Some(r.schema as u64) {
        return Err("패키지 내용이 서명된 manifest와 다릅니다".into());
    }
    // schema 다운그레이드는 데이터 형식이 맞지 않으므로 거부(복구는 snapshot 복원으로 별도 수행).
    let db_schema = db_schema(&cfg.data_dir.join("grove.db"));
    if (r.schema as i64) < db_schema {
        inst.set_state("failed", Some(&r.version), json!({ "error": "schema_downgrade" }));
        return Err(format!("현재 데이터 schema {db_schema}보다 낮은 schema {}로는 바꿀 수 없습니다. 해당 버전의 snapshot을 복원하세요", r.schema));
    }
    // 실행 중 작업 확인(서비스 중단 없음)
    let base = inst.base_url()?;
    if health(&inst).is_some() {
        let (st, rd) = http("GET", &format!("{base}/admin/update-readiness"), Some(&inst.token()?))?;
        if st != 200 {
            return Err(format!("readiness 조회 실패: HTTP {st}"));
        }
        if rd["idle"] != true {
            if !o.force {
                inst.set_state("deferred", Some(&r.version), rd["busy"].clone());
                let rc = receipt("deferred", format!("실행 중인 작업이 있어 적용을 미뤘습니다: {}", rd["busy"]), json!({ "busy": rd["busy"] }));
                write_receipt(&inst, &rc);
                return Ok(rc);
            }
            eprintln!("강제 적용: 다음 작업이 중단됩니다 {}", rd["busy"]);
        }
    }
    // snapshot과 migration 사전 시험(쓰기 허용 전 검증, UPDATE-026)
    inst.set_state("verifying", Some(&r.version), json!({}));
    let backups = root.join("backups");
    std::fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    let snap = backups.join(format!("pre-{}-{}.db", r.version, &id[..8]));
    crate::backup::snapshot_to(&cfg.data_dir.join("grove.db"), &snap)?;
    let snap_seq = max_seq(&snap);
    let trial = backups.join(format!("trial-{}.db", &id[..8]));
    std::fs::copy(&snap, &trial).map_err(|e| e.to_string())?;
    let mc = std::process::Command::new(inst.release_dir(&new_id).join(exe_name())).arg("migrate-check").arg(&trial).output().map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&trial);
    if !mc.status.success() {
        inst.set_state("failed", Some(&r.version), json!({ "error": "migration_check" }));
        let rc = receipt("failed", format!("새 버전의 migration 사전 시험 실패(서비스는 그대로): {}", String::from_utf8_lossy(&mc.stderr).trim()), json!({}));
        write_receipt(&inst, &rc);
        return Ok(rc);
    }
    // cutover: 이 구간만 서비스가 멈춘다(UPDATE-008)
    inst.set_state("applying", Some(&r.version), json!({ "snapshot": snap }));
    let t_cut = Instant::now();
    let old_prev = inst.pointer("previous");
    stop_service(&inst)?;
    inst.set_pointer("previous", &cur)?;
    inst.set_pointer("current", &new_id)?;
    let started = start_service(&inst).and_then(|_| readiness(&inst, &r.version, o.ready_timeout));
    match started {
        Ok(ready) => {
            inst.set_state("idle", Some(&r.version), json!({ "applied": new_id }));
            if !r.rotate_keys.is_empty() || !r.revoke_keys.is_empty() {
                inst.save_trust(&trust)?;
            }
            let rc = receipt("applied", format!("{from} → {} 적용 완료", r.version), json!({ "release": new_id, "previous": cur, "snapshot": snap, "readiness": ready, "downtime_ms": t_cut.elapsed().as_millis() as u64 }));
            write_receipt(&inst, &rc);
            Ok(rc)
        }
        Err(why) => {
            let rc = rollback(&inst, &cur, &cm, &snap, snap_seq, &why, |s, m, e| receipt(s, m, e));
            // 되돌렸으면 previous도 적용 전 값으로(실패한 후보를 이전 버전으로 남기지 않는다).
            if rc["status"] == "rolled_back" {
                match &old_prev {
                    Some(p) => inst.set_pointer("previous", p)?,
                    None => {
                        let _ = std::fs::remove_file(root.join("previous"));
                    }
                }
            }
            Ok(rc)
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Recovery {
    /// schema가 그대로: 이전 실행 파일이 지금 데이터를 그대로 연다
    PointerOnly,
    /// migration은 됐지만 snapshot 이후 새 쓰기가 없다: 실패한 DB를 보관하고 snapshot을 되돌린다
    RestoreSnapshot,
    /// 새 쓰기가 있다(또는 판단 불가): 자동으로 덮어쓰지 않는다
    NeedsAttention,
}

/// 실패 뒤 복구 방법(UPDATE-011, 026). seq는 이벤트 최대값(모든 상태 변경이 같은 transaction에서 이벤트를 남긴다).
pub fn recovery(old_schema: i64, now_schema: i64, snap_seq: i64, live_seq: i64) -> Recovery {
    if now_schema <= old_schema {
        Recovery::PointerOnly
    } else if snap_seq >= 0 && live_seq == snap_seq {
        Recovery::RestoreSnapshot
    } else {
        Recovery::NeedsAttention
    }
}

/// 실패 복구. schema가 그대로면 포인터만 되돌린다. migration이 일어났으면 snapshot 이후 새 쓰기가 없을 때만
/// 실패한 DB를 보관하고 snapshot을 되돌린다. 새 쓰기가 있으면 자동으로 덮어쓰지 않고 멈춘다(UPDATE-011, 026).
fn rollback(inst: &Install, old: &str, old_manifest: &Value, snap: &Path, snap_seq: i64, why: &str, receipt: impl Fn(&str, String, Value) -> Value) -> Value {
    let _ = stop_service(inst);
    let cfg = match inst.cfg() {
        Ok(c) => c,
        Err(e) => return receipt("failed", format!("{why}; 설정 읽기 실패: {e}"), json!({})),
    };
    let db = cfg.data_dir.join("grove.db");
    let old_schema = old_manifest["schema"].as_i64().unwrap_or(0);
    let mut restored = false;
    let how = recovery(old_schema, db_schema(&db), snap_seq, max_seq(&db));
    if how != Recovery::PointerOnly {
        if how == Recovery::NeedsAttention {
            inst.set_state("needs_attention", None, json!({ "error": why, "snapshot": snap }));
            let rc = receipt(
                "failed",
                format!("{why}. 새 버전이 이미 데이터를 썼으므로 자동으로 되돌리지 않았습니다. 서비스는 멈춘 상태이며 snapshot은 {}에 있습니다", snap.display()),
                json!({ "needs_attention": true }),
            );
            write_receipt(inst, &rc);
            return rc;
        }
        let keep = inst.root.join("backups").join(format!("failed-{}", now().replace([':', '.'], "")));
        let _ = std::fs::create_dir_all(&keep);
        for ext in ["", "-wal", "-shm"] {
            let p = PathBuf::from(format!("{}{ext}", db.display()));
            if p.exists() {
                let _ = std::fs::rename(&p, keep.join(p.file_name().unwrap()));
            }
        }
        if let Err(e) = std::fs::copy(snap, &db) {
            let rc = receipt("failed", format!("{why}; snapshot 복원 실패: {e}"), json!({ "needs_attention": true }));
            write_receipt(inst, &rc);
            return rc;
        }
        restored = true;
    }
    let _ = inst.set_pointer("current", old);
    let ver = old_manifest["version"].as_str().unwrap_or("");
    let back = start_service(inst).and_then(|_| readiness(inst, ver, Duration::from_secs(60)));
    let (status, msg) = match &back {
        Ok(_) => ("rolled_back", format!("{why}. 이전 버전 {ver}로 되돌렸습니다{}", if restored { "(적용 전 snapshot 복원)" } else { "" })),
        Err(e) => ("failed", format!("{why}. 이전 버전 시작도 실패: {e}")),
    };
    inst.set_state(if back.is_ok() { "idle" } else { "needs_attention" }, None, json!({ "error": why, "restored_snapshot": restored }));
    let rc = receipt(status, msg, json!({ "restored_snapshot": restored }));
    write_receipt(inst, &rc);
    rc
}

fn db_schema(db: &Path) -> i64 {
    rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|c| c.query_row("PRAGMA user_version", [], |r| r.get(0)))
        .unwrap_or(0)
}

fn max_seq(db: &Path) -> i64 {
    rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|c| c.query_row("SELECT COALESCE(MAX(seq), 0) FROM events", [], |r| r.get(0)))
        .unwrap_or(-1)
}

/// 수동 되돌리기: previous로. schema가 다르면 거부한다.
pub fn rollback_manual(root: &Path) -> Result<Value, String> {
    let inst = Install { root: root.to_path_buf() };
    let prev = inst.pointer("previous").ok_or("되돌릴 이전 버전이 없습니다")?;
    let cur = inst.pointer("current").ok_or("설치되어 있지 않습니다")?;
    let pm = inst.release_manifest(&prev)?;
    let cfg = inst.cfg()?;
    if pm["schema"].as_i64().unwrap_or(0) < db_schema(&cfg.data_dir.join("grove.db")) {
        return Err("이전 버전은 현재 데이터 schema를 열 수 없습니다. 적용 전 snapshot(backups/)을 새 데이터 디렉터리로 복원하세요".into());
    }
    stop_service(&inst)?;
    inst.set_pointer("previous", &cur)?;
    inst.set_pointer("current", &prev)?;
    start_service(&inst)?;
    let ready = readiness(&inst, pm["version"].as_str().unwrap_or(""), Duration::from_secs(60))?;
    Ok(json!({ "current": prev, "readiness": ready }))
}

pub fn status(root: &Path) -> Result<Value, String> {
    let inst = Install { root: root.to_path_buf() };
    let cur = inst.pointer("current");
    let cm = cur.as_deref().and_then(|c| inst.release_manifest(c).ok());
    Ok(json!({
        "current": cur, "previous": inst.pointer("previous"),
        "installed_version": cm.as_ref().map(|m| m["version"].clone()),
        "running": health(&inst), "state": inst.state(), "platform": platform(),
        "trusted_keys": inst.trust().keys.iter().map(|k| k.key_id.clone()).collect::<Vec<_>>(),
    }))
}

pub fn keygen(out: &Path) -> Result<Value, String> {
    if out.exists() {
        return Err(format!("{}: 이미 존재합니다. 덮어쓰지 않습니다", out.display()));
    }
    let mut seed = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rng(), &mut seed);
    let sk = SigningKey::from_bytes(&seed);
    std::fs::write(out, B64.encode(sk.to_bytes())).map_err(|e| e.to_string())?;
    crate::store::restrict_permissions(out);
    let pk = sk.verifying_key();
    let pub_path = out.with_extension("pub");
    std::fs::write(&pub_path, B64.encode(pk.as_bytes())).map_err(|e| e.to_string())?;
    Ok(json!({ "key_id": key_id(&pk), "public_key_file": pub_path, "private_key_file": out }))
}

/// unsigned release JSON(`signed` 내용)에 서명한다. 키를 여러 개 주면 모두 서명(회전 기간 중 이중 서명).
pub fn sign(input: &Path, keys: &[PathBuf], out: &Path) -> Result<Value, String> {
    let rel: Value = read_json(input)?;
    let _: Release = serde_json::from_value(rel.clone()).map_err(|e| format!("release 형식 오류: {e}"))?;
    let ks = keys.iter().map(|k| load_signing_key(k)).collect::<Result<Vec<_>, _>>()?;
    let signed = sign_release(&rel, &ks);
    write_atomic(out, &serde_json::to_vec_pretty(&signed).unwrap())?;
    Ok(json!({ "signed_by": ks.iter().map(|k| key_id(&k.verifying_key())).collect::<Vec<_>>() }))
}

/// 후보 바이너리가 snapshot 복사본에 migration을 적용할 수 있는지(쓰기 허용 전 시험).
pub fn migrate_check(db: &Path) -> Result<Value, String> {
    let d = crate::store::Db::open(db).map_err(|e| e.to_string())?;
    let v = d.schema_version();
    drop(d);
    crate::backup::verify(db)?;
    Ok(json!({ "schema": v }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }
    fn trust_of(k: &SigningKey) -> Trust {
        Trust { keys: vec![TrustedKey { key_id: key_id(&k.verifying_key()), public_key: B64.encode(k.verifying_key().as_bytes()) }], revoked: vec![] }
    }
    fn rel(v: &str) -> Value {
        json!({ "product": "grove", "channel": "stable", "version": v, "protocol": 1, "schema": 12, "issued_at": "2026-01-01T00:00:00Z", "artifacts": {} })
    }

    #[test]
    fn signature_must_match_trusted_key_and_content() {
        let k = key(1);
        let mut t = trust_of(&k);
        let m = sign_release(&rel("1.0.0"), &[k.clone()]);
        assert!(verify_manifest(&m.to_string(), &mut t).is_ok());
        // 내용 변조
        let mut bad = m.clone();
        bad["signed"]["version"] = json!("9.9.9");
        assert!(verify_manifest(&bad.to_string(), &mut t).is_err());
        // 모르는 키
        let other = sign_release(&rel("1.0.0"), &[key(2)]);
        assert!(verify_manifest(&other.to_string(), &mut t).is_err());
        // 키 순서가 달라도 같은 서명(정규화)
        let reordered: Value = serde_json::from_str(&m.to_string().replace("\"channel\":\"stable\",", "")).unwrap();
        let mut r2 = reordered.clone();
        r2["signed"]["channel"] = json!("stable");
        assert!(verify_manifest(&r2.to_string(), &mut t).is_ok());
    }

    #[test]
    fn rotation_then_revocation() {
        let (old, new) = (key(1), key(3));
        let mut t = trust_of(&old);
        let mut r = rel("1.1.0");
        r["rotate_keys"] = json!([{ "key_id": key_id(&new.verifying_key()), "public_key": B64.encode(new.verifying_key().as_bytes()) }]);
        verify_manifest(&sign_release(&r, &[old.clone()]).to_string(), &mut t).unwrap();
        // 새 키 단독 서명 수용
        verify_manifest(&sign_release(&rel("1.2.0"), &[new.clone()]).to_string(), &mut t).unwrap();
        // 새 키로 옛 키 폐기
        let mut r3 = rel("1.3.0");
        r3["revoke_keys"] = json!([key_id(&old.verifying_key())]);
        verify_manifest(&sign_release(&r3, &[new.clone()]).to_string(), &mut t).unwrap();
        assert!(verify_manifest(&sign_release(&rel("1.4.0"), &[old]).to_string(), &mut t).is_err(), "폐기된 키");
        // 신뢰하지 않는 키가 넣은 회전은 무효
        let mut t2 = trust_of(&new);
        let mut evil = rel("2.0.0");
        evil["rotate_keys"] = json!([{ "key_id": "x", "public_key": "y" }]);
        assert!(verify_manifest(&sign_release(&evil, &[key(9)]).to_string(), &mut t2).is_err());
        assert_eq!(t2.keys.len(), 1);
    }

    #[test]
    fn recovery_never_overwrites_new_writes() {
        // schema 그대로: 포인터만
        assert_eq!(recovery(13, 13, 100, 150), Recovery::PointerOnly);
        // migration 했지만 새 쓰기 없음: snapshot 복원
        assert_eq!(recovery(13, 14, 100, 100), Recovery::RestoreSnapshot);
        // migration 뒤 새 쓰기: 덮어쓰지 않음
        assert_eq!(recovery(13, 14, 100, 101), Recovery::NeedsAttention);
        // snapshot 이벤트 값을 읽지 못함(-1): 판단 불가 → 덮어쓰지 않음
        assert_eq!(recovery(13, 14, -1, -1), Recovery::NeedsAttention);
    }

    #[test]
    fn versions_compare_semver() {
        use std::cmp::Ordering::*;
        assert_eq!(cmp_version("0.2.0", "0.1.9"), Greater);
        assert_eq!(cmp_version("0.1.10", "0.1.9"), Greater);
        assert_eq!(cmp_version("1.0.0-rc.1", "1.0.0"), Less);
        assert_eq!(cmp_version("1.0.0+build", "1.0.0"), Equal);
    }
}
