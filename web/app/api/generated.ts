// 이 파일은 tests/integration/ts_bindings.rs가 Rust 계약에서 생성한다. 직접 수정하지 않는다.

export type EventRecord = { seq: number, created_at: string, kind: string, project_id: string | null, session_id: string | null, payload: unknown, };

export type SetupPreferences = { output_style: string, output_style_revision: number, output_style_options: Array<string>, };

export type SetupStatus = { required: boolean,
/**
 * 미완료 데몬의 등록 기기에 보내는 설정.
 */
preferences: SetupPreferences | null, };

export type DeviceInfo = { id: string, kind: string, name: string, created_at: string, last_used_at: string | null, revoked_at: string | null, parent_id: string | null, expires_at: string | null, current: boolean, };

export type PairingRequestInfo = { id: string, name: string, verification_code: string, created_at: string, expires_at: string, };

export type PairingInfo = { id: string, name: string, created_at: string, expires_at: string | null, revoked_at: string | null, consumed_at: string | null, device_id: string | null, failed_attempts: number, locked_at: string | null, requests: Array<PairingRequestInfo>, };

export type Followup = { id: string, session_id: string, kind: string, text: string, profile_id: string, agent_id: string | null, tools: boolean, created_at: string, effort: string | null, model: string | null, service_tier: string | null, native_command: string | null,
/**
 * 자동 시작이 막힌 이유(예: 결과 불명 작업 검토 필요). 사용자가 시작하거나 지울 때까지 남는다.
 */
last_error: { code: string, message: string } | null, attachments: unknown[], delivery_state: "pending" | "sending" | "rejected" | "unknown", };

export type Continuation = { id: string, session_id: string, origin_turn_id: string, kind: string, prompt: string, task_id: string | null, due_at: string, status: string, result_turn_id: string | null, error_code: string | null, created_at: string, };

export type Notification = { id: string, kind: string, title: string, body: string, project_id: string | null, session_id: string | null, ref_id: string | null, created_at: string, delivered_at: string | null, read_at: string | null, };

export type PushConfig = { public_key: string, subscriptions: Array<PushSubscription>, };

export type PushSubscription = { endpoint: string, revision: number, last_error: string | null, };

export type RoomMember = { id: string, name: string, profile_id: string | null, status: string, };

export type BotRoom = { session_id: string, project_id: string, name: string, members: Array<RoomMember>, };

export type Project = { id: string, name: string, root_path: string, created_at: string, updated_at: string, revision: number, archived_at: string | null,
/**
 * root 경로가 현재 접근 가능한 디렉터리인지
 */
available: boolean,
/**
 * 표시 아이콘(이모지·짧은 글자, PROJECT-002). 없으면 null.
 */
icon: string | null, icon_color?: number, icon_photo_sha256?: string,
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
workspace_mode: string,
/**
 * 사이드바 정리용 폴더. 실제 root 경로와는 무관하다.
 */
folder_id?: string, };

export type ProjectFolder = { id: string, name: string, revision: number, created_at: string, updated_at: string, project_count: number, };

export type Label = { id: string, name: string, color: string, revision: number, created_at: string, updated_at: string,
/**
 * 이 라벨이 붙은(보관 포함) 프로젝트 수. 삭제 전 영향 확인에 쓴다.
 */
project_count: number, };

export type SessionTurnModel = { turn_id: string, profile_id: string, model: string | null, };

export type SessionRecent = { id: string, revision: number, pinned: boolean, };

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
worktree_id: string | null,
/**
 * 목록·검색에서 기존 최근 항목의 고정 상태와 변경 revision을 함께 제공한다.
 */
recent?: SessionRecent,
/**
 * 대화 상세에서만 제공하는 마지막 사용자 턴의 모델 선택.
 */
last_model?: SessionTurnModel, };

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

export type SearchHit = { session: Session, project_name: string,
/**
 * 본문에서 찾았으면 그 메시지 seq와 앞뒤 발췌
 */
match_seq: number | null, snippet: string | null, };

export type SearchPage = { items: Array<SearchHit>,
/**
 * 필터에 맞는 전체 세션 수(offset·limit 적용 전)
 */
total: number, };

