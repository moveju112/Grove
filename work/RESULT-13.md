# b02 / 13 — 사이드바 상태·읽지 않음·핀·toolbar

## 상태와 기준
- 상태: 구현·시험 작성 종료, **검증 환경 blocker로 컴파일·동작 확인 및 통합 대기**. 완료 후보로 판정하지 않는다.
- worktree: `/home/ubuntu/.local/share/paseodog/paseo/worktrees/0q796rug/b02-13-sidebar-status`
- branch: `parallel/b02-sidebar-status`
- 공통 기준 SHA: `bc797b36cd0c09ce41eb675d7d152ce95ffa7ef1`
- `ENTRY.md`와 원본 `work/README.md`에서 경로·브랜치가 모두 일치하는 13번을 선택했다. 시작 Git 상태는 clean이고 `git merge-base HEAD <기준 SHA>`가 기준과 일치했다.
- 원본 프로젝트·TODO·서비스·의존성은 수정하지 않았다. push·merge·배포·E2E 실행은 하지 않았다.

## 제공한 구현과 소유 변경
| 파일 | 변경 |
|---|---|
| `src/sessions.rs` | `sidebar`, `SidebarQuery`, `SidebarSession`, `SidebarPage`, 실제 상태 분류·전체 집계·페이지 조회, Rust 단위 시험 4개 |
| `src/lib.rs` | 기존 router에 `GET /projects/{id}/sidebar` 한 줄 등록 |
| `web/app/components/Workspace.tsx` | aside의 기존 프로젝트 행을 `SidebarProject`로 감싸기, import 한 줄 |
| `web/app/components/sidebar/index.tsx` | 프로젝트 상태·읽지 않은 세션 수·페이지 탐색, 세션 상태·핀·읽음·분할 열기, keyboard toolbar |
| `web/app/components/sidebar/state.ts` | 응답 타입·상태 레이블·프로젝트 상태 우선순위, 기존 recent API를 이용한 핀·읽음 저장 |
| `web/app/components/sidebar/sidebar.css` | 사이드바 범위 안 스타일, 텍스트·기호 상태, 줄바꿈과 focus 표시 |
| `web/app/components/sidebar/sidebar.test.ts` | 상태 표시·접근성 markup·모바일·키보드·핀 충돌·읽음·통신 실패 시험 |
| `web/app/components/sidebar/invalidation.test.ts` | 기존 store의 실제 이벤트·재동기화가 사이드바 query를 갱신하는 시험 |
| `web/e2e/sidebar-status.spec.ts` | 실제 서버·로컬 모델 fixture 기반 브라우저 시나리오 3개 작성 |
| `work/RESULT-13.md` | 이 인계 |

## export·입출력·저장 계약
- `SidebarProject({ project: Project, children: ReactNode, open: Opener, narrow: boolean })`를 Workspace의 기존 프로젝트 행에 연결했다. 기존 프로젝트 메뉴·라벨·프로젝트 핀·프로젝트 분할 열기는 children 그대로 재사용한다.
- `SessionRow({ item: SidebarSession, open: Opener, narrow: boolean })`, `StatusIcon({ status: string })`, `toolbarKeys(event)`를 export한다. 버튼은 native button이며 toolbar에서 좌우 방향키·Home·End를 지원한다. 잦은 상태 갱신에 애니메이션은 추가하지 않았다.
- `GET /api/v1/projects/{id}/sidebar?offset=0&limit=30&unread_only=false`는 기존 `Principal` 인증을 요구하는 읽기 전용 라우트다. 잘못된 query 타입은 기존 Axum 처리, 없는 프로젝트는 기존 `projects::get`의 not-found 계약을 따른다.
- 응답은 `{ items, statuses, unread, total, filtered_total, next_offset }`. item은 `{ session: Session, status, pinned, recent_id, recent_revision }`다. `statuses`·`unread`·`total`은 페이지·읽지 않음 필터와 무관한 해당 프로젝트 전체 활성 세션 집계다.
- 보관된 세션은 제외한다. 최근 목록의 시간 필터·숨김은 프로젝트 탐색에 적용하지 않는다. 세션 핀 우선, 이후 세션 갱신 시각·ID 내림차순이다. 기본 30개, 최대 200개, offset은 0 이상으로 제한한다. 전체를 순회해 집계하되 응답 메모리에는 한 페이지만 보관한다.
- 실행·실행 대기·승인·답변 대기는 기존 `Session.active_turn`·`pending_approvals`, 결과 불명은 `unreviewed_unknown`에서 읽는다. 활성 턴이 없을 때만 마지막 실제 턴의 완료·실패·취소·중단 상태를 사용한다. 턴이 없으면 대기이고 알 수 없는 상태를 완료로 추정하지 않는다.
- 프로젝트 대표 상태는 승인 대기, 답변 대기, 실행 중, 실행 대기, 결과/상태 확인 필요, 오류, 중단, 완료, 취소, 대기 순으로 표시한다. 페이지 밖의 상태도 포함한다. 읽지 않음은 별도로 표시한다.
- **저장 위치:** 세션 핀은 기존 서버 SQLite `recent_items.pinned`, 읽음은 `recent_items.view_state.last_seen_seq`다. 프로젝트 핀은 기존 `projects.pinned_at`과 기존 메뉴를 그대로 사용한다. 새 migration·localStorage 상태·Session 계약 변경은 없다.
- 기존 최근 항목이 있으면 핀 변경은 `/recent/{id}` PATCH로 원하는 pinned 필드와 expected_revision만 보낸다. 없을 때만 `/recent/touch`로 만든다. revision 충돌은 기존 `retryIntent`로 핀 의도만 최신 revision에 한 번 재적용하고, 이미 같은 값이면 요청하지 않는다.
- 읽음은 `/recent/touch`에 사용자가 클릭한 시점의 실제 `last_message_seq`만 보낸다. 기존 서버의 단조 증가 읽음 계약을 재사용하며 이후 새 메시지를 미리 읽음 처리하지 않는다. 대화를 실제로 열었을 때의 읽음 기록은 기존 SessionView가 담당한다.
- 변경 오류는 alert로 노출하고 낙관적 성공이나 무조건 재시도를 하지 않는다. 성공·실패 모두 recent query를 다시 읽어 응답 유실을 서버 값으로 확인한다.
- query key는 `recent:sidebar:<project>:<query>`다. 기존 store의 message/turn/tool/session/recent/project 이벤트 무효화와 `resyncAll`을 그대로 받는다. store·RecentPanel·배치 코드는 수정하지 않았다.
- 새 응답의 TypeScript 타입은 전용 `state.ts`에 선언했다. 기존 generated Session을 중첩해 사용하며 generated 파일·생성기는 바꾸지 않았다.

