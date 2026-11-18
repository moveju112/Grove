//! SQLite 저장소. 쓰기 연결 하나를 직렬화해 사용하고, 모든 접근은 blocking 스레드에서 수행한다.
//! schema는 순방향 migration만 허용한다(DB-001).

use crate::error::{ApiError, ApiResult};
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// 순서대로 적용하는 migration 목록. 이미 배포된 항목은 수정하지 않고 새 항목만 추가한다.
pub const MIGRATIONS: &[&str] = &[
    // 1: 기반 — 토큰, idempotency, 이벤트, 프로젝트, 세션, 메시지
    r#"
    CREATE TABLE tokens (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('owner','device','browser')),
        name TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        parent_id TEXT REFERENCES tokens(id),
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT,
        revoked_at TEXT
    );
    CREATE TABLE idempotency (
        owner_id TEXT NOT NULL,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status INTEGER NOT NULL,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (owner_id, key)
    );
    CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        project_id TEXT,
        session_id TEXT,
        payload TEXT NOT NULL
    );
    CREATE INDEX events_session ON events(session_id, seq);
    CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        archived_at TEXT
    );
    CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        archived_at TEXT,
        parent_session_id TEXT REFERENCES sessions(id),
        fork_message_seq INTEGER,
        fork_inherits_context INTEGER NOT NULL DEFAULT 0,
        workflow_id TEXT,
        last_message_seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX sessions_project ON sessions(project_id, updated_at);
    CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system','note')),
        content TEXT NOT NULL,
        turn_id TEXT,
        model_input TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, seq)
    );
    "#,
    // 2: 최근 항목·레이아웃·초안
    r#"
    CREATE TABLE recent_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('session','file','terminal','project')),
        project_id TEXT NOT NULL REFERENCES projects(id),
        resource_id TEXT NOT NULL,
        title TEXT NOT NULL,
        last_access_at TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        view_state TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL DEFAULT 1,
        UNIQUE (kind, project_id, resource_id)
    );
    CREATE TABLE layouts (
        device_id TEXT PRIMARY KEY,
        layout TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE drafts (
        resource_key TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        revision INTEGER NOT NULL,
        device_name TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    "#,
    // 3: 실행 — 턴, 도구 호출(승인·receipt), 모델 설정, 비밀
    r#"
    CREATE TABLE secrets (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE model_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL CHECK (protocol IN ('openai','anthropic','gemini')),
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        secret_id TEXT REFERENCES secrets(id),
        options TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
    );
    CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        status TEXT NOT NULL CHECK (status IN ('queued','running','awaiting_approval','completed','failed','cancelled','interrupted')),
        request_message_id TEXT NOT NULL REFERENCES messages(id),
        profile_id TEXT REFERENCES model_profiles(id),
        agent_id TEXT,
        workflow_id TEXT,
        definition_snapshot TEXT NOT NULL DEFAULT '{}',
        tools_enabled INTEGER NOT NULL DEFAULT 0,
        owner_epoch TEXT NOT NULL,
        error TEXT,
        usage TEXT,
        step INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
    );
    CREATE INDEX turns_session ON turns(session_id, created_at);
    CREATE UNIQUE INDEX turns_one_active ON turns(session_id) WHERE status IN ('queued','running','awaiting_approval');
    CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        project_id TEXT NOT NULL REFERENCES projects(id),
        turn_id TEXT REFERENCES turns(id),
        provider_call_id TEXT,
        name TEXT NOT NULL,
        args TEXT NOT NULL,
        target TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending_approval','approved','denied','expired','running','succeeded','failed','unknown','cancelled')),
        needs_approval INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        precondition TEXT,
        result TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT,
        started_at TEXT,
        finished_at TEXT,
        reviewed_at TEXT,
        review TEXT
    );
    CREATE INDEX tool_calls_session ON tool_calls(session_id, created_at);
    CREATE INDEX tool_calls_status ON tool_calls(status);
    "#,
    // 4: 에이전트·워크플로우 정의(기본 원문은 실행 파일에 내장, 여기에는 사용자 수정본/사용자 정의만)
    r#"
    CREATE TABLE definitions (
        kind TEXT NOT NULL CHECK (kind IN ('agent','workflow')),
        id TEXT NOT NULL,
        builtin INTEGER NOT NULL,
        name TEXT,
        description TEXT,
        body TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        PRIMARY KEY (kind, id)
    );
    "#,
    // 5: 로그인 실패 잠금(NET-020/021). 재시작해도 유지된다.
    r#"
    CREATE TABLE login_failures (
        client TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        first_at TEXT NOT NULL,
        locked_until TEXT
    );
    "#,
    // 6: 범위별 설정(SETTINGS, CONFIG). scope_id: server는 '-'
    r#"
    CREATE TABLE settings (
        scope TEXT NOT NULL CHECK (scope IN ('server','project','session')),
        scope_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, scope_id, key)
    );
    "#,
    // 7: 백그라운드 작업(EXEC-003~013). 출력은 data_dir/tasks/<id>.{out,err} 파일.
    r#"
    CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        project_id TEXT NOT NULL REFERENCES projects(id),
        call_id TEXT,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','completed','failed','timeout','cancelled','unknown')),
        detached INTEGER NOT NULL,
        pid INTEGER,
        exit_code INTEGER,
        signal INTEGER,
        stdout_bytes INTEGER NOT NULL DEFAULT 0,
        stderr_bytes INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        result_message_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
    );
    CREATE INDEX tasks_session ON tasks(session_id, started_at);
    CREATE INDEX tasks_running ON tasks(status) WHERE status = 'running';
    "#,
    // 8: 터미널(TERM). 화면은 data_dir/terminals/<id>.screen 파일.
    r#"
    CREATE TABLE terminals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        shell TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','exited','lost')),
        exit_code INTEGER,
        reason TEXT,
        cols INTEGER NOT NULL,
        rows INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        ended_at TEXT
    );
    CREATE INDEX terminals_project ON terminals(project_id, created_at);
    "#,
    // 9: 자식 에이전트 작업(AGENT-001, 006~012). 자식은 같은 프로젝트의 자식 세션에서 실행된다.
    r#"
    CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL REFERENCES sessions(id),
        parent_turn_id TEXT,
        parent_call_id TEXT,
        child_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
        agent_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        tools_enabled INTEGER NOT NULL,
        depth INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled','interrupted')),
        last_turn_id TEXT,
        delivered_turn_id TEXT,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT
    );
    CREATE INDEX agent_runs_parent ON agent_runs(parent_session_id, created_at);
    CREATE INDEX agent_runs_turn ON agent_runs(last_turn_id);
    "#,
    // 10: 대화별 Goal 목록(AGENT-017/018). position은 정렬용 정수(작을수록 앞).
    r#"
    CREATE TABLE goals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','in_progress','done','cancelled')),
        position INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX goals_session ON goals(session_id, position);
    "#,
    // 11: 예약 실행(AUTO)과 영속 알림(AUTO-011/012)
    r#"
    CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        agent_id TEXT,
        tools_enabled INTEGER NOT NULL,
        allowed_tools TEXT,
        max_total_tokens INTEGER,
        kind TEXT NOT NULL CHECK (kind IN ('once','interval','daily')),
        at TEXT,
        interval_minutes INTEGER,
        daily_time TEXT,
        tz_offset_minutes INTEGER NOT NULL DEFAULT 0,
        session_mode TEXT NOT NULL CHECK (session_mode IN ('new','same')),
        session_id TEXT,
        on_approval TEXT NOT NULL CHECK (on_approval IN ('wait','fail')),
        missed_grace_minutes INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','paused','done','deleted')),
        next_run_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX schedules_due ON schedules(status, next_run_at);
    CREATE TABLE schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES schedules(id),
        planned_at TEXT NOT NULL,
        manual INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled','interrupted','skipped_overlap','missed','start_failed')),
        session_id TEXT,
        turn_id TEXT,
        detail TEXT,
        created_at TEXT NOT NULL,
        ended_at TEXT,
        UNIQUE (schedule_id, planned_at)
    );
    CREATE INDEX schedule_runs_turn ON schedule_runs(turn_id);
    CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        project_id TEXT,
        session_id TEXT,
        ref_id TEXT,
        created_at TEXT NOT NULL,
        read_at TEXT
    );
    CREATE INDEX notifications_unread ON notifications(read_at, created_at);
    "#,
    // 12: 봇(BOT-001~008). 위임 역할(definitions)과 별도 저장한다.
    r#"
    CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        persona TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        profile_id TEXT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        featured INTEGER NOT NULL DEFAULT 0,
        avatar_color TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','disabled','deleted')),
        home_session_id TEXT UNIQUE REFERENCES sessions(id),
        home_seen_seq INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
    );
    CREATE UNIQUE INDEX bots_name ON bots(name) WHERE status != 'deleted';
    CREATE TABLE bot_order (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        ids TEXT NOT NULL,
        revision INTEGER NOT NULL
    );
    INSERT INTO bot_order (singleton, ids, revision) VALUES (1, '[]', 1);
    ALTER TABLE sessions ADD COLUMN bot_id TEXT REFERENCES bots(id);
    CREATE INDEX sessions_bot ON sessions(bot_id);
    "#,
    // 13: 목록·사용량 조회 인덱스(DB-011). 알림은 (created_at, id) keyset cursor, 사용량은 메시지 시각 범위.
    r#"
    CREATE INDEX notifications_created ON notifications(created_at, id);
    CREATE INDEX messages_created ON messages(created_at);
    "#,
    // 14: 승인 범위(SEC-009). approval_scope: once=이번만, session=이 대화에서 계속(grant), policy=tools.allow
    r#"
    CREATE TABLE session_tool_grants (
        session_id TEXT NOT NULL REFERENCES sessions(id),
        tool TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        PRIMARY KEY (session_id, tool)
    );
    ALTER TABLE tool_calls ADD COLUMN approval_scope TEXT;
    "#,
    // 15: 감사 기록(SEC-023). 이벤트(보존 범위가 짧다)와 달리 지우지 않는다. 비밀 값은 넣지 않는다.
    r#"
    CREATE TABLE audit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor_token_id TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        detail TEXT NOT NULL
    );
    "#,
    // 16: 이전(import) ID 매핑과 검증 결과(MIG-005, 012, 013). 한 원본 대화 = 한 행, 같은 transaction에서 기록.
    r#"
    CREATE TABLE import_map (
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        source_hash TEXT NOT NULL,
        item_count INTEGER NOT NULL,
        imported_at TEXT NOT NULL,
        report TEXT NOT NULL,
        PRIMARY KEY (source, source_id)
    );
    CREATE INDEX import_map_session ON import_map(session_id);
    "#,
    // 17: 공정 실행(FAIR-002). 소유자 key는 서버가 정한다(인증 토큰의 소유 주체·예약·부모 에이전트 상속).
    r#"
    ALTER TABLE turns ADD COLUMN owner_key TEXT NOT NULL DEFAULT 'owner';
    CREATE INDEX turns_owner_active ON turns(owner_key) WHERE status IN ('queued','running');
    "#,
    // 18: CLI 백엔드 세션(claude_code·codex_cli). Grove 대화×프로필마다 CLI 자체 세션 ID를 이어 쓴다.
    r#"
    CREATE TABLE cli_sessions (
        session_id TEXT NOT NULL REFERENCES sessions(id),
        profile_id TEXT NOT NULL,
        native_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, profile_id)
    );
    "#,
    // 19: model_profiles.protocol의 CHECK 제거(CLI 백엔드 claude_code·codex_cli 추가). 허용 값은 앱(validate_profile)이 검증한다.
    // SQLite는 CHECK를 바꿀 수 없어 표를 다시 만든다. turns가 참조하므로 외래 키 검사를 끈 채 실행하고 끝난 뒤 검사한다.
    r#"-- grove:rebuild
    CREATE TABLE model_profiles_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        secret_id TEXT REFERENCES secrets(id),
        options TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
    );
    INSERT INTO model_profiles_new (id, name, protocol, base_url, model, secret_id, options, revision, created_at, updated_at, deleted_at)
        SELECT id, name, protocol, base_url, model, secret_id, options, revision, created_at, updated_at, deleted_at FROM model_profiles;
    DROP TABLE model_profiles;
    ALTER TABLE model_profiles_new RENAME TO model_profiles;
    "#,
    // 20: 실행 중 추가 메시지(RUN-007·008). queue는 다음 턴, steer는 다음 모델 호출 경계, interrupt는 취소 후 바로 시작.
    r#"
    CREATE TABLE followups (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        kind TEXT NOT NULL CHECK (kind IN ('queue','steer','interrupt')),
        text TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        agent_id TEXT,
        tools INTEGER NOT NULL DEFAULT 0,
        owner_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_error TEXT
    );
    CREATE INDEX followups_session ON followups(session_id);
    "#,
    // 21: 질문 도구(RUN-013·014). 답변 대기 호출 상태 awaiting_input을 추가한다(승인 대기 pending_approval과 구분).
    // CHECK를 바꾸려면 표를 다시 만든다. tool_calls를 참조하는 표는 없다.
    r#"-- grove:rebuild
    CREATE TABLE tool_calls_new (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        project_id TEXT NOT NULL REFERENCES projects(id),
        turn_id TEXT REFERENCES turns(id),
        provider_call_id TEXT,
        name TEXT NOT NULL,
        args TEXT NOT NULL,
        target TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending_approval','awaiting_input','approved','denied','expired','running','succeeded','failed','unknown','cancelled')),
        needs_approval INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        precondition TEXT,
        result TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT,
        started_at TEXT,
        finished_at TEXT,
        reviewed_at TEXT,
        review TEXT,
        approval_scope TEXT
    );
    INSERT INTO tool_calls_new (id, session_id, project_id, turn_id, provider_call_id, name, args, target, status, needs_approval, revision, precondition, result,
        expires_at, created_at, updated_at, decided_at, started_at, finished_at, reviewed_at, review, approval_scope)
        SELECT id, session_id, project_id, turn_id, provider_call_id, name, args, target, status, needs_approval, revision, precondition, result,
        expires_at, created_at, updated_at, decided_at, started_at, finished_at, reviewed_at, review, approval_scope FROM tool_calls;
    DROP TABLE tool_calls;
    ALTER TABLE tool_calls_new RENAME TO tool_calls;
    CREATE INDEX tool_calls_session ON tool_calls(session_id, created_at);
    CREATE INDEX tool_calls_status ON tool_calls(status);
    "#,
    // 22: 모델 프로필 연결 확인 결과(AUTH-001). 마지막 한 번만 보관한다.
    r#"
    CREATE TABLE profile_checks (
        profile_id TEXT PRIMARY KEY REFERENCES model_profiles(id),
        ok INTEGER NOT NULL,
        code TEXT,
        message TEXT,
        detail TEXT NOT NULL DEFAULT '{}',
        latency_ms INTEGER NOT NULL,
        checked_at TEXT NOT NULL
    );
    "#,
    // 23: 실행 중 보낸 추가 메시지도 보낼 때 고른 추론 강도를 지킨다(UI-020).
    r#"
    ALTER TABLE followups ADD COLUMN effort TEXT;
    "#,
    // 24: 실패·중단된 요청을 사용자가 확인(포기·다시 실행)한 시각(RUN-019). 확인하면 배너를 닫는다(모든 기기).
    r#"
    ALTER TABLE turns ADD COLUMN acknowledged_at TEXT;
    "#,
    // 25: rewind는 원문·실행 감사 기록을 보관하고 활성 타임라인에서만 제외한다. seq는 재사용하지 않는다.
    r#"
    ALTER TABLE messages ADD COLUMN rewound_at TEXT;
    ALTER TABLE sessions ADD COLUMN timeline_revision INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX messages_visible_page ON messages(session_id, seq) WHERE rewound_at IS NULL;
    "#,
    // 26: 모델 응답 stream의 마지막 실제 진행 시각(RUN-023). 서버가 강제 종료돼도 중단 원인에 남는다.
    r#"
    ALTER TABLE turns ADD COLUMN progress_at TEXT;
    "#,
    // 27: 프로젝트 아이콘(PROJECT-002). 이모지나 짧은 글자, 없으면 NULL.
    r#"
    ALTER TABLE projects ADD COLUMN icon TEXT;
    "#,
    // 28: 세션별 파일 변경 이력(GIT-011~014). 내용은 sha256 이름의 blob 파일, 행은 변경 한 건.
    // before/after_sha가 NULL이면 그 시점에 파일이 없었다는 뜻이다. undone_at이 있으면 되돌린 상태다.
    r#"
    CREATE TABLE file_changes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        turn_id TEXT,
        call_id TEXT NOT NULL REFERENCES tool_calls(id),
        tool TEXT NOT NULL,
        path TEXT NOT NULL,
        before_sha TEXT,
        after_sha TEXT,
        stored INTEGER NOT NULL DEFAULT 1,
        undone_at TEXT,
        created_at TEXT NOT NULL,
        seq INTEGER NOT NULL
    );
    CREATE INDEX file_changes_session ON file_changes(session_id, seq);
    CREATE INDEX file_changes_turn ON file_changes(turn_id);
    "#,
    // 29: 보관한 내용 blob의 크기·생성 시각(DB-013). 참조 수는 file_changes에서 계산하고, 참조가 없으면 정리한다.
    r#"
    CREATE TABLE blobs (
        sha TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE INDEX file_changes_before ON file_changes(before_sha);
    CREATE INDEX file_changes_after ON file_changes(after_sha);
    "#,
    // 30: 제한된 저장 공간 검사와 미확정 휴지통 작업 보존(DB-014·019).
    r#"
    CREATE INDEX file_changes_stored ON file_changes(stored) WHERE stored = 1;
    CREATE INDEX idempotency_created ON idempotency(created_at);
    CREATE INDEX idempotency_unknown_trash ON idempotency(json_extract(response, '$.error.details.trash_id'))
        WHERE status = 409 AND json_extract(response, '$.error.code') = 'result_unknown';
    "#,
    // 31: 첨부 원문과 메시지 소유 관계. 참조 수는 FK로 관리하는 참조 행에서 계산한다.
    r#"
    CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        stored INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
    );
    CREATE INDEX attachments_sha ON attachments(sha256);
    CREATE TABLE attachment_refs (
        attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        PRIMARY KEY (attachment_id, message_id)
    );
    CREATE INDEX attachment_refs_message ON attachment_refs(message_id);
    "#,
    // 32: 이미지 원문 metadata. 모델용 축소본은 요청 시 제한된 메모리로 만든다.
    r#"ALTER TABLE attachments ADD COLUMN image TEXT;"#,
    // 33: 실행 대기 중인 첨부도 GC·명시적 삭제에서 보호한다.
    r#"
    ALTER TABLE followups ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
    CREATE TABLE followup_attachment_refs (
        attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        followup_id TEXT NOT NULL REFERENCES followups(id) ON DELETE CASCADE,
        PRIMARY KEY (attachment_id, followup_id)
    );
    CREATE INDEX followup_attachment_refs_item ON followup_attachment_refs(followup_id);
    "#,
    // 34: 작업이 로그의 소유자·단일 참조다. 이전 로그는 제한된 검사에서 크기·hash를 채운다.
    r#"
    CREATE TABLE task_logs (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        stream TEXT NOT NULL CHECK(stream IN ('out','err')),
        storage_key TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL DEFAULT 0 CHECK(size >= 0),
        sha256 TEXT,
        state TEXT NOT NULL CHECK(state IN ('writing','ready','error','missing','expired')),
        error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(task_id,stream)
    );
    INSERT INTO task_logs(task_id,stream,storage_key,state,updated_at)
        SELECT t.id,s.stream,'tasks/'||t.id||'.'||s.stream,'writing',COALESCE(t.ended_at,t.started_at)
        FROM tasks t CROSS JOIN (SELECT 'out' AS stream UNION ALL SELECT 'err') s;
    "#,
    // 35: 자동 영구 삭제의 마지막 파일 정리와 완료 이벤트 사이 복구 증거다.
    r#"
    CREATE TABLE trash_gc (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        origin_sha256 TEXT NOT NULL
    );
    "#,
    // 36: Grove가 만든 worktree(GIT-007~010). 이 표에 있는 것만 Grove 소유이고 제거할 수 있다.
    // 대화의 worktree_id가 있으면 그 대화의 도구·작업은 worktree 경로에서 실행한다(NULL이면 프로젝트 폴더).
    r#"
    CREATE TABLE worktrees (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL,
        base TEXT,
        status TEXT NOT NULL CHECK (status IN ('active','removed','missing')),
        created_at TEXT NOT NULL,
        removed_at TEXT
    );
    CREATE INDEX worktrees_project ON worktrees(project_id, status);
    ALTER TABLE sessions ADD COLUMN worktree_id TEXT;
    "#,
    // 37: 만료·일회성 소비·폐기를 같은 transaction으로 판정하는 페어링. 원문 비밀은 저장하지 않는다.
    r#"
    CREATE TABLE pairings (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        issuer_id TEXT NOT NULL REFERENCES tokens(id),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        consumed_at TEXT,
        device_id TEXT REFERENCES tokens(id)
    );
    CREATE INDEX pairings_issuer ON pairings(issuer_id,created_at);
    "#,
    // 38: 알림 저장·앱 수신·명시적 열람을 분리한다. 기존 읽음은 앱 수신도 확인된 상태다.
    r#"
    ALTER TABLE notifications ADD COLUMN delivered_at TEXT;
    UPDATE notifications SET delivered_at=read_at WHERE read_at IS NOT NULL;
    CREATE INDEX notifications_ref_created ON notifications(ref_id,created_at,id);
    "#,
    // 39: 프로필 비활성화는 설정을 지우지 않고 새 실행을 차단한다.
    r#"
    ALTER TABLE model_profiles ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1));
    "#,
    // 40: 암호화 함수 등록 후 실행하는 자격 데이터 backfill의 완료를 원자적으로 기록한다.
    r#"
    CREATE TABLE credential_backfills (
        name TEXT PRIMARY KEY,
        completed_at TEXT NOT NULL
    );
    "#,
    // 41: 생성 접수의 소유권을 Git 실행 전에 보존하고 결과 미확정을 active와 구분한다.
    r#"
    CREATE TABLE worktrees_next (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL,
        base TEXT,
        status TEXT NOT NULL CHECK (status IN ('active','removed','missing','unknown')),
        created_at TEXT NOT NULL,
        removed_at TEXT
    );
    INSERT INTO worktrees_next SELECT * FROM worktrees;
    DROP TABLE worktrees;
    ALTER TABLE worktrees_next RENAME TO worktrees;
    CREATE INDEX worktrees_project ON worktrees(project_id, status);
    "#,
    // 42: 직접 확인한 장기 기억. 모델이 자동으로 추가·수정하는 경로는 제공하지 않는다.
    r#"
    CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id),
        body TEXT NOT NULL,
        source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX memories_scope ON memories(project_id,created_at,id);
    CREATE UNIQUE INDEX memories_global_body ON memories(body) WHERE project_id IS NULL;
    CREATE UNIQUE INDEX memories_project_body ON memories(project_id,body) WHERE project_id IS NOT NULL;
    ALTER TABLE cli_sessions ADD COLUMN system_sha256 TEXT;
    "#,
    // 43: 프로젝트 script 정의와 실제 접수한 실행 snapshot. 삭제해도 과거 작업의 출처는 유지한다.
    r#"
    CREATE TABLE project_scripts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
    );
    CREATE UNIQUE INDEX project_scripts_name ON project_scripts(project_id,name) WHERE deleted_at IS NULL;
    ALTER TABLE tasks ADD COLUMN script_snapshot TEXT CHECK(script_snapshot IS NULL OR json_valid(script_snapshot));
    "#,
    // 44: 최근 항목 숨김 시각(RECENT-001). 그 뒤 새 사용자 메시지가 오면 다시 보인다. 이전 숨김(NULL)은 다시 열 때까지 유지한다.
    r#"
    ALTER TABLE recent_items ADD COLUMN hidden_at TEXT;
    "#,
    // 45: 반복 예약의 자동 실행 횟수·종료 시각과 연속 실패 안전장치(AUTO-009). 기존 예약은 자동 정지를 켜지 않는다.
    r#"
    ALTER TABLE schedules ADD COLUMN max_runs INTEGER CHECK (max_runs IS NULL OR max_runs > 0);
    ALTER TABLE schedules ADD COLUMN end_at TEXT;
    ALTER TABLE schedules ADD COLUMN pause_after_failures INTEGER CHECK (pause_after_failures IS NULL OR pause_after_failures > 0);
    ALTER TABLE schedules ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE schedules ADD COLUMN last_failed_at TEXT;
    ALTER TABLE schedules ADD COLUMN paused_reason TEXT CHECK (paused_reason IS NULL OR paused_reason IN ('user','failures'));
    "#,
    // 46: 확정되지 않은 모델 응답의 중단 증거(REC). 답변 확정 commit에서만 지운다. 이전 턴은 NULL(증거 기록 이전)로 둔다.
    r#"
    ALTER TABLE turns ADD COLUMN evidence TEXT;
    "#,
    // 47: 원격 job 완료 감시(EXEC-014~017). 정확한 URL의 GET 조회 상태와 종료 알림을 연결한다.
    r#"
    CREATE TABLE remote_watches (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        task_id TEXT REFERENCES tasks(id),
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        status_pointer TEXT NOT NULL,
        success_values TEXT NOT NULL,
        failure_values TEXT NOT NULL,
        interval_secs INTEGER NOT NULL CHECK (interval_secs BETWEEN 10 AND 3600),
        deadline_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('watching','succeeded','failed','timed_out','cancelled','stopped')),
        remote_value TEXT,
        checks INTEGER NOT NULL DEFAULT 0,
        last_checked_at TEXT,
        next_check_at TEXT,
        last_error TEXT,
        notification_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX remote_watches_session ON remote_watches(session_id, created_at);
    CREATE INDEX remote_watches_due ON remote_watches(status, next_check_at);
    "#,
    // 48: 작업공간(프로젝트) 고정과 색상 라벨(PROJECT-008). 라벨 이름은 공백 정리 뒤 대소문자 무시 고유, 할당은 프로젝트별 여러 개.
    r#"
    ALTER TABLE projects ADD COLUMN pinned_at TEXT;
    CREATE TABLE labels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE project_labels (
        project_id TEXT NOT NULL REFERENCES projects(id),
        label_id TEXT NOT NULL REFERENCES labels(id),
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, label_id)
    );
    CREATE INDEX project_labels_label ON project_labels(label_id);
    "#,
    // 49: 초기 설정 script 지정과 실행 위치(프로젝트 폴더·worktree)별 설정 실행 기록(PROJECT-010). 상태는 작업 상태에서 읽는다.
    r#"
    ALTER TABLE projects ADD COLUMN setup_script_id TEXT;
    CREATE TABLE setup_runs (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        project_id TEXT NOT NULL REFERENCES projects(id),
        worktree_id TEXT,
        script_id TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE INDEX setup_runs_target ON setup_runs(project_id, worktree_id, created_at);
    "#,
    // 50: 봇 사용자 아바타(BOT-003). 검사·디코딩 뒤 다시 인코딩한 정사각 PNG만 저장한다. 없으면 기본형(색+이니셜).
    r#"
    CREATE TABLE bot_avatars (
        bot_id TEXT PRIMARY KEY REFERENCES bots(id),
        png BLOB NOT NULL,
        sha256 TEXT NOT NULL,
        source_mime TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        updated_at TEXT NOT NULL
    );
    "#,
    // 51: 예약의 담당 봇(RTE-001). 같은 예약 엔진·receipt를 쓰고, 결과는 실행 시점의 봇 home에 전달한다.
    r#"
    ALTER TABLE schedules ADD COLUMN bot_id TEXT REFERENCES bots(id);
    CREATE INDEX schedules_bot ON schedules(bot_id) WHERE bot_id IS NOT NULL;
    "#,
    // 52: 예약 webhook(RTE-004·005, AUTO-010). 비밀은 vault로 암호화해 저장하고, 수신 receipt는 (예약, event ID)로 한 번만 접수한다.
    r#"
    CREATE TABLE schedule_webhooks (
        schedule_id TEXT PRIMARY KEY REFERENCES schedules(id),
        secret TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE webhook_receipts (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES schedules(id),
        event_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        body_sha256 TEXT NOT NULL,
        body_bytes INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        run_id TEXT REFERENCES schedule_runs(id),
        UNIQUE (schedule_id, event_id)
    );
    CREATE INDEX webhook_receipts_recent ON webhook_receipts(schedule_id, received_at);
    "#,
    // 53: 자동 실행 결과 분류와 조용한 종료(QUIET-001~007). 실행 상태와 별도로 결과 분류·근거·알림 여부를 남긴다.
    r#"
    ALTER TABLE schedules ADD COLUMN quiet_policy TEXT NOT NULL DEFAULT 'off' CHECK (quiet_policy IN ('off','unchanged_result'));
    ALTER TABLE schedule_runs ADD COLUMN result_class TEXT;
    ALTER TABLE schedule_runs ADD COLUMN result_sha256 TEXT;
    ALTER TABLE schedule_runs ADD COLUMN result_evidence TEXT;
    ALTER TABLE schedule_runs ADD COLUMN notified INTEGER;
    "#,
    // 54: MCP 서버 등록. 연결·도구 실행 상태는 저장 설정과 구분한다.
    r#"
    CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        config TEXT NOT NULL CHECK(json_valid(config)),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        timeout_secs INTEGER NOT NULL CHECK(timeout_secs BETWEEN 1 AND 300),
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    "#,
    // 55: MCP 연결 확인 receipt. 확인마다 한 번만 시작하고 재시작은 중단으로 확정한다.
    r#"
    CREATE TABLE mcp_checks (
        server_id TEXT PRIMARY KEY REFERENCES mcp_servers(id) ON DELETE CASCADE,
        id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('checking','ready','failed','interrupted')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        detail TEXT NOT NULL DEFAULT '{}',
        owner_id TEXT NOT NULL,
        idem_key TEXT NOT NULL,
        request_hash TEXT NOT NULL
    );
    "#,
    // 56: 공급자 호출 시간(OBS-005). 기존 턴은 미측정(NULL), 호출 중단 증거는 시작 시각으로 남긴다.
    r#"
    ALTER TABLE turns ADD COLUMN provider_ms INTEGER CHECK (provider_ms IS NULL OR provider_ms >= 0);
    ALTER TABLE turns ADD COLUMN provider_started_at TEXT;
    "#,
    // Hook 설정 저장 전용. 다른 병렬 작업의 migration에 의존하지 않는다.
    r#"
    CREATE TABLE hook_definitions (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        event TEXT NOT NULL CHECK(event IN ('SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','SessionEnd')),
        matcher TEXT NOT NULL,
        command TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX hook_definitions_scope ON hook_definitions(project_id,name,id);
    "#,
    // 세션별 스킬 선택. source·revision은 원래 binding 그대로 보존한다.
    r#"
    CREATE TABLE session_skills (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        bindings TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(bindings))
    );
    "#,
    // Grove 스킬 활성 상태. 세대가 바뀌면 과거 세션 binding을 다시 살리지 않는다.
    r#"
    CREATE TABLE skill_states (
        skill_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
        generation INTEGER NOT NULL CHECK(generation > 0)
    );
    "#,
    // Hook lifecycle 이벤트와 일회성 실행 결합. 설정 삭제가 기존 receipt를 지우지 않는다.
    r#"
    CREATE TABLE hook_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        event TEXT NOT NULL,
        source_id TEXT NOT NULL,
        match_target TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id,event,source_id)
    );
    CREATE TABLE hook_runs (
        event_id TEXT NOT NULL REFERENCES hook_events(id) ON DELETE CASCADE,
        hook_id TEXT NOT NULL,
        call_id TEXT NOT NULL UNIQUE REFERENCES tool_calls(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        PRIMARY KEY(event_id,hook_id)
    );
    "#,
    // MCP OAuth 전용 자격·일회용 접수. 비밀은 기존 vault 함수로만 저장한다.
    r#"
    CREATE TABLE mcp_oauth_credentials (
        server_id TEXT PRIMARY KEY REFERENCES mcp_servers(id) ON DELETE CASCADE,
        identity TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at TEXT NOT NULL,
        usable INTEGER NOT NULL CHECK(usable IN (0,1))
    );
    CREATE TABLE mcp_oauth_attempts (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        config_hash TEXT NOT NULL,
        state_hash TEXT UNIQUE,
        verifier TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','exchanging','completed','cancelled','expired','failed','unknown','interrupted')),
        kind TEXT NOT NULL CHECK(kind IN ('connect','refresh')),
        expires_at TEXT NOT NULL,
        receipt_key TEXT,
        receipt_hash TEXT
    );
    CREATE UNIQUE INDEX mcp_oauth_active ON mcp_oauth_attempts(server_id) WHERE status IN ('pending','exchanging');
    "#,
    // 프로젝트별 워크스페이스 모드(기본 single). 이미 worktree를 쓰는 프로젝트는 project로 두어 기존 작업을 숨기지 않는다.
    r#"
    ALTER TABLE projects ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'single' CHECK (workspace_mode IN ('single','project'));
    UPDATE projects SET workspace_mode = 'project'
     WHERE EXISTS (SELECT 1 FROM worktrees w WHERE w.project_id = projects.id AND w.status != 'removed')
        OR EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = projects.id AND s.worktree_id IS NOT NULL);
    "#,
    // 비밀번호와 소유자 승인을 분리한다. 기존 링크는 폐기하되 등록된 기기는 보존한다.
    r#"
    CREATE TABLE pairings_secure (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        issuer_id TEXT NOT NULL REFERENCES tokens(id),
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        consumed_at TEXT,
        device_id TEXT REFERENCES tokens(id),
        password_hash BLOB,
        password_salt TEXT,
        failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 5),
        locked_at TEXT
    );
    INSERT INTO pairings_secure(id,name,secret_hash,issuer_id,created_at,expires_at,revoked_at,consumed_at,device_id)
        SELECT id,name,secret_hash,issuer_id,created_at,expires_at,COALESCE(revoked_at,created_at),consumed_at,device_id FROM pairings;
    DROP TABLE pairings;
    ALTER TABLE pairings_secure RENAME TO pairings;
    CREATE INDEX pairings_issuer ON pairings(issuer_id,created_at);
    CREATE TABLE pairing_requests (
        id TEXT PRIMARY KEY,
        pairing_id TEXT NOT NULL REFERENCES pairings(id),
        name TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        verification_code TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        approved_at TEXT,
        rejected_at TEXT,
        claimed_at TEXT,
        device_id TEXT REFERENCES tokens(id)
    );
    CREATE INDEX pairing_requests_link ON pairing_requests(pairing_id,created_at);
    CREATE UNIQUE INDEX pairing_one_approval ON pairing_requests(pairing_id) WHERE approved_at IS NOT NULL;
    "#,
    // 58: 추가 메시지도 요청별 모델 선택을 보존한다(프로필 전역 설정은 바꾸지 않음).
    "ALTER TABLE followups ADD COLUMN model TEXT;",
    // 추가 메시지의 속도 선택을 재시작·대기열 시작 뒤에도 보존한다.
    "ALTER TABLE followups ADD COLUMN service_tier TEXT;",
    // 봇 그룹은 기존 세션·턴·승인 경계를 공유한다. 연결 자격은 MCP/vault에만 둔다.
    r#"
    CREATE TABLE bot_rooms (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        member_ids TEXT NOT NULL CHECK(json_valid(member_ids)),
        created_at TEXT NOT NULL
    );
    CREATE TABLE bot_room_dispatches (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES bot_rooms(session_id) ON DELETE CASCADE,
        current_turn_id TEXT NOT NULL REFERENCES turns(id),
        remaining_ids TEXT NOT NULL CHECK(json_valid(remaining_ids)),
        status TEXT NOT NULL CHECK(status IN ('active','completed','stopped'))
    );
    CREATE UNIQUE INDEX bot_room_one_dispatch ON bot_room_dispatches(session_id) WHERE status='active';
    CREATE TABLE bot_connections (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        PRIMARY KEY(bot_id,server_id)
    );
    "#,
    // 사이드바 정리용 폴더. 삭제해도 실제 파일·프로젝트·대화는 남는다.
    r#"
    CREATE TABLE project_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    ALTER TABLE projects ADD COLUMN folder_id TEXT REFERENCES project_folders(id) ON DELETE SET NULL;
    CREATE INDEX projects_folder ON projects(folder_id);
    "#,
    // 대기 중인 네이티브 스킬 선택은 다른 모델·프로젝트의 목록에 다시 결합하지 않는다.
    "ALTER TABLE followups ADD COLUMN native_command TEXT;",
    // Web Push: credentials stay local; queued deliveries commit with completion events.
    r#"
    CREATE TABLE web_push_key (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pkcs8 TEXT NOT NULL);
    CREATE TABLE web_push_subscriptions (
        endpoint TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
        token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
        p256dh BLOB NOT NULL, auth TEXT NOT NULL, scope TEXT NOT NULL, server TEXT NOT NULL,
        vibrate INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, last_error TEXT
    );
    CREATE TABLE web_push_receipts (
        endpoint TEXT NOT NULL REFERENCES web_push_subscriptions(endpoint) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        PRIMARY KEY(endpoint,turn_id)
    );
    CREATE TABLE web_push_outbox (
        endpoint TEXT NOT NULL REFERENCES web_push_subscriptions(endpoint) ON DELETE CASCADE,
        event_key TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL,
        PRIMARY KEY(endpoint,event_key)
    );
    "#,
    // 실제 Push 시험 접수와 전송 결과를 보존한다. 만료된 구독을 지워도 실패 원인은 남긴다.
    r#"
    CREATE TABLE web_push_tests (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
        token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','sent','failed')),
        error TEXT,
        created_at TEXT NOT NULL,
        scheduled_at TEXT NOT NULL
    );
    CREATE INDEX web_push_tests_endpoint_created ON web_push_tests(endpoint,created_at);
    "#,
    // 대화 저장 압축: FK·메시지 ID·시각은 그대로, 원문 payload만 검증된 BLOB으로 교체한다.
    r#"
    ALTER TABLE sessions ADD COLUMN history_accessed_at TEXT;
    ALTER TABLE messages ADD COLUMN history_checked_at TEXT;
    ALTER TABLE messages ADD COLUMN history_preview TEXT;
    ALTER TABLE messages ADD COLUMN history_has_text INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE messages ADD COLUMN history_search_id INTEGER;
    UPDATE messages SET history_preview=substr(json_extract(content,'$.text'),1,120),
        history_has_text=TRIM(COALESCE(json_extract(content,'$.text'),''),char(9)||char(10)||char(13)||' ')!='',
        history_search_id=rowid;
    CREATE INDEX messages_history_unchecked ON messages(session_id) WHERE history_checked_at IS NULL;
    CREATE UNIQUE INDEX messages_history_search_id ON messages(history_search_id);
    CREATE VIEW message_history AS SELECT rowid, id, session_id, seq, role,
        grove_history_text(content) AS content, turn_id, grove_history_text(model_input) AS model_input,
        created_at, rewound_at, history_preview, history_has_text, history_search_id FROM messages;
    CREATE VIRTUAL TABLE message_search USING fts5(text,content='',contentless_delete=1,tokenize='trigram',detail=none);
    INSERT INTO message_search(rowid,text) SELECT history_search_id,COALESCE(json_extract(content,'$.text'),'')
        FROM messages WHERE role IN ('user','assistant');
    CREATE TRIGGER messages_history_insert AFTER INSERT ON messages BEGIN
        UPDATE messages SET history_preview=substr(json_extract(NEW.content,'$.text'),1,120),
            history_has_text=TRIM(COALESCE(json_extract(NEW.content,'$.text'),''),char(9)||char(10)||char(13)||' ')!='',
            history_search_id=(SELECT COALESCE(MAX(history_search_id),0)+1 FROM messages)
            WHERE id=NEW.id;
        INSERT INTO message_search(rowid,text) SELECT history_search_id,COALESCE(json_extract(NEW.content,'$.text'),'')
            FROM messages WHERE id=NEW.id AND NEW.role IN ('user','assistant');
    END;
    CREATE TRIGGER messages_history_update AFTER UPDATE OF content,role ON messages
        WHEN typeof(NEW.content)='text' AND (NEW.content IS NOT OLD.content OR NEW.role IS NOT OLD.role) BEGIN
        UPDATE messages SET history_preview=substr(json_extract(NEW.content,'$.text'),1,120),
            history_has_text=TRIM(COALESCE(json_extract(NEW.content,'$.text'),''),char(9)||char(10)||char(13)||' ')!=''
            WHERE id=NEW.id;
        DELETE FROM message_search WHERE rowid=OLD.history_search_id;
        INSERT INTO message_search(rowid,text) SELECT NEW.history_search_id,COALESCE(json_extract(NEW.content,'$.text'),'')
            WHERE NEW.role IN ('user','assistant');
    END;
    CREATE TRIGGER messages_history_delete AFTER DELETE ON messages BEGIN
        DELETE FROM message_search WHERE rowid=OLD.history_search_id;
    END;
    CREATE TRIGGER messages_history_dirty AFTER UPDATE OF content,model_input ON messages
        WHEN OLD.history_checked_at IS NOT NULL AND NEW.history_checked_at IS OLD.history_checked_at
          AND (NEW.content IS NOT OLD.content OR NEW.model_input IS NOT OLD.model_input) BEGIN
        UPDATE messages SET history_checked_at=NULL WHERE id=NEW.id;
    END;
    "#,
    // 브라우저 갱신 응답 유실 복구. 직전 요청만 저장하고 새 비밀은 vault로 암호화한다.
    r#"
    CREATE TABLE browser_refresh_receipts (
        browser_id TEXT PRIMARY KEY REFERENCES tokens(id) ON DELETE CASCADE,
        request_key TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        next_secret TEXT NOT NULL
    );
    "#,
    // native 합치기는 전달 전에 접수하고, 결과 불명·거절을 자동 재전송하지 않는다.
    r#"
    ALTER TABLE followups ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending'
        CHECK(delivery_state IN ('pending','sending','rejected','unknown'));
    ALTER TABLE followups ADD COLUMN delivery_turn_id TEXT REFERENCES turns(id);
    CREATE INDEX followups_live_delivery ON followups(delivery_turn_id) WHERE delivery_state='sending';
    "#,
    // One-shot follow-up requests survive restart; terminal turns are never reopened.
    r#"
    CREATE TABLE continuations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        origin_turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        owner_key TEXT NOT NULL,
        request_id TEXT NOT NULL,
        input TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('timer','task','external')),
        prompt TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id),
        due_at TEXT NOT NULL,
        completion TEXT,
        status TEXT NOT NULL CHECK(status IN ('waiting','queued','cancelled','blocked')),
        result_turn_id TEXT REFERENCES turns(id),
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(origin_turn_id,request_id)
    );
    CREATE INDEX continuations_waiting ON continuations(status,due_at);
    CREATE INDEX continuations_task ON continuations(task_id) WHERE task_id IS NOT NULL;
    CREATE UNIQUE INDEX continuations_result ON continuations(result_turn_id) WHERE result_turn_id IS NOT NULL;
    "#,
    // 기본 워크플로우: 수동 제목 소유권과 재시작 가능한 메모리 처리 위치.
    r#"
    ALTER TABLE sessions ADD COLUMN title_origin TEXT NOT NULL DEFAULT 'unknown'
        CHECK(title_origin IN ('unknown','provisional','generated','manual'));
    CREATE TABLE memory_checkpoints (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        timeline_revision INTEGER NOT NULL,
        upto_seq INTEGER NOT NULL,
        error_code TEXT,
        attempted_at TEXT NOT NULL
    );
    CREATE TABLE memory_notes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        timeline_revision INTEGER NOT NULL,
        from_seq INTEGER NOT NULL,
        upto_seq INTEGER NOT NULL,
        source_at TEXT NOT NULL,
        body TEXT NOT NULL,
        profile_id TEXT NOT NULL REFERENCES model_profiles(id),
        created_at TEXT NOT NULL,
        UNIQUE(session_id,timeline_revision,upto_seq)
    );
    CREATE INDEX memory_notes_source ON memory_notes(session_id,timeline_revision,upto_seq);
    "#,
    // Codex 대화는 기존 Grove 프로필·메시지를 그대로 쓰고 CLI 스레드 재개를 중단한다.
    r#"
    DELETE FROM profile_checks WHERE profile_id IN (
        SELECT id FROM model_profiles WHERE protocol='codex_cli' AND deleted_at IS NULL
    );
    UPDATE model_profiles
       SET protocol='codex_oauth', revision=revision+1, secret_id=NULL,
           options=json_remove(options, '$.headers', '$.capabilities.tools')
     WHERE protocol='codex_cli' AND deleted_at IS NULL;
    "#,
    // 기존에 소유자가 만들어진 설치는 웹 초기 설정을 다시 요구하지 않는다.
    r#"
    CREATE TABLE daemon_setup (
        id INTEGER PRIMARY KEY CHECK(id=1),
        completed INTEGER NOT NULL CHECK(completed IN (0,1))
    );
    INSERT INTO daemon_setup (id, completed)
        SELECT 1, EXISTS(SELECT 1 FROM tokens WHERE kind='owner');
    "#,
    // 브라우저 자격을 검증할 때 등록이 완료된 기기만 찾는다.
    r#"
    CREATE INDEX pairings_registered_device ON pairings(device_id) WHERE consumed_at IS NOT NULL;
    "#,
];

