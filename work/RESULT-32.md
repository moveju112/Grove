# b02 / 32 — CMP-011 압축 기록 상세

- 상태: 구현·선택 검증 완료. 공통 연결 대기와 blocker 없음. 메인 통합·TODO 반영은 통합 담당 범위.
- Worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-32-compaction-details`
- Branch: `parallel/b02-compaction-details`
- 기준 SHA: `9942629c17891c5cad8cc5a7a62fee99e0379650`
- 정본: `/data/project/paseodog_opus/work/ENTRY.md`, `COMMON.md`, `32.md`. README의 경로·브랜치 일치와 기준 ancestry, 시작 시 clean 상태를 확인했다.

## 제공 동작·소유 변경

| 파일 | 변경 |
|---|---|
| `src/context.rs::compact` | 성공 note의 공개 실행 metadata·가격표 snapshot·추정 비용 |
| `web/app/components/compaction/CompactionDetails.tsx` | 수동·자동 기록 상세와 원문 양끝 이동 |
| `web/app/components/compaction/CompactionDetails.test.ts` | 표시·누락·legacy·가격 0·작은 양수·실제 seq 조회 단위 시험 |
| `web/app/components/SessionView.tsx` | import와 MessageView의 성공 compaction 분기만 연결 |
| `tests/compaction_details.rs` | 실제 HTTP fixture, 생성 중 프로필 편집, 삭제·재시작 보존, 비용·실패·취소·권한 |
| `web/e2e/compaction-details.spec.ts` | 실제 서버·정적 웹·로컬 모델 fixture의 압축 상세 사용자 흐름 |
| `work/RESULT-32.md` | 이 인계 |

새 dependency·migration·공통 API/store·TODO 변경 없음. 기능 33 fallback 분기, focus/pagination/virtualization, TTS/playback/microphone와 차단 계약은 수정하지 않았다.

## 입출력·권한·오류 계약

성공 note는 기존 필드와 함께 다음을 저장한다.

- `generation: { profile_name, protocol, model }`: 준비 시 선택된 요약 runtime profile의 공개 이름·protocol·실제 요청 model. 일반 대화 모델로 대신 표시하지 않는다. provider 내부 alias 해석이나 응답에 보고되지 않은 모델 version은 추정하지 않는다.
- `pricing`: 생성 당시 가격표의 `currency`, 선택적 `version`, input/output/cache read/write 단가만 allowlist로 복사한다. 가격표가 없으면 null. 전체 options·base URL·secret/credential/header는 복사하지 않는다.
- `estimated_cost`: 기존 `usage::estimate_cost` 결과 또는 null. 단위는 snapshot 가격표 통화이며 실제 청구액이 아니다.
- `cost_status`: `estimated`, `missing_pricing`, `usage_unreported_or_zero`.

현재 provider의 input/output 사용량은 미보고와 0을 구분하지 못한다. 어느 한쪽이라도 0이면 비용을 만들지 않고 “미보고 또는 0(구분 불가)”로 표시한다. 양쪽 사용량이 있고 단가가 명시적으로 0인 경우만 추정 비용 0을 표시한다. 작은 양수 비용도 소수 자릿수 제한으로 0으로 만들지 않는다. 가격표 version 누락은 “미기록”이다.

`CompactionDetails({ sessionId, record: CompactionRecord })`를 export한다. 기존 note는 현재 프로필을 조회하거나 소급하지 않는다. 저장된 snapshot은 프로필 변경·삭제 뒤에도 유지된다.

`focusCompactionSource(sessionId, source, edge)`는 기존 인증 API의 `messages?limit=1&after_seq=...` / `before_seq=...`를 읽는다. 반환된 실제 seq가 저장된 `(from_seq, upto_seq]` 안에 있을 때만 기존 `requestFocus`에 전달한다. 범위 안 메시지가 없으면 false, 조회 오류는 reject하며 UI가 이동 불가/실패를 표시한다. 페이지 밖 메시지는 기존 pagination·가상 스크롤로 찾는다. 조회 직후 대상이 사라지는 경합은 기존 focus의 이동 불가 처리가 맡는다. 이 동작은 원문 보기이며 모델 context 복원이 아니다.

기존 authenticated compact API, summary profile 선택 우선순위, FAIR auxiliary permit, 취소, source hash, timeline revision, 중복 범위 검사와 성공 transaction은 유지했다. mutation retry를 추가하지 않았다. 실패/취소/빈 응답/길이 검사 거절에는 성공 metadata나 note를 생성하지 않는다. 자동 실패·정지 표시는 기존 별도 분기를 유지한다.

## 실제 검증

공통 환경을 매번 `source /data/project/paseodog_opus/.envrc.dev`로 적용했다. Rust/E2E는 `CARGO_TARGET_DIR=/data/project/paseodog_opus/target`와 `flock /home/ubuntu/.cache/grove-rust-check.lock`을 사용했다. 빌드 실행기가 사용하는 `.dev`와 `web/node_modules`는 메인 경로의 ignored symlink이며 설치·복사하지 않았다. E2E는 요청된 완료 흐름 확인을 위해 고정 포트에서 직렬 실행했다.

| 실행 명령 (`python3 scripts/build.py test`의 인수) | 결과 |
|---|---|
| `--rust compaction_details context --vitest app/components/compaction/CompactionDetails.test.tsx --typecheck` | 신규 Rust 3 통과, 1 실패. 시험이 허용되지 않는 session 설정 scope를 사용했다. 후속 단계 미실행 |
| `--rust compaction_details context model_limits --vitest app/components/compaction/CompactionDetails.test.tsx --typecheck --e2e e2e/compaction-details.spec.ts` | 신규 Rust 3 통과, 1 실패. 일반 fixture profile에 context_window가 없어 자동 기준을 넘지 않았다. 후속 단계 미실행 |
| `--vitest app/components/compaction/CompactionDetails.test.tsx --typecheck` | 최초 TS2345(each 인수 배열) 실패, Vitest 미실행. 인수 형식을 수정한 실행에서는 typecheck 통과, Vitest는 `.test.ts`만 포함하는 기존 설정 때문에 `No test files found` 실패 |
| `--rust compaction_details --filter cost_reuses_cache_pricing_and_automatic_summary_profile_selection` | 수정한 자동 압축 시험 1 통과. 사용량 API로 context_window와 임계 초과를 독립 확인. 나머지 3개의 유효한 성공 결과 재사용 |
| `--rust context model_limits --e2e e2e/compaction-details.spec.ts` | 기존 context 12·model_limits 3 통과, debug 서버·웹 빌드 통과. E2E 첫 시험은 성공 note가 가상 스크롤 밖에 있어 실패, 나머지 2 미실행 |
| `--vitest app/components/compaction/CompactionDetails.test.ts` | 기존 발견 규칙에 맞게 확장자를 변경한 단위 시험 14 통과 |
| `--e2e e2e/compaction-details.spec.ts` | 기존 feed의 End 탐색과 실제 compact/메시지 응답 관찰을 사용하는 수정 후 3 통과. debug 서버·웹 빌드 통과 |
| `--typecheck` | 최종 파일 경로 기준 통과 |
| `git diff --check` | 통과 |

초기 실패는 위와 같이 보존하며 해결되지 않은 실패는 없다. 빌드의 500 kB chunk 경고와 React Router future flag 안내는 남아 있다. 이를 이유로 공통 빌드 설정이나 무관한 코드를 변경하지 않았다.

## CMP-011 충족 근거·통합 사항

- 생성 당시 모델·가격 기준·추정 비용: generation 도중 프로필 이름/model/가격을 바꿔도 원래 snapshot과 실제 요약 요청 model을 보존한다. cache 가격 계산은 독립 산식 `(70×2 + 30×0.5 + 20×4) / 1_000_000 EUR`와 비교했다. 가격·usage 없음, 부분 usage, version 없음, 명시적 무료 가격을 구분했다.
- 원문·token 전후·이동: 실제 수동 압축 후 100개 최신 페이지 밖의 첫 보존 원문까지 기존 focus/pagination으로 이동하고 viewport에서 확인했다. 단위 시험은 경계와 다른 실제 seq, 빈/범위 밖 결과, 조회 실패와 재시도 없음을 검증한다. E2E는 사라진 범위와 권한 오류 안내를 검증한다.
- 보존: 실제 서버 restart 후 note 전체 동일성과 원문 양끝 API 조회, model-input에서 압축된 원문이 계속 제외됨을 검증했다. 브라우저 refresh 후 프로필 편집·삭제 이전의 모델·가격·비용이 유지된다.
- 실패 정직성: 인증 거절, provider 실패, 빈 요약, 과대 요약, 취소 뒤 원문/메시지 목록 불변을 검증했다. 자동 압축 성공·적용 거절은 브라우저에서 서로 다른 분기로 표시된다. legacy UI 검증만 과거 note 형태의 읽기 fixture를 사용하며 과거 값을 실제 생성했다고 주장하지 않는다.
- 기존 context 12개와 auxiliary 슬롯을 포함한 model_limits 3개의 회귀가 통과했다. 공통 화면 mount는 이미 연결되어 추가 등록이 필요 없다. 메인 통합 시 소유 diff와 이 결과를 반영하면 된다.

전체 인수·release·다른 플랫폼·모바일 전용 시험·실제 외부 모델/계정·압축 품질 비교는 실행하지 않았다. 이번 범위에 남은 기능 요구나 blocker는 없다. push·merge·deploy·workspace 제거는 하지 않는다.