## 검증 근거와 blocker
| 실제 명령·확인 | 결과 |
|---|---|
| `git merge-base HEAD bc797b36cd0c09ce41eb675d7d152ce95ffa7ef1` | 기준 SHA 일치 |
| `source .envrc.dev && python3 scripts/build.py test --lib --filter sidebar --vitest app/components/sidebar/sidebar.test.ts --typecheck` | exit 1. Rust 시작 시 `FileNotFoundError: [Errno 2] No such file or directory: 'cargo'`. Rust 시험 자체는 시작되지 않았고 typecheck·Vitest는 실행기가 미실행으로 표시했다. |
| `set -a && source /home/ubuntu/.config/environment.d/60-build-storage.conf && set +a && source .envrc.dev && python3 scripts/build.py test --lib --filter sidebar --vitest app/components/sidebar/sidebar.test.ts app/components/sidebar/invalidation.test.ts --typecheck --dry-run` | exit 0. 최종 선택이 `cargo test --lib sidebar`, `npm run typecheck`, 두 전용 Vitest 파일로 잡히는 것만 확인했다. 실행 성공 근거가 아니다. |
| `git diff --check` | 통과. 컴파일·타입·행동 검증은 아니다. |

- 현재 worktree에는 `.dev`와 `web/node_modules`가 없다. 첫 실행 뒤 호스트 공통 환경 파일을 확인했지만 의존성 부재는 그대로다. 최초 실행에는 이 공통 환경을 적용하지 못했다. 이후 dry-run에는 SSD cache·jobs=2 설정을 적용했다.
- COMMON의 환경 부재 시 설치·우회 금지에 따라 다운로드·복사·symlink·대체 standalone runner를 만들지 않았다. 같은 cargo 부재 실패를 재시도하지 않았다.
- Rust 시험 4개, 웹 상태·표시·이벤트 시험, typecheck는 **미검증**이다. E2E 3개는 COMMON에 따라 통합 단계로 남겼고 실행하지 않았다. 실제 브라우저 접근성·모바일·기기 간 유지도 통과했다고 주장하지 않는다.

## UI-004 요구와 남은 조건
| 요구 | 구현 근거 | 남은 조건 |
|---|---|---|
| 세션·프로젝트 상태 아이콘 | 실제 서버 상태 분류, 전체 프로젝트 집계, 기호와 텍스트 레이블 | Rust·Vitest·실제 상태 전환 E2E 통과 |
| 읽지 않음 | 기존 서버 읽음 seq 공유, 프로젝트 전체 unread 수, 읽음 버튼·필터 | 두 기기·새로고침·새 메시지 도착 시나리오 실행 |
| 핀 | 기존 프로젝트 핀 메뉴 유지, recent 세션 핀 재사용·정렬·충돌 처리 | 두 기기·새로고침 E2E 실행, 기존 프로젝트 핀 회귀 확인 |
| toolbar·키보드 | 접기·필터·새로고침·페이지 이동·세션 핀·읽음·분할 열기 | 타입·단위·브라우저 키보드 및 모바일 확인 |
| 최근 탭·분할 보존 | RecentPanel 무수정, 기존 Opener 재사용, E2E에 최근 반영·분할 열기 포함 | 기존 recent-navigation/recent-original·프로젝트 라벨/핀·responsive-panes 회귀를 통합 담당이 선택 실행 |

`UI-004`는 미완료 유지다. `UI-005`와 다른 기능은 착수하지 않았다.

## 다음 통합 단계와 위험
1. 승인된 공통 빌드 환경과 기존 의존성이 준비된 환경에서 위 최종 선택 명령의 `--dry-run`을 제거해 Rust·typecheck·Vitest를 실행한다. 컴파일되지 않은 상태를 완료로 수용하지 않는다.
2. 통합 단계에서 E2E 고정 포트를 독점한 뒤 `python3 scripts/build.py test --e2e e2e/sidebar-status.spec.ts`와 영향받는 기존 선택 회귀를 실행한다. 서버·웹 빌드를 포함한 프로젝트 진입점을 사용한다.
3. 다른 담당의 router 변경과 route 한 줄을 함께 유지한다. 추가 공통 mount·migration·store 연결은 남아 있지 않지만 실제 연결·행동은 아직 미검증이다.
4. 프로젝트 상태 집계는 해당 프로젝트 전체 활성 세션을 순회한다. 응답 크기는 제한하지만 매우 큰 프로젝트의 조회 비용은 측정하지 않았다. offset 페이지는 동시 활동·핀 변경 때 재정렬될 수 있다.
5. 실패·미실행을 해소한 뒤에만 TODO 완료 여부를 판단한다. worktree·브랜치는 보존하며 정리는 통합 담당이 한다.
