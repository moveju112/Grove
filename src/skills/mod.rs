//! RESOURCE-010/011/012/014: 허용된 root의 목록·본문·명시적 선택과 Grove 관리.
//!
//! 서버가 인증·프로젝트 권한 확인 후 `AllowedRoot`를 구성한다. client 경로를
//! 받지 않으며, ID는 경로로 역변환하지 않는다. I/O는 기존 ProjectFs capability만 쓴다.
//! 지원 형식은 root 바로 아래 `<name>/SKILL.md` UTF-8 파일이다. 이름은 디렉터리명,
//! metadata는 해석하지 않는다. 사용자 선택만 모델 지침에 적용하며 자동 매칭은 없다.

pub mod api;
pub mod management;
pub mod requirements;

use crate::project_fs::ProjectFs;
use crate::tools::{ToolError, ToolResult};
use crate::util::sha256_hex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};

pub const MAX_BODY_BYTES: u64 = 64 * 1024;
pub const MAX_SKILLS: usize = 256;
pub const MAX_SCANNED_ENTRIES: usize = 4096;
pub const MAX_ROOTS: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SkillSource {
    Global { root_id: String },
    Project { root_id: String, project_id: String },
}

impl SkillSource {
    fn root_id(&self) -> &str {
        match self {
            Self::Global { root_id } | Self::Project { root_id, .. } => root_id,
        }
    }

    fn tier(&self) -> u8 {
        match self {
            Self::Global { .. } => 0,
            Self::Project { .. } => 1,
        }
    }
}

/// 신뢰된 서버 코드 전용. 경로를 serialize/deserialize하거나 응답에 노출하지 않는다.
/// root_id는 같은 권한 범위·실제 root에 대해 안정적으로 유지하고 root 교체 시 갱신한다.
pub struct AllowedRoot {
    source: SkillSource,
    path: PathBuf,
    fs: ProjectFs,
    direct: bool,
}

impl AllowedRoot {
    pub fn open(source: SkillSource, path: &Path) -> ToolResult<Self> {
        if !valid_key(source.root_id())
            || matches!(&source, SkillSource::Project { project_id, .. } if !valid_key(project_id))
        {
            return Err(error("invalid_source", "출처 식별자가 올바르지 않습니다"));
        }
        let path = crate::util::canonical(path).map_err(io_error)?;
        let fs = ProjectFs::open(&path).map_err(io_error)?;
        Ok(Self { source, path, fs, direct: true })
    }