#[cfg(test)]
mod tests {
    const MIGRATIONS_1_5_SHA16: &str = "40371687b4936aac";

    #[test]
    fn basic_workflow_migration_preserves_old_titles_and_memory_has_session_ownership() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let index = super::MIGRATIONS.iter().position(|sql| sql.contains("CREATE TABLE memory_checkpoints")).unwrap();
        for migration in &super::MIGRATIONS[..index] { c.execute_batch(migration).unwrap(); }
        c.execute_batch("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES('p','fixture','/fixture','t','t');
            INSERT INTO sessions(id,project_id,title,created_at,updated_at) VALUES('s','p','직접 정한 기존 제목','t','t');").unwrap();
        c.execute_batch(super::MIGRATIONS[index]).unwrap();
        let (title,origin):(String,String) = c.query_row("SELECT title,title_origin FROM sessions WHERE id='s'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(title,"직접 정한 기존 제목");
        assert_eq!(origin,"unknown");
        c.execute_batch("INSERT INTO memory_checkpoints VALUES('s',0,0,NULL,'t'); DELETE FROM sessions WHERE id='s';").unwrap();
        assert_eq!(c.query_row("SELECT COUNT(*) FROM memory_checkpoints",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }

    #[test]
    fn project_folder_migration_preserves_existing_projects_and_folder_deletion_keeps_them() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let index = super::MIGRATIONS.iter().position(|sql| sql.contains("CREATE TABLE project_folders")).unwrap();
        for migration in &super::MIGRATIONS[..index] { conn.execute_batch(migration).unwrap(); }
        conn.execute_batch("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES('p','Original','/fixture/project','2026-01-01','2026-01-01');").unwrap();
        conn.execute_batch(super::MIGRATIONS[index]).unwrap();
        assert_eq!(conn.query_row("SELECT folder_id FROM projects WHERE id='p'", [], |r| r.get::<_, Option<String>>(0)).unwrap(), None);
        conn.execute_batch("INSERT INTO project_folders(id,name,name_key,created_at,updated_at) VALUES('f','Folder','folder','2026-01-01','2026-01-01');
            UPDATE projects SET folder_id='f' WHERE id='p'; DELETE FROM project_folders WHERE id='f';").unwrap();
        let project = conn.query_row("SELECT name,root_path,folder_id FROM projects WHERE id='p'", [], |r| Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?,r.get::<_, Option<String>>(2)?))).unwrap();
        assert_eq!(project, ("Original".into(), "/fixture/project".into(), None));
        assert!(conn.prepare("PRAGMA foreign_key_check").unwrap().query([]).unwrap().next().unwrap().is_none());
    }

    #[test]
    fn provider_timing_migration_does_not_invent_measurements_for_old_turns() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        for migration in &super::MIGRATIONS[..55] { c.execute_batch(migration).unwrap(); }
        c.execute_batch(
            "INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES('p','fixture','/fixture','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
             INSERT INTO sessions(id,project_id,title,created_at,updated_at) VALUES('s','p','fixture','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
             INSERT INTO messages(id,session_id,seq,role,content,created_at) VALUES('m','s',1,'user','{}','2026-01-01T00:00:00Z');
             INSERT INTO turns(id,session_id,status,request_message_id,owner_epoch,created_at,updated_at,finished_at) VALUES('t','s','completed','m','old','2026-01-01T00:00:00Z','2026-01-01T00:00:01Z','2026-01-01T00:00:01Z');"
        ).unwrap();
        for migration in &super::MIGRATIONS[55..] { c.execute_batch(migration).unwrap(); }
        let timing = crate::usage::turn_timing(&c, "t", time::OffsetDateTime::now_utc()).unwrap();
        assert_eq!(timing["total_ms"], 1000);
        assert_eq!(timing["model_and_other_ms"], 1000);
        assert!(timing["provider_ms"].is_null() && timing["other_ms"].is_null());
    }

    #[test]
    fn workspace_mode_migration_keeps_projects_that_use_worktrees_in_project_mode() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        let last = 61;
        for migration in &super::MIGRATIONS[..last] { c.execute_batch(migration).unwrap(); }
        let t = "2026-01-01T00:00:00Z";
        for (id, root) in [("plain", "/a"), ("active", "/b"), ("removed", "/c"), ("linked", "/d")] {
            c.execute("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES (?1,?1,?2,?3,?3)", rusqlite::params![id, root, t]).unwrap();
        }
        c.execute_batch(&format!(
            "INSERT INTO worktrees(id,project_id,name,path,branch,status,created_at) VALUES ('w1','active','x','/w1','grove/x','active','{t}');
             INSERT INTO worktrees(id,project_id,name,path,branch,status,created_at,removed_at) VALUES ('w2','removed','y','/w2','grove/y','removed','{t}','{t}');
             INSERT INTO worktrees(id,project_id,name,path,branch,status,created_at,removed_at) VALUES ('w3','linked','z','/w3','grove/z','removed','{t}','{t}');
             INSERT INTO sessions(id,project_id,title,created_at,updated_at,archived_at,worktree_id) VALUES ('s','linked','fixture','{t}','{t}','{t}','w3');"
        )).unwrap();
        c.execute_batch(super::MIGRATIONS[last]).unwrap();
        let mode = |id: &str| c.query_row("SELECT workspace_mode FROM projects WHERE id = ?1", [id], |r| r.get::<_, String>(0)).unwrap();
        assert_eq!(mode("plain"), "single");
        assert_eq!(mode("active"), "project", "제거되지 않은 worktree가 있으면 project");
        assert_eq!(mode("removed"), "single", "제거된 worktree만 있으면 single");
        assert_eq!(mode("linked"), "project", "worktree에 연결된 대화(보관 포함)가 있으면 project");
        assert!(c.execute("UPDATE projects SET workspace_mode = 'multi' WHERE id = 'plain'", []).is_err(), "허용되지 않은 값은 거부");
    }

