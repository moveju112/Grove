//! 선언은 데이터다. 등록·관측된 capability만 비교하며 선택·설치·실행·승인을 만들지 않는다.
use super::{AllowedRoot, SkillCatalog, SkillSelection, SkillPriority, error, io_error, valid_name};
use crate::{approvals::{self, PolicyDecision}, error::ApiResult, tools::{self, ToolError, ToolResult}};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{collections::{BTreeMap, HashSet}, io, path::Path};

pub const MAX_MANIFEST_BYTES: u64 = 16 * 1024;
pub const MAX_ITEMS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Requirements {
    pub version: u32,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Problem {
    pub code: &'static str,
    pub message: String,
}

impl From<ToolError> for Problem {
    fn from(e: ToolError) -> Self { Self { code: e.code, message: e.message } }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Report {
    pub declaration: Option<Requirements>,
    pub status: Status,
    pub problems: Vec<Problem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status { Satisfied, Blocked, Unknown }

impl Default for Report {
    fn default() -> Self { Self { declaration: None, status: Status::Satisfied, problems: vec![] } }
}

fn parse(bytes: &[u8]) -> ToolResult<Requirements> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| error("skill_requirements_invalid", "요구 선언은 UTF-8 JSON이어야 합니다"))?;
    let requirements: Requirements = serde_json::from_str(text)
        .map_err(|_| error("skill_requirements_invalid", "요구 선언에는 version과 tools/platforms/skills 문자열 배열만 허용됩니다"))?;
    if requirements.version != 1 {
        return Err(error("skill_requirements_version", "지원하지 않는 요구 선언 version입니다"));
    }
    for values in [&requirements.tools, &requirements.platforms, &requirements.skills] {
        let mut seen = HashSet::new();
        if values.len() > MAX_ITEMS || values.iter().any(|value| !valid_name(value) || !seen.insert(value)) {
            return Err(error("skill_requirements_invalid", "요구 항목은 중복 없는 128 byte 이하 이름이며 배열당 최대 64개입니다"));
        }
    }
    Ok(requirements)
}

/// absent와 dangling link를 구별한다. body와 같은 열린 root·일반 파일·한도·교체 검사를 쓴다.
pub(super) fn load(root: &AllowedRoot, name: &str, body: &[u8]) -> ToolResult<(String, Report)> {
    let relative = Path::new(name).join("requirements.grove.json");
    match root.fs.dir.symlink_metadata(&relative) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Ok((crate::util::sha256_hex(body), Report::default()));
        }
        Err(e) => return Err(io_error(e)),
        Ok(_) => {}
    }
    let target = root.fs.dir.canonicalize(&relative).map_err(io_error)?;
    let bytes = root.fs.read(&root.path.join(&relative), MAX_MANIFEST_BYTES).map_err(io_error)?;
    if root.fs.dir.canonicalize(&relative).map_err(io_error)? != target {
        return Err(error("skill_changed", "조회 중 요구 선언 대상이 변경됐습니다"));
    }
    // tuple 직렬화로 경계를 고정한다. 원문·존재·canonical target 모두 revision에 결합한다.
    let identity = serde_json::to_vec(&(body, &bytes, target.as_os_str().as_encoded_bytes()))
        .map_err(|_| error("skill_requirements_invalid", "요구 선언 revision을 만들 수 없습니다"))?;
    let report = match parse(&bytes) {
        Ok(declaration) => Report { declaration: Some(declaration), status: Status::Unknown, problems: vec![] },
        Err(e) => Report { declaration: None, status: Status::Blocked, problems: vec![e.into()] },
    };
    Ok((crate::util::sha256_hex(&identity), report))
}

/// 화면은 다음 접수 조건을 알 수 없다. None을 supported로 바꾸지 않는다.
#[derive(Debug, Clone, Copy, Default)]
pub struct Invocation {
    pub tools_enabled: Option<bool>,
    pub model_tools: Option<bool>,
    pub cli: bool,
    pub profile_observed: bool,
}

pub struct Capabilities {
    pub platform: String,
    pub tools: BTreeMap<String, Report>,
}

impl Capabilities {
    pub fn observe(c: &Connection, session: &str, invocation: Invocation) -> ApiResult<Self> {
        let project = super::api::scope(c, session)?.0;
        let mut available = BTreeMap::new();
        for spec in tools::specs() {
            let mut report = Report::default();
            let mut reject = |code: &'static str, message: String, status| {
                // 확정 불충족 이유가 미확정 이유보다 앞선다.
                let problem = Problem { code, message };
                if status == Status::Blocked { report.problems.insert(0, problem); }
                else { report.problems.push(problem); }
                if report.status != Status::Blocked { report.status = status; }
            };
            if let PolicyDecision::Deny(code, message) = approvals::tool_policy(c, &project, session, &spec)? {
                reject(code, message, Status::Blocked);
            }
            if invocation.tools_enabled == Some(false) {
                reject("skill_tools_disabled", format!("{}: 이 호출의 Grove 도구가 꺼져 있습니다", spec.name), Status::Blocked);
            } else if invocation.tools_enabled.is_none() {
                reject("skill_invocation_unknown", format!("{}: 다음 호출의 도구 사용 설정은 아직 미확정입니다", spec.name), Status::Unknown);
            }
            if invocation.cli || invocation.model_tools == Some(false) {
                reject("skill_model_unsupported", format!("{}: 이 모델/CLI는 Grove 도구를 지원하지 않습니다", spec.name), Status::Blocked);
            } else if !invocation.profile_observed || invocation.model_tools.is_none() {
                reject("skill_model_unknown", format!("{}: 모델의 Grove 도구 capability가 확인되지 않았습니다", spec.name), Status::Unknown);
            }
            available.insert(spec.name.into(), report);
        }
        Ok(Self { platform: std::env::consts::OS.into(), tools: available })
    }
}

