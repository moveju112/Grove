// 이 파일은 tests/ts_bindings.rs가 Rust 계약에서 생성한다. 직접 수정하지 않는다.

export type EventRecord = { seq: number, created_at: string, kind: string, project_id: string | null, session_id: string | null, payload: unknown, };

export type DeviceInfo = { id: string, kind: string, name: string, created_at: string, last_used_at: string | null, revoked_at: string | null, parent_id: string | null, expires_at: string | null, current: boolean, };

export type PairingInfo = { id: string, name: string, created_at: string, expires_at: string, revoked_at: string | null, consumed_at: string | null, device_id: string | null, };

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
last_activity_at: string, };

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
status: string, unread: boolean, };

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

export type ModelCapabilities = { context_tokens: number | null, max_output_tokens: number | null, images: boolean | null, tools: boolean | null, effort: boolean | null, temperature: boolean | null, pdf: boolean, fast: boolean, };

export type AvailableModel = { id: string, name: string, };

export type ModelCatalog = { profile_id: string, profile_revision: number, models: Array<AvailableModel>, fetched_at: string, };

export type Turn = { id: string, session_id: string, status: string, request_message_id: string, profile_id: string | null, agent_id: string | null, workflow_id: string | null, tools_enabled: boolean, error: unknown, usage: unknown, step: number, created_at: string, updated_at: string, finished_at: string | null, definition: unknown, 
/**
 * 실패·중단된 요청을 사용자가 확인(포기·다시 실행)한 시각(RUN-019). null이면 아직 확인 전.
 */
acknowledged_at: string | null, 
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
 * active | removed | missing(경로가 사라짐)
 */
status: string, created_at: string, removed_at: string | null, };