    #[test]
    fn memories_migration_preserves_existing_native_sessions_as_unknown_system_context() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        for migration in &super::MIGRATIONS[..41] { c.execute_batch(migration).unwrap(); }
        c.execute("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES ('project','fixture','/fixture','2020-01-01','2020-01-01')",[]).unwrap();
        c.execute("INSERT INTO sessions(id,project_id,title,created_at,updated_at) VALUES ('s','project','fixture','2020-01-01','2020-01-01')",[]).unwrap();
        c.execute("INSERT INTO cli_sessions(session_id,profile_id,native_id,updated_at) VALUES ('s','p','native','2020-01-01T00:00:00Z')",[]).unwrap();
        for migration in &super::MIGRATIONS[41..] { c.execute_batch(migration).unwrap(); }
        let binding: (String,Option<String>) = c.query_row("SELECT native_id,system_sha256 FROM cli_sessions",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(binding,("native".into(),None));
        assert_eq!(c.query_row("SELECT COUNT(*) FROM memories",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }

    #[test]
    fn setup_migration_grandfathers_only_initialized_daemons() {
        for owner_exists in [false, true] {
            let c = rusqlite::Connection::open_in_memory().unwrap();
            let last = super::MIGRATIONS.iter().position(|sql| sql.contains("CREATE TABLE daemon_setup")).unwrap();
            for migration in &super::MIGRATIONS[..last] { c.execute_batch(migration).unwrap(); }
            if owner_exists {
                c.execute("INSERT INTO tokens(id,kind,name,secret_hash,created_at) VALUES ('id','owner','owner','hash','t')", []).unwrap();
            }
            c.execute_batch(super::MIGRATIONS[last]).unwrap();
            let completed = c.query_row("SELECT completed FROM daemon_setup WHERE id=1", [], |r| r.get::<_, bool>(0)).unwrap();
            assert_eq!(completed, owner_exists);
        }
    }

    #[test]
    fn codex_oauth_migration_keeps_grove_history_and_profile_selection() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        let last = super::MIGRATIONS.iter().position(|sql| sql.contains("SET protocol='codex_oauth'")).unwrap();
        for migration in &super::MIGRATIONS[..last] { c.execute_batch(migration).unwrap(); }
        c.execute_batch(r#"
            INSERT INTO model_profiles(id,name,protocol,base_url,model,options,created_at,updated_at,revision)
                VALUES ('p','Codex','codex_cli','','default','{"capabilities":{"tools":false,"fast":false}}','t','t',7),
                       ('other','Claude','claude_code','','default','{}','t','t',4);
            INSERT INTO profile_checks(profile_id,ok,latency_ms,checked_at) VALUES ('p',1,1,'t'), ('other',1,1,'t');
            INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES ('project','fixture','/fixture','t','t');
            INSERT INTO sessions(id,project_id,title,created_at,updated_at) VALUES ('s','project','fixture','t','t');
            INSERT INTO messages(id,session_id,seq,role,content,created_at)
                VALUES ('m','s',1,'user','{"text":"existing message"}','t');
            INSERT INTO turns(id,session_id,status,request_message_id,profile_id,owner_epoch,created_at,updated_at)
                VALUES ('turn','s','completed','m','p','epoch','t','t');
            INSERT INTO cli_sessions(session_id,profile_id,native_id,updated_at) VALUES ('s','p','native','t');
        "#).unwrap();
        c.execute_batch(super::MIGRATIONS[last]).unwrap();
        let profile = super::super::models::get_profile(&c, "p").unwrap();
        assert_eq!(profile.protocol, "codex_oauth");
        assert_eq!(profile.revision, 8);
        assert_eq!(profile.capabilities.tools, Some(true));
        assert_eq!(profile.capabilities.native_tools, Some(false));
        assert!(!profile.capabilities.fast);
        assert!(profile.last_check.is_none());
        assert!(super::super::models::get_profile(&c, "other").unwrap().last_check.is_some());
        let text: String = c.query_row(
            "SELECT json_extract(m.content,'$.text') FROM turns t JOIN messages m ON t.request_message_id=m.id WHERE t.profile_id='p'",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(text, "existing message");
        assert!(!c.prepare("PRAGMA foreign_key_check").unwrap().exists([]).unwrap());
    }

    #[test]
    fn profile_activation_migration_preserves_existing_profiles_as_enabled() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        for migration in &super::MIGRATIONS[..38] { connection.execute_batch(migration).unwrap(); }
        connection.execute("INSERT INTO model_profiles(id,name,protocol,base_url,model,created_at,updated_at) VALUES ('legacy','legacy','openai','http://localhost/v1','manual','t','t')", []).unwrap();
        connection.execute_batch(super::MIGRATIONS[38]).unwrap();
        assert!(connection.query_row("SELECT enabled FROM model_profiles WHERE id='legacy'", [], |row| row.get::<_, bool>(0)).unwrap());
    }

    #[test]
    fn worktree_rebuild_preserves_ownership_locations_and_statuses() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        for migration in &super::MIGRATIONS[..40] { c.execute_batch(migration).unwrap(); }
        c.execute("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES ('project','project','/fixture/project','t','t')", []).unwrap();
        for status in ["active", "missing", "removed"] {
            c.execute("INSERT INTO worktrees(id,project_id,name,path,branch,base,status,created_at,removed_at) VALUES (?1,'project',?1,?2,?3,'base',?1,'created','removed')",
                rusqlite::params![status, format!("/fixture/{status}"), format!("grove/{status}")]).unwrap();
        }
        c.execute_batch(super::MIGRATIONS[40]).unwrap();
        for status in ["active", "missing", "removed"] {
            let row: (String, String, String, String, String) = c.query_row("SELECT project_id,path,branch,base,status FROM worktrees WHERE id=?1", [status],
                |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
            assert_eq!(row, ("project".into(),format!("/fixture/{status}"),format!("grove/{status}"),"base".into(),status.into()));
        }
        c.execute("UPDATE worktrees SET status='unknown' WHERE id='missing'", []).unwrap();
        let violations: i64 = c.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        assert_eq!(violations, 0);
    }

    /// 목록·검색·사용량의 주요 조회가 전체 표 scan 없이 인덱스를 쓴다(DB-011).
    #[test]
    fn hot_queries_use_indexes() {
        let d = tempfile::tempdir().unwrap();
        let db = super::Db::open(&d.path().join("grove.db")).unwrap();
        let c = db.conn.lock().unwrap();
        let plan = |sql: &str| -> String {
            let mut st = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            st.query_map([], |r| r.get::<_, String>(3)).unwrap().map(|x| x.unwrap()).collect::<Vec<_>>().join(" / ")
        };
        for (name, sql) in [
            ("알림 목록", "SELECT id FROM notifications WHERE created_at < 'x' OR (created_at = 'x' AND id < 'y') ORDER BY created_at DESC, id DESC LIMIT 50"),
            ("메시지 페이지", "SELECT id FROM messages WHERE session_id = 's' AND seq < 100 ORDER BY seq DESC LIMIT 50"),
            ("사용량 기간", "SELECT id FROM messages WHERE created_at >= 'a' AND created_at < 'b'"),
            ("프로젝트별 대화", "SELECT id FROM sessions WHERE project_id = 'p' ORDER BY updated_at DESC LIMIT 50"),
            ("이벤트 재생", "SELECT seq FROM events WHERE seq > 10 ORDER BY seq LIMIT 200"),
            ("턴 도구 호출", "SELECT id FROM tool_calls WHERE session_id = 's' ORDER BY created_at"),
            ("예약 due", "SELECT id FROM schedules WHERE status = 'active' AND next_run_at <= 'x'"),
        ] {
            let p = plan(sql);
            assert!(!p.contains("SCAN ") || p.contains("USING INDEX") || p.contains("USING COVERING INDEX") || p.contains("INTEGER PRIMARY KEY"), "{name}: {p}");
            assert!(!p.contains("USE TEMP B-TREE FOR ORDER BY"), "{name}: 정렬에 임시 B-tree: {p}");
        }
    }

    /// migration 19(표 재구성)는 기존 프로필과 턴 참조를 보존하고, 끝난 뒤 외래 키 검사를 다시 켠다.
    #[test]
    fn profile_table_rebuild_keeps_data_and_foreign_keys() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("grove.db");
        {
            let c = rusqlite::Connection::open(&path).unwrap();
            c.pragma_update(None, "foreign_keys", "ON").unwrap();
            for (i, sql) in super::MIGRATIONS[..18].iter().enumerate() {
                c.execute_batch(sql).unwrap();
                c.pragma_update(None, "user_version", (i + 1) as i64).unwrap();
            }
            c.execute_batch(
                "INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('p','p','/tmp/p','t','t');
                 INSERT INTO sessions (id, project_id, title, created_at, updated_at) VALUES ('s','p','s','t','t');
                 INSERT INTO messages (id, session_id, seq, role, content, created_at) VALUES ('m','s',1,'user','{}','t');
                 INSERT INTO model_profiles (id, name, protocol, base_url, model, created_at, updated_at) VALUES ('mp','old','openai','http://x/v1','m','t','t');
                 INSERT INTO turns (id, session_id, status, request_message_id, profile_id, created_at, updated_at, owner_epoch, usage)
                   VALUES ('t1','s','completed','m','mp','t','t','e','{}');",
            )
            .unwrap();
        }
        let db = super::Db::open(&path).unwrap();
        let c = db.conn.lock().unwrap();
        assert_eq!(c.query_row("SELECT protocol FROM model_profiles WHERE id = 'mp'", [], |r| r.get::<_, String>(0)).unwrap(), "openai");
        assert_eq!(c.query_row("SELECT profile_id FROM turns WHERE id = 't1'", [], |r| r.get::<_, String>(0)).unwrap(), "mp");
        // 새 protocol 저장 가능(검증은 앱)
        c.execute("INSERT INTO model_profiles (id, name, protocol, base_url, model, created_at, updated_at) VALUES ('cli','cli','claude_code','','haiku','t','t')", []).unwrap();
        // 외래 키 검사는 다시 켜져 있다
        assert_eq!(c.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert!(c.execute("INSERT INTO turns (id, session_id, status, request_message_id, profile_id, created_at, updated_at, owner_epoch, usage) VALUES ('t2','s','completed','m','nope','t','t','e','{}')", []).is_err());
        assert_eq!(c.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    /// 배포된 migration은 순서·내용을 바꾸지 않는다. 앞부분 hash가 바뀌면 실패한다.
    #[test]
    fn migrations_are_append_only() {
        let first5: String = super::MIGRATIONS[..5].concat();
        let h = crate::util::sha256_hex(first5.as_bytes());
        assert_eq!(&h[..16], MIGRATIONS_1_5_SHA16, "배포된 migration 1~5를 수정했습니다");
    }
}

#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
    pub path: PathBuf,
    recovery: tokio::sync::watch::Sender<Option<&'static str>>,
}

impl Db {
    pub fn open(path: &Path) -> anyhow_like::Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        crate::vault::register(&conn, path.parent().unwrap_or(Path::new(".")))?;
        crate::history_storage::register(&conn)?;
        let mut db = Self { conn: Arc::new(Mutex::new(conn)), path: path.to_path_buf(), recovery: tokio::sync::watch::channel(None).0 };
        db.migrate()?;
        restrict_permissions(path);
        Ok(db)
    }

    fn migrate(&mut self) -> anyhow_like::Result<()> {
        let mut conn = self.conn.lock().expect("db mutex");
        let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if current as usize > MIGRATIONS.len() {
            return Err(anyhow_like::Error(format!(
                "데이터베이스 schema {current}가 이 실행 파일이 아는 버전 {}보다 새롭습니다",
                MIGRATIONS.len()
            )));
        }
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
            // 표 재구성 migration: 외래 키 검사는 transaction 안에서 바꿀 수 없으므로 밖에서 끄고, 끝난 뒤 무결성을 확인한다.
            let rebuild = sql.trim_start().starts_with("-- grove:rebuild");
            if rebuild {
                conn.pragma_update(None, "foreign_keys", "OFF")?;
            }
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
            if rebuild {
                let bad: i64 = tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get(0))?;
                if bad > 0 {
                    // 롤백(commit하지 않음) 후 외래 키 검사를 되돌린다.
                    drop(tx);
                    conn.pragma_update(None, "foreign_keys", "ON")?;
                    return Err(anyhow_like::Error(format!("migration {}: 외래 키 위반 {bad}건으로 중단했습니다", i + 1)));
                }
            }
            tx.pragma_update(None, "user_version", (i + 1) as i64)?;
            tx.commit()?;
            if rebuild {
                conn.pragma_update(None, "foreign_keys", "ON")?;
            }
        }
        Ok(())
    }