impl SkillCatalog {
    fn dependency(&self, name: &str, selected: &[SkillSelection]) -> ToolResult<usize> {
        let explicit: Vec<_> = selected.iter().filter_map(|binding| self.index(binding).ok())
            .filter(|&i| self.listing.entries[i].name == name).collect();
        if explicit.len() == 1 { return Ok(explicit[0]); }
        let candidates: Vec<_> = self.listing.entries.iter().enumerate().filter(|(_, e)| e.name == name).collect();
        if explicit.len() > 1 || candidates.iter().any(|(_, e)| matches!(e.priority, SkillPriority::Conflict | SkillPriority::Incomplete)) {
            return Err(error("skill_dependency_ambiguous", "의존 스킬 이름의 출처가 모호합니다. 정확한 출처를 먼저 명시적으로 선택하세요"));
        }
        candidates.into_iter().find(|(_, e)| e.priority == SkillPriority::Preferred).map(|(i, _)| i)
            .ok_or_else(|| error("skill_dependency_missing", "허용된 출처에 의존 스킬이 없습니다"))
    }

    fn check_cycle(&self, index: usize, selected: &[SkillSelection], visiting: &mut HashSet<usize>, done: &mut HashSet<usize>) -> ToolResult<()> {
        if done.contains(&index) { return Ok(()); }
        if !visiting.insert(index) {
            return Err(error("skill_dependency_cycle", "스킬 요구 선언에 순환 의존이 있습니다"));
        }
        if let Some(declaration) = &self.listing.entries[index].requirements.declaration {
            for name in &declaration.skills {
                self.check_cycle(self.dependency(name, selected)?, selected, visiting, done)?;
            }
        }
        visiting.remove(&index);
        done.insert(index);
        Ok(())
    }

    /// 후보는 사용자가 선택하려는 정확한 revision만 추가해서 판정한다. 의존 항목은 추가하지 않는다.
    pub fn requirements_report(&self, selection: &SkillSelection, selected: &[SkillSelection], capabilities: &Capabilities) -> Report {
        let index = match self.index(selection) {
            Ok(index) => index,
            Err(e) => return Report { declaration: None, status: Status::Blocked, problems: vec![e.into()] },
        };
        let mut report = self.listing.entries[index].requirements.clone();
        if report.status == Status::Blocked { return report; }
        report.status = Status::Satisfied;
        report.problems.clear();
        let Some(declaration) = report.declaration.clone() else { return report };
        let mut candidate = selected.to_vec();
        if !candidate.contains(selection) { candidate.push(selection.clone()); }
        let mut fail = |e: ToolError| {
            report.status = Status::Blocked;
            report.problems.push(e.into());
        };
        if let Err(e) = self.check_cycle(index, &candidate, &mut HashSet::new(), &mut HashSet::new()) { fail(e); }
        if !declaration.platforms.is_empty() && !declaration.platforms.contains(&capabilities.platform) {
            fail(ToolError::new("skill_platform_unsupported", format!("서버 플랫폼 {}이 요구 platforms에 없습니다", capabilities.platform)));
        }
        for name in &declaration.skills {
            match self.dependency(name, &candidate) {
                Ok(i) => {
                    let dependency = self.listing.entries[i].selection();
                    if !candidate.contains(&dependency) {
                        fail(ToolError::new("skill_dependency_unselected", format!("의존 스킬 {name}을 먼저 명시적으로 선택하세요")));
                    } else if let Err(e) = self.require_enabled(&dependency).and_then(|_| self.read(&dependency).map(|_| ())) {
                        fail(e);
                    }
                }
                Err(e) => fail(e),
            }
        }
        let mut required_tools: Vec<_> = declaration.tools.iter().collect();
        required_tools.sort_by_key(|name| capabilities.tools.get(*name).is_some_and(|r| r.status != Status::Blocked));
        for name in required_tools {
            match capabilities.tools.get(name) {
                None => {
                    report.status = Status::Blocked;
                    report.problems.push(ToolError::new("skill_tool_unregistered", format!("등록되지 않은 요구 도구: {name}")).into());
                }
                Some(observed) => {
                    if report.status != Status::Blocked && observed.status != Status::Satisfied { report.status = observed.status; }
                    if observed.status == Status::Blocked { report.status = Status::Blocked; }
                    report.problems.extend(observed.problems.clone());
                }
            }
        }
        report
    }

    pub fn validate_requirements(&self, selected: &[SkillSelection], capabilities: &Capabilities, require_known: bool) -> ToolResult<()> {
        for binding in selected {
            let report = self.requirements_report(binding, selected, capabilities);
            if report.status == Status::Blocked || (require_known && report.status == Status::Unknown) {
                let first = report.problems.first().expect("불충족 판정에는 이유가 있다");
                return Err(ToolError::new(first.code, first.message.clone()));
            }
        }
        Ok(())
    }
}