export type RecentItem = { id: string, kind: string, project_id: string, project_name: string, project_icon?: string, icon_color?: number, icon_photo_sha256?: string, resource_id: string, title: string, last_access_at: string, pinned: boolean, hidden: boolean, view_state: unknown, revision: number,
/**
 * 서버 상태로 계산한 값: active | queued | running | awaiting_approval | awaiting_input | completed | failed | interrupted | cancelled | unknown_result | archived | missing | project_unavailable
 */
status: string, unread: boolean,
/**
 * 가장 최근의 유효한 턴이 성공한 경우의 ID. 완료 확인은 메시지 읽음과 별개다.
 */
completed_turn_id: string | null, completion_unread: boolean,
/**
 * 대화의 마지막 사용자 메시지 시각(되돌린 메시지 제외). 다른 종류는 없음.
 */
last_user_message_at: string | null,
/**
 * 정렬·시간 범위 기준: 대화는 마지막 확정 답변 시각(없으면 생성 시각), 다른 자원은 마지막 접근 시각.
 */
last_activity_at: string, };

export type RecentPage = { items: Array<RecentItem>, next_offset: number | null, total: number, };

export type Definition = { kind: string, id: string, name: string, description: string, body: string, builtin: boolean,
/**
 * 기본 원문과 다른 필드 목록(builtin일 때)
 */
modified_fields: Array<string>, enabled: boolean,
/**
 * background | helper | orchestrated | workflow
 */
execution: string, profile_key: string | null, revision: number, body_sha256: string,
/**
 * 기본 원문 파일 sha256(builtin일 때)
 */
baseline_sha256: string | null, };