    pub fn schema_version(&self) -> i64 {
        self.call_sync(|c| Ok(c.query_row("PRAGMA user_version", [], |r| r.get(0))?)).unwrap_or(0)
    }

    pub fn recovery_reason(&self) -> Option<&'static str> {
        *self.recovery.borrow()
    }

    pub(crate) fn recovery_receiver(&self) -> tokio::sync::watch::Receiver<Option<&'static str>> {
        self.recovery.subscribe()
    }

    pub fn recovery_error(&self) -> Option<ApiError> {
        self.recovery_reason().map(|reason| {
            ApiError::new(axum::http::StatusCode::SERVICE_UNAVAILABLE, "storage_recovery_required",
                "저장소 오류로 실행을 중단했습니다. 원본을 보존하고 grove doctor --offline으로 확인하세요")
                .with_details(serde_json::json!({ "reason": reason, "restart_required": true }))
        })
    }

    /// blocking 스레드에서 연결을 사용한다.
    pub async fn call<T, F>(&self, f: F) -> ApiResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> ApiResult<T> + Send + 'static,
    {
        let db = self.clone();
        tokio::task::spawn_blocking(move || db.call_sync(f))
        .await
        .map_err(|e| ApiError::internal(format!("db task: {e}")))?
    }

    /// 동기 문맥(시작·종료·CLI)용.
    pub fn call_sync<T>(&self, f: impl FnOnce(&mut Connection) -> ApiResult<T>) -> ApiResult<T> {
        let mut guard = self.conn.lock().map_err(|_| ApiError::internal("db mutex poisoned"))?;
        if let Some(error) = self.recovery_error() { return Err(error); }
        let result = f(&mut guard);
        if let Err(error) = &result
            && matches!(error.code, "storage_full" | "storage_permission" | "storage_corrupt" | "storage_io")
        {
            // 같은 연결의 다음 작업이 시작되기 전에 고정한다. 자동 재시도·자동 해제는 하지 않는다(DB-015).
            self.recovery.send_replace(Some(error.code));
            tracing::error!(code = error.code, "저장소 복구 필요: 새 DB 작업을 차단하고 서버 실행을 종료합니다");
        }
        result
    }
}

#[cfg(unix)]
pub fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
pub fn restrict_permissions(_path: &Path) {}

/// 시작 경로용 경량 오류(anyhow 의존성 없이).
pub mod anyhow_like {
    #[derive(Debug)]
    pub struct Error(pub String);
    impl std::fmt::Display for Error {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(&self.0)
        }
    }
    impl std::error::Error for Error {}
    impl From<rusqlite::Error> for Error {
        fn from(e: rusqlite::Error) -> Self {
            Error(e.to_string())
        }
    }
    impl From<std::io::Error> for Error {
        fn from(e: std::io::Error) -> Self {
            Error(e.to_string())
        }
    }
    impl From<crate::error::ApiError> for Error {
        fn from(e: crate::error::ApiError) -> Self {
            Error(format!("{}: {}", e.code, e.message))
        }
    }
    pub type Result<T> = std::result::Result<T, Error>;
}
