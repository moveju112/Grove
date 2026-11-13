// 이 파일은 tests/ts_bindings.rs가 Rust 계약에서 생성한다. 직접 수정하지 않는다.

export type EventRecord = { seq: number, created_at: string, kind: string, project_id: string | null, session_id: string | null, payload: unknown, };

export type DeviceInfo = { id: string, kind: string, name: string, created_at: string, last_used_at: string | null, revoked_at: string | null, parent_id: string | null, expires_at: string | null, current: boolean, };

export type PairingRequestInfo = { id: string, name: string, verification_code: string, created_at: string, expires_at: string, };

export type PairingInfo = { id: string, name: string, created_at: string, expires_at: string | null, revoked_at: string | null, consumed_at: string | null, device_id: string | null, failed_attempts: number, locked_at: string | null, requests: Array<PairingRequestInfo>, };

export type Notification = { id: string, kind: string, title: string, body: string, project_id: string | null, session_id: string | null, ref_id: string | null, created_at: string, delivered_at: string | null, read_at: string | null, };

export type Project = { id: string, name: string, root_path: string, created_at: string, updated_at: string, revision: number, archived_at: string | null, 
/**
 * root 경로가 현재 접근 가능한 디렉터리인지
 */
available: boolean, 
/**
 * 표시 아이콘(이모지·짧은 글자, PROJECT-002). 없으면 null.
 */
icon: string | null, 
/**
 * 마지막 활동: 프로젝트 대화 중 가장 늦은 갱신 시각, 대화가 없으면 프로젝트 갱신 시각.
 */
last_activity_at: string, 
/**
 * 고정한 시각(PROJECT-008). 고정한 프로젝트는 목록 맨 위에 고정한 순서로 보인다.
 */
pinned_at: string | null, 
/**
 * 붙은 라벨 id(PROJECT-008, `/labels`).
 */
labels: Array<string>, 
/**
 * 초기 설정 script(PROJECT-010). 지정만으로는 실행하지 않는다.
 */
setup_script_id: string | null, 
/**
 * 워크스페이스 모드: "single" | "project"
 */
workspace_mode: string, };

export type Label = { id: string, name: string, color: string, revision: number, created_at: string, updated_at: string, 
/**
 * 이 라벨이 붙은(보관 포함) 프로젝트 수. 삭제 전 영향 확인에 쓴다.
 */
project_count: number, };

export type Session = { id: string, project_id: string, title: string, created_at: string, updated_at: string, revision: number, archived_at: string | null, parent_session_id: string | null, fork_message_seq: number | null, fork_inherits_context: boolean, workflow_id: string | null, last_message_seq: number, 
/**
 * 진행 중 턴 상태(없으면 null). 질문 답만 기다리면 awaiting_input(턴 자체 상태는 awaiting_approval, RUN-014).
 */
active_turn: string | null, pending_approvals: number, unreviewed_unknown: number, 
/**
 * 봇 대화면 봇 ID(모델·persona는 봇 설정을 따른다)
 */
bot_id: string | null, 
/**
 * 최근 사용자·assistant 메시지 앞부분
 */
preview: string | null, 
/**
 * 최근 항목에 기록된 읽은 위치보다 새 메시지가 있는지(열어 본 적 없으면 메시지가 있을 때 true)
 */
unread: boolean, 
/**
 * 이 대화가 들어가 있는 Grove worktree(없으면 프로젝트 폴더에서 실행, GIT-008)
 */
worktree_id: string | null, };

export type SessionPage = { items: Array<Session>, next_cursor: string | null, };

export type Message = { id: string, session_id: string, seq: number, role: string, content: unknown, turn_id: string | null, created_at: string, };

export type MessagePage = { items: Array<Message>, has_more_before: boolean, has_more_after: boolean, 
/**
 * rewind 때만 증가한다. 클라이언트는 이전 페이지와 진행 중 조회를 이 값으로 구분한다.
 */
timeline_revision: number, 
/**
 * 이 seq 이하는 압축된 구간이므로 rewind할 수 없다.
 */
rewind_boundary_seq: number | null, };

export type RecentItem = { id: string, kind: string, project_id: string, project_name: string, resource_id: string, title: string, last_access_at: string, pinned: boolean, hidden: boolean, view_state: unknown, revision: number, 
/**
 * 서버 상태로 계산한 값: active | running | awaiting_approval | awaiting_input | unknown_result | archived | missing | project_unavailable
 */
status: string, unread: boolean, 
/**
 * 대화의 마지막 사용자 메시지 시각(되돌린 메시지 제외). 다른 종류는 없음.
 */
last_user_message_at: string | null, 
/**
 * 정렬·시간 범위 기준: 마지막 접근과 마지막 사용자 메시지 중 늦은 시각.
 */
last_activity_at: string, };

export type RecentPage = { items: Array<RecentItem>, next_offset: number | null, total: number, };

export type Draft = { resource_key: string, text: string, revision: number, device_name: string, updated_at: string | null, };

export type Definition = { kind: string, id: string, name: string, description: string, body: string, builtin: boolean, 
/**
 * 기본 원문과 다른 필드 목록(builtin일 때)
 */
modified_fields: Array<string>, enabled: boolean, revision: number, body_sha256: string, 
/**
 * 기본 원문 파일 sha256(builtin일 때)
 */
baseline_sha256: string | null, };