export type DefinitionDetail = { baseline_name: string | null, baseline_description: string | null, baseline_body: string | null, kind: string, id: string, name: string, description: string, body: string, builtin: boolean,
/**
 * 기본 원문과 다른 필드 목록(builtin일 때)
 */
modified_fields: Array<string>, enabled: boolean,
/**
 * background | helper | orchestrated | workflow
 */
execution: string, profile_key: string | null, revision: number, body_sha256: string,
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

export type ModelSelection = { profile_id: string, model: string | null, effort?: string, };

export type ModelFavorite = { profile_id: string, model: string, effort: string, fast: boolean, };

export type AgentBackend = { protocol: string, name: string, installed: boolean, read_only: boolean, };

export type AgentBackendCatalog = { backends: Array<AgentBackend>, };

export type LoginAttempt = { id: string, state: string, url: string | null, code: string | null, };

export type AgentAuthStatus = { authenticated: boolean | null, attempt: LoginAttempt | null, };

export type AccountUsageLimit = { label: string, remaining_percent: number | null, remaining: string | null, resets_at: string | null, };

export type AccountUsage = { protocol: string, name: string,
/**
 * available | unsupported | authentication_required | unavailable | rate_limited
 */
status: string, limits: Array<AccountUsageLimit>, checked_at: string, };

export type AccountUsageReport = { accounts: Array<AccountUsage>, };

export type UsageMetrics = { input_tokens: number, output_tokens: number, cache_read_tokens: number, cache_write_tokens: number, reasoning_tokens: number, cache_write_unreported_responses: number, reasoning_unreported_responses: number, responses: number, unreported_responses: number, measured_responses: number, measured_output_tokens: number, response_ms: number, cli_measured_responses: number, tok_per_second: number | null, low10_tok_per_second: number | null, high10_tok_per_second: number | null, };

export type UsageCost = { currency: string, amount: number, };

export type UsageEffortContext = { agent: string | null, model: string, effort: string | null, fast: boolean | null, };

export type UsageSlice = { key: string, label: string, provider: string, metrics: UsageMetrics, context?: UsageEffortContext, };

export type UsageBucket = { start: string, total: UsageMetrics, providers: Array<UsageSlice>, };

export type UsageDashboard = { from: string, to: string, interval: string, total: UsageMetrics, providers: Array<UsageSlice>, models: Array<UsageSlice>, projects: Array<UsageSlice>, agents: Array<UsageSlice>, workflows: Array<UsageSlice>, sessions: Array<UsageSlice>, efforts: Array<UsageSlice>, series: Array<UsageBucket>, estimated_cost: Array<UsageCost>, unpriced_tokens: number, pricing_versions: Array<string>, };

export type ModelCapabilities = { context_tokens: number | null, max_output_tokens: number | null, images: boolean | null, tools: boolean | null,
/**
 * Grove 도구 루프와 별개로 CLI 자체 편집·실행 도구를 사용하는지.
 */
native_tools?: boolean, effort: boolean | null, temperature: boolean | null, pdf: boolean, fast: boolean, };

export type AvailableModel = { id: string, name: string, reasoning_efforts?: Array<string>, default_reasoning_effort?: string, service_tiers?: Array<ModelServiceTier>, is_default?: boolean, };

export type ContextUsage = { tokens: number | null, context_window: number | null, };

export type ModelServiceTier = { id: string, name: string, description: string, };

export type ModelCatalog = { profile_id: string, profile_revision: number, models: Array<AvailableModel>, fetched_at: string, };

export type NativeCommand = { id: string, name: string, description: string, argument_hint: string, };

export type NativeCommandCatalog = { project_id: string, profile_id: string, protocol: string, commands: Array<NativeCommand>, has_errors: boolean, };

export type Turn = { id: string, session_id: string, status: string, request_message_id: string, profile_id: string | null, agent_id: string | null, workflow_id: string | null, tools_enabled: boolean, error: unknown, usage: unknown, step: number, created_at: string, updated_at: string, finished_at: string | null,
/**
 * 완료 이벤트에만 포함하는 최종 답변 미리보기.
 */
completion_preview?: string, definition: unknown,
/**
 * 실패·중단된 요청을 사용자가 확인(포기·다시 실행)한 시각(RUN-019). null이면 아직 확인 전.
 */
acknowledged_at: string | null,
/**
 * 확정되지 않은 응답의 중단 증거(REC). 없으면 null, 손상되면 `{ corrupt: true, kind, raw_sha256, raw_bytes }`.
 * 확정 답변과 별개이며 모델 입력에 넣지 않는다.
 */
evidence: { step: number; text: string; text_chars: number; truncated: boolean; tool_calls: string[]; reasoning_chars: number; captured_at: string; sha256: string; cli_execution_attempted?: boolean; cli_activity_count?: number; cli_activity?: { kind: string; name: string; status: string | null }[] } | { corrupt: true; kind: string; raw_sha256: string; raw_bytes: number } | null,
/**
 * 실행 슬롯 대기 중이면 대기 정보(FAIR-011). 다른 소유자의 상세는 개수로만.
 */
queue?: { ahead: number; active: number; limit: number; reason?: "provider" | "account" }, };

export type ToolCallRow = { id: string, session_id: string, project_id: string, turn_id: string | null, provider_call_id: string | null, name: string, args: unknown, target: unknown, status: string, needs_approval: boolean, revision: number, result: unknown, expires_at: string | null, created_at: string, updated_at: string, decided_at: string | null, started_at: string | null, finished_at: string | null, reviewed_at: string | null, review: unknown,
/**
 * 실행을 허락한 범위: once(이번만) | session(이 대화에서 계속) | policy(설정으로 사전 허용) | null(승인 불필요·미결정)
 */
approval_scope: string | null, };

export type FileChange = { id: string, turn_id: string | null,
/**
 * Grove 도구 호출 ID. CLI 턴 스냅샷은 빈 문자열로 전달한다.
 */
call_id: string, tool: string, path: string,
/**
 * created | modified | deleted
 */
op: string, before_sha: string | null, after_sha: string | null,
/**
 * 내용을 보관해 diff·undo/redo가 가능한지
 */
stored: boolean, undone_at: string | null, created_at: string, seq: number, };

export type FileChangeGroup = { turn_id: string | null, applied: number, undone: number, has_cli_snapshot?: boolean, };

export type FileChangePage = { items: Array<FileChange>, groups: Array<FileChangeGroup>, total: number, applied: number, through_seq: number, next_before_seq: number | null, };

export type FileEntry = { name: string, path: string, kind: "dir" | "file" | "link_outside" | "other", symlink: boolean, size: number | null, mtime: string | null, };

export type FileList = { path: string, entries: Array<FileEntry>, truncated: boolean, total: number, offset: number, has_more: boolean, };

export type FileContent = { path: string, size: number, sha256: string | null, preview: "text" | "image" | "svg" | "pdf" | "html", text: string | null, mtime?: string, reason?: string, stamp?: string, };

export type FileUnchanged = { unchanged: true, stamp: string, };

export type FileRead = FileContent | FileUnchanged;

export type GitEntry = { path: string, index: string, worktree: string, kind: string, orig_path?: string, };

export type GitStatusPage = { entries: Array<GitEntry>, total: number, unfiltered_total: number, offset: number, has_more: boolean, fingerprint: string | null, };

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