    /// 서버가 정한 부모에서 capability로 하위 root를 연다. client 경로는 받지 않는다.
    fn within(parent: &Path, relative: &Path, project_id: Option<&str>) -> ToolResult<Option<Self>> {
        let path = crate::util::canonical(parent).map_err(io_error)?;
        let mut fs = ProjectFs::open(&path).map_err(io_error)?;
        let target = match fs.dir.canonicalize(relative) {
            Ok(target) => target,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(io_error(err)),
        };
        // ProjectFs의 절대 경로→상대 경로 변환 기준은 그대로 두고 I/O 권한만 좁힌다.
        // path.join(name)은 실제 ambient I/O에 쓰이지 않고 열린 하위 Dir에 대한 name이 된다.
        let narrowed = fs.dir.open_dir(relative).map_err(io_error)?;
        if fs.dir.canonicalize(relative).map_err(io_error)? != target {
            return Err(error("skill_changed", "조회 중 스킬 출처가 변경됐습니다"));
        }
        fs.dir = narrowed;
        let root_id = format!("skillroot_{}", sha256_hex(
            &serde_json::to_vec(&(path.as_os_str().as_encoded_bytes(), target.as_os_str().as_encoded_bytes()))
                .map_err(|_| error("invalid_source", "스킬 출처를 확인할 수 없습니다"))?,
        ));
        let source = match project_id {
            Some(id) => SkillSource::Project { root_id, project_id: id.to_owned() },
            None => SkillSource::Global { root_id },
        };
        // 내부 root alias는 기존 읽기 정책으로 유지하되 원본 CLI 정의로 우회 저장하지 않는다.
        let direct = target == relative;
        Ok(Some(Self { source, path, fs, direct }))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillPriority {
    Preferred,
    Shadowed,
    Conflict,
    Incomplete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetadataSupport {
    None,
    OpaqueFrontMatter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillEntry {
    pub id: String,
    pub name: String,
    pub source: SkillSource,
    /// 선언이 없으면 본문 전체 bytes의 SHA-256, 있으면 본문·선언·대상을 결합한다.
    /// 본문/선언 또는 관리 활성 세대가 바뀌면 기존 선택은 무효다.
    pub revision: String,
    pub symlink: bool,
    /// 같은 root에서 같은 canonical 상대 경로로 향하는 다른 항목.
    /// hardlink나 다른 root 간 alias를 추측하지 않는다.
    pub alias_of: Option<String>,
    pub priority: SkillPriority,
    pub conflicts: Vec<String>,
    pub metadata: MetadataSupport,
    pub enabled: bool,
    /// 서버 관측 전용. client가 충족 상태를 제출해 검증을 우회할 수 없다.
    #[serde(skip_deserializing)]
    pub requirements: requirements::Report,
}

impl SkillEntry {
    pub fn selection(&self) -> SkillSelection {
        SkillSelection {
            id: self.id.clone(),
            source: self.source.clone(),
            revision: self.revision.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillSelection {
    pub id: String,
    pub source: SkillSource,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillBody {
    pub selection: SkillSelection,
    /// 원문을 그대로 표시한다. front matter도 추측해서 제거·변환하지 않는다.
    pub text: String,
    #[serde(skip_deserializing)]
    pub requirements: requirements::Report,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryIssue {
    pub source: SkillSource,
    pub name: Option<String>,
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillListing {
    pub entries: Vec<SkillEntry>,
    pub issues: Vec<DiscoveryIssue>,
}

struct Record {
    root: usize,
    name: String,
    target: PathBuf,
    generation: i64,
}

struct Loaded {
    target: PathBuf,
    text: String,
    revision: String,
    symlink: bool,
    metadata: MetadataSupport,
    requirements: requirements::Report,
}

pub struct SkillCatalog {
    roots: Vec<AllowedRoot>,
    listing: SkillListing,
    // listing.entries와 같은 순서이며 client가 바꿀 수 없다.
    records: Vec<Record>,
}

impl SkillCatalog {
    /// 하나의 인증된 프로젝트 문맥에 해당하는 전역·프로젝트 root만 전달한다.
    /// 한도 초과는 부분 우선순위를 제시하지 않고 전체 실패한다.
    pub fn discover(roots: Vec<AllowedRoot>) -> ToolResult<Self> {
        if roots.len() > MAX_ROOTS {
            return Err(error("skills_limit", "스킬 출처 수 제한을 넘었습니다"));
        }
        let mut source_ids = HashSet::new();
        let mut project = None;
        for root in &roots {
            if !source_ids.insert(root.source.root_id()) {
                return Err(error("invalid_source", "스킬 출처 식별자가 중복됐습니다"));
            }
            if let SkillSource::Project { project_id, .. } = &root.source {
                if project.is_some_and(|id| id != project_id) {
                    return Err(error("invalid_source", "서로 다른 프로젝트의 스킬을 섞을 수 없습니다"));
                }
                project = Some(project_id);
            }
        }
        let mut pairs = Vec::new();
        let mut issues = Vec::new();
        let mut scanned = 0;
        for (index, root) in roots.iter().enumerate() {
            let dir = root.fs.dir.read_dir(".").map_err(io_error)?;
            for entry in dir {
                scanned += 1;
                if scanned > MAX_SCANNED_ENTRIES {
                    return Err(error("skills_limit", "스킬 탐색 항목 수 제한을 넘었습니다"));
                }
                let entry = entry.map_err(io_error)?;
                let filename = entry.file_name();
                let Some(name) = filename.to_str().filter(|s| valid_name(s)) else {
                    issues.push(issue(root, None, "unsupported_name"));
                    continue;
                };
                // 중단된 추가의 비공개 staging은 완성된 스킬이나 alias 후보가 아니다.
                if name.starts_with(".grove-skill-") { continue; }
                let meta = match root.fs.dir.symlink_metadata(name) {
                    Ok(meta) => meta,
                    Err(err) => {
                        issues.push(issue(root, Some(name), io_error(err).code));
                        continue;
                    }
                };
                if !meta.is_dir() && !meta.file_type().is_symlink() {
                    continue;
                }
                let loaded = match load(root, name) {
                    Ok(loaded) => loaded,
                    Err(err) => {
                        // 일반 폴더에 SKILL.md가 없는 것은 스킬이 아니다.
                        if err.code != "skill_not_found" || meta.file_type().is_symlink() {
                            issues.push(issue(root, Some(name), err.code));
                        }
                        continue;
                    }
                };
                if pairs.len() == MAX_SKILLS {
                    return Err(error("skills_limit", "스킬 수 제한을 넘었습니다"));
                }
                let id_bytes = serde_json::to_vec(&(&root.source, name))
                    .map_err(|_| error("invalid_source", "스킬 식별자를 만들 수 없습니다"))?;
                let item = SkillEntry {
                    id: format!("skill_{}", sha256_hex(&id_bytes)),
                    name: name.to_owned(),
                    source: root.source.clone(),
                    revision: loaded.revision,
                    symlink: loaded.symlink,
                    alias_of: None,
                    priority: SkillPriority::Preferred,
                    conflicts: vec![],
                    metadata: loaded.metadata,
                    enabled: true,
                    requirements: loaded.requirements,
                };
                pairs.push((item, Record { root: index, name: name.to_owned(), target: loaded.target, generation: 0 }));
            }
        }
        pairs.sort_by(|(a, _), (b, _)| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
        let (mut entries, records): (Vec<_>, Vec<_>) = pairs.into_iter().unzip();
        let mut names: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        let mut targets: BTreeMap<(usize, PathBuf), Vec<usize>> = BTreeMap::new();
        for (index, entry) in entries.iter().enumerate() {
            names.entry(entry.name.clone()).or_default().push(index);
            targets.entry((records[index].root, records[index].target.clone())).or_default().push(index);
        }
        for group in names.values() {
            let highest = group.iter().map(|&i| entries[i].source.tier()).max().unwrap_or(0);
            let count = group.iter().filter(|&&i| entries[i].source.tier() == highest).count();
            let incomplete = issues.iter().any(|issue| issue.name.as_deref() == Some(entries[group[0]].name.as_str())
                && issue.source.tier() >= highest);
            for &i in group {
                entries[i].priority = if incomplete {
                    SkillPriority::Incomplete
                } else if entries[i].source.tier() != highest {
                    SkillPriority::Shadowed
                } else if count > 1 {
                    SkillPriority::Conflict
                } else {
                    SkillPriority::Preferred
                };
                entries[i].conflicts = group.iter().filter(|&&j| j != i).map(|&j| entries[j].id.clone()).collect();
            }
        }
        for group in targets.values() {
            // 가능하면 실제 디렉터리 항목을 대표로 삼는다. 동률은 안정적인 ID 순서다.
            let primary = *group.iter().min_by_key(|&&i| (entries[i].symlink, &entries[i].id)).unwrap();
            for &i in group {
                if i != primary {
                    entries[i].alias_of = Some(entries[primary].id.clone());
                }
            }
        }
        issues.sort_by(|a, b| a.source.root_id().cmp(b.source.root_id()).then(a.name.cmp(&b.name)).then(a.code.cmp(&b.code)));
        Ok(Self { roots, listing: SkillListing { entries, issues }, records })
    }

    pub fn listing(&self) -> &SkillListing {
        &self.listing
    }

    fn index(&self, selection: &SkillSelection) -> ToolResult<usize> {
        let index = self.listing.entries.iter().position(|item| item.id == selection.id)
            .ok_or_else(|| error("skill_not_found", "허용된 스킬 목록에 없는 식별자입니다"))?;
        let entry = &self.listing.entries[index];
        if entry.source != selection.source || entry.revision != selection.revision {
            return Err(error("skill_changed", "출처 또는 본문이 변경됐습니다. 다시 조회하고 선택하세요"));
        }
        Ok(index)
    }

    fn conflicting(&self, a: usize, b: usize) -> bool {
        self.listing.entries[a].name == self.listing.entries[b].name
            || (self.records[a].root == self.records[b].root && self.records[a].target == self.records[b].target)
    }

    /// 모든 본문 조회·선택 검증은 실제 capability I/O와 hash 확인을 다시 수행한다.
    pub fn read(&self, selection: &SkillSelection) -> ToolResult<SkillBody> {
        let index = self.index(selection)?;
        let record = &self.records[index];
        let loaded = load(&self.roots[record.root], &record.name)?;
        if loaded.target != record.target || management::revision(&loaded.revision, record.generation) != selection.revision {
            return Err(error("skill_changed", "출처 또는 본문이 변경됐습니다. 다시 조회하고 선택하세요"));
        }
        Ok(SkillBody { selection: selection.clone(), text: loaded.text, requirements: loaded.requirements })
    }
}

/// 명시적 선택만 보존한다. 우선순위는 안내일 뿐 자동 선택·대체·적용하지 않는다.
#[derive(Debug, Default)]
pub struct SkillSelections {
    bindings: Vec<SkillSelection>,
}

impl SkillSelections {
    pub fn bindings(&self) -> &[SkillSelection] {
        &self.bindings
    }

    /// 같은 이름/같은 root target을 중복 선택하려면 기존 선택을 먼저 명시적으로 해제한다.
    /// 동일 binding 재선택은 live 검증 후 멱등 성공한다. 실패는 상태를 바꾸지 않는다.
    pub fn select(&mut self, catalog: &SkillCatalog, selection: &SkillSelection) -> ToolResult<()> {
        catalog.require_enabled(selection)?;
        catalog.read(selection)?;
        let index = catalog.index(selection)?;
        for current in &self.bindings {
            if current == selection {
                return Ok(());
            }
            let existing = catalog.index(current)?;
            if catalog.conflicting(index, existing) {
                return Err(error("selection_conflict", "동명 스킬 또는 alias가 이미 선택됐습니다. 먼저 해제하세요"));
            }
        }
        self.bindings.push(selection.clone());
        Ok(())
    }

    /// 바뀌거나 삭제된 본문도 기존 binding 그대로 해제할 수 있다. 재전송은 부작용이 없다.
    pub fn deselect(&mut self, selection: &SkillSelection) -> bool {
        let before = self.bindings.len();
        self.bindings.retain(|current| current != selection);
        before != self.bindings.len()
    }

    /// 향후 통합 시 실제 소비 직전에 호출한다. 하나라도 stale이면 부분 본문을 반환하지 않는다.
    /// 반환은 검증된 데이터이며 모델 적용 여부를 뜻하지 않는다.
    pub fn validate(&self, catalog: &SkillCatalog) -> ToolResult<Vec<SkillBody>> {
        let mut seen = Vec::new();
        for binding in &self.bindings {
            catalog.require_enabled(binding)?;
            let index = catalog.index(binding)?;
            if seen.iter().any(|&previous| catalog.conflicting(index, previous)) {
                return Err(error("selection_conflict", "선택한 스킬이 동명 또는 alias로 겹칩니다. 다시 확인하세요"));
            }
            seen.push(index);
        }
        self.bindings.iter().map(|binding| catalog.read(binding)).collect()
    }
}

impl SkillCatalog {
    fn require_enabled(&self, selection: &SkillSelection) -> ToolResult<()> {
        let entry = self.listing.entries.iter()
            .find(|entry| entry.id == selection.id && entry.source == selection.source);
        if entry.is_some_and(|entry| !entry.enabled) {
            return Err(error("skill_disabled", "비활성 스킬은 적용할 수 없습니다. 기존 선택을 해제하세요"));
        }
        self.index(selection)?;
        Ok(())
    }
}

fn load(root: &AllowedRoot, name: &str) -> ToolResult<Loaded> {
    let rel = Path::new(name).join("SKILL.md");
    let target = root.fs.dir.canonicalize(&rel).map_err(io_error)?;
    let directory = root.fs.dir.symlink_metadata(name).map_err(io_error)?;
    let leaf = root.fs.dir.symlink_metadata(&rel).map_err(io_error)?;
    // ProjectFs는 열린 root를 기준으로 부모/leaf 교체·탈출·특수 파일·크기를 검사한다.
    let bytes = root.fs.read(&root.path.join(&rel), MAX_BODY_BYTES).map_err(io_error)?;
    let after = root.fs.dir.canonicalize(&rel).map_err(io_error)?;
    if target != after {
        return Err(error("skill_changed", "조회 중 스킬의 대상이 변경됐습니다"));
    }
    let (revision, requirements) = requirements::load(root, name, &bytes)?;
    if root.fs.dir.canonicalize(&rel).map_err(io_error)? != target {
        return Err(error("skill_changed", "조회 중 스킬의 대상이 변경됐습니다"));
    }
    let text = String::from_utf8(bytes).map_err(|_| error("unsupported_format", "UTF-8 스킬 본문만 지원합니다"))?;
    if text.contains('\0') {
        return Err(error("unsupported_format", "바이너리 스킬 본문은 지원하지 않습니다"));
    }
    let (front_matter, _) = crate::definitions::split_front_matter(&text);
    let metadata = if front_matter.is_empty() { MetadataSupport::None } else { MetadataSupport::OpaqueFrontMatter };
    Ok(Loaded {
        target, text, revision,
        symlink: directory.file_type().is_symlink() || leaf.file_type().is_symlink(),
        metadata, requirements,
    })
}

fn valid_key(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 128 && name != "." && name != ".."
        && !name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\'))
}

fn issue(root: &AllowedRoot, name: Option<&str>, code: &str) -> DiscoveryIssue {
    DiscoveryIssue { source: root.source.clone(), name: name.map(str::to_owned), code: code.to_owned() }
}

fn error(code: &'static str, message: &'static str) -> ToolError {
    ToolError::new(code, message)
}

// OS 오류 원문에는 root·symlink 대상·개인 경로가 포함될 수 있어 응답·로그에 넣지 않는다.
fn io_error(err: io::Error) -> ToolError {
    match err.kind() {
        io::ErrorKind::NotFound => error("skill_not_found", "스킬 출처 또는 본문이 없습니다"),
        io::ErrorKind::PermissionDenied => error("skill_forbidden", "허용된 출처 안에서 읽을 수 없습니다"),
        io::ErrorKind::FileTooLarge => error("skill_too_large", "스킬 본문 크기 제한을 넘었습니다"),
        io::ErrorKind::InvalidInput | io::ErrorKind::IsADirectory | io::ErrorKind::NotADirectory =>
            error("unsupported_format", "지원하는 일반 스킬 파일이 아닙니다"),
        _ => error("skill_read_failed", "스킬을 읽을 수 없습니다"),
    }
}