export type DefinitionDetail = { baseline_name: string | null, baseline_description: string | null, baseline_body: string | null, kind: string, id: string, name: string, description: string, body: string, builtin: boolean, 
/**
 * 기본 원문과 다른 필드 목록(builtin일 때)
 */
modified_fields: Array<string>, enabled: boolean, revision: number, body_sha256: string, 
/**
 * 기본 원문 파일 sha256(builtin일 때)
 */
baseline_sha256: string | null, };

export type SecretInfo = { id: string, label: string, masked: string, created_at: string, updated_at: string, used_by: Array<string>, };

export type ModelProfile = { id: string, name: string, protocol: string, base_url: string, model: string, secret_id: string | null, options: unknown, revision: number, created_at: string, updated_at: string, 
/**
 * 마지막 연결 확인 결과(AUTH-001). 확인한 적 없으면 null.
 */
last_check: { ok: boolean, code: string | null, message: string | null, latency_ms: number, checked_at: string, detail: unknown } | null, enabled: boolean, capabilities: ModelCapabilities, };

export type AgentBackend = { protocol: string, name: string, installed: boolean, read_only: boolean, };

export type AgentBackendCatalog = { backends: Array<AgentBackend>, };

export type LoginAttempt = { id: string, state: string, url: string | null, code: string | null, };

export type AgentAuthStatus = { authenticated: boolean | null, attempt: LoginAttempt | null, };

export type ModelCapabilities = { context_tokens: number | null, max_output_tokens: number | null, images: boolean | null, tools: boolean | null, effort: boolean | null, temperature: boolean | null, pdf: boolean, fast: boolean, };

export type AvailableModel = { id: string, name: string, };

export type ModelCatalog = { profile_id: string, profile_revision: number, models: Array<AvailableModel>, fetched_at: string, };

export type Turn = { id: string, session_id: string, status: string, request_message_id: string, profile_id: string | null, agent_id: string | null, workflow_id: string | null, tools_enabled: boolean, error: unknown, usage: unknown, step: number, created_at: string, updated_at: string, finished_at: string | null, definition: unknown, 
/**
 * 실패·중단된 요청을 사용자가 확인(포기·다시 실행)한 시각(RUN-019). null이면 아직 확인 전.
 */
acknowledged_at: string | null, 
/**
 * 확정되지 않은 응답의 중단 증거(REC). 없으면 null, 손상되면 `{ corrupt: true, kind, raw_sha256, raw_bytes }`.
 * 확정 답변과 별개이며 모델 입력에 넣지 않는다.
 */
evidence: { step: number; text: string; text_chars: number; truncated: boolean; tool_calls: string[]; reasoning_chars: number; captured_at: string; sha256: string } | { corrupt: true; kind: string; raw_sha256: string; raw_bytes: number } | null, 
/**
 * 실행 슬롯 대기 중이면 대기 정보(FAIR-011). 다른 소유자의 상세는 개수로만.
 */
queue?: { ahead: number; active: number; limit: number; reason?: "provider" | "account" }, };

export type ToolCallRow = { id: string, session_id: string, project_id: string, turn_id: string | null, provider_call_id: string | null, name: string, args: unknown, target: unknown, status: string, needs_approval: boolean, revision: number, result: unknown, expires_at: string | null, created_at: string, updated_at: string, decided_at: string | null, started_at: string | null, finished_at: string | null, reviewed_at: string | null, review: unknown, 
/**
 * 실행을 허락한 범위: once(이번만) | session(이 대화에서 계속) | policy(tools.allow) | null(승인 불필요·미결정)
 */
approval_scope: string | null, };

export type FileChange = { id: string, turn_id: string | null, call_id: string, tool: string, path: string, 
/**
 * created | modified | deleted
 */
op: string, before_sha: string | null, after_sha: string | null, 
/**
 * 내용을 보관해 diff·undo/redo가 가능한지
 */
stored: boolean, undone_at: string | null, created_at: string, seq: number, };

export type Worktree = { id: string, project_id: string, name: string, path: string, branch: string, base: string | null, 
/**
 * active | removed | missing(경로가 사라짐) | unknown(생성 결과 미확정)
 */
status: string, created_at: string, removed_at: string | null, };

export type RemoteWatch = { id: string, project_id: string, session_id: string, 
/**
 * 원격 job을 시작한 로컬 명령(선택). 그 명령의 성공은 원격 job 성공과 별개다.
 */
task_id: string | null, title: string, url: string, status_pointer: string, success_values: Array<string>, failure_values: Array<string>, interval_secs: number, deadline_at: string, 
/**
 * watching·succeeded(원격 성공 값)·failed(원격 실패 값)·timed_out(감시 시간 초과)·cancelled(감시만 중단)·stopped(redirect 등 설정 오류로 중단)
 */
status: string, 
/**
 * 마지막으로 읽은 원격 상태 값(원문 문자열).
 */
remote_value: string | null, checks: number, last_checked_at: string | null, next_check_at: string | null, last_error: { code: string; message: string } | null, 
/**
 * 종료 알림 ID. 알림의 앱 전달·열람 상태는 알림 쪽에 따로 있다.
 */
notification_id: string | null, created_at: string, updated_at: string, finished_at: string | null, revision: number, };

