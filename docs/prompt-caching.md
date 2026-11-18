# 공급자별 프롬프트 캐시

HTTP 모델 요청을 직렬화할 때 공급자별 캐시 힌트를 적용한다.
서버·DB·화면의 응답 계약이나 사용자 설정을 바꾸지 않으며 CLI 내부 요청에는 적용하지 않는다.

| 경로 | 구현 |
|---|---|
| OpenAI 공식 API | 지침·도구 정의·모델로 만든 SHA-256 `prompt_cache_key`. GPT-5.6 이후에는 시스템 지침의 명시적 경계와 대화의 암묵적 캐시를 함께 사용한다. 구형 모델에는 새 경계 필드를 보내지 않는다. |
| Anthropic 공식 API | 기본 5분 `cache_control`로 도구 목록 끝·시스템 지침을 캐시하고, 최상위 자동 경계로 늘어나는 대화 이력을 캐시한다. 기존 native 경계를 포함해 최대 4개를 유지한다. |
| OpenRouter | 안정된 `prompt_cache_key`로 sticky routing을 돕는다. Claude는 자동 경계와 시스템 경계를, Gemini 2.5·3은 시스템 경계를 사용한다. OpenAI GPT-5.6 이후 모델은 OpenAI와 같은 경계를 사용한다. Gemini 4에는 명시적 경계를 넣지 않는다. |
| Gemini 직접 API | 공급자의 암묵적 캐시를 사용한다. 도구 정의 순서를 고정하며 별도의 유료 보관 캐시 객체는 생성하지 않는다. |
| 그 밖의 OpenAI·Anthropic 호환 endpoint | 전용 캐시 필드를 추가하지 않는다. 공급자 자체의 자동 캐시는 유지한다. |

공식 endpoint는 URL 파싱 후 HTTPS·정확한 host·기본 포트로 판별한다.
프록시 주소에 공급자 이름이 들어 있다는 이유로 지원을 추정하지 않는다.
캐시 키에는 현재 질문·생성 옵션·자격을 넣지 않는다.
모든 HTTP 경로는 도구를 이름순으로 직렬화해 불필요한 prefix 변경을 줄인다.
본문·메시지 순서·도구 호출 ID·서명된 native 블록은 보존한다.

캐시는 공급자가 동일 입력 prefix의 계산을 재사용하는 기능이다.
Grove가 오래된 응답이나 파일 읽기 결과를 대신 돌려주는 기능이 아니며, 캐시 적중을 보장하지 않는다.
최소 길이·모델 지원·수명·캐시 쓰기 과금은 공급자 정책을 따른다.
확장 TTL이나 Gemini 직접 API의 명시적 캐시 객체는 요청하지 않는다.

사용량은 기존 `cache_read_tokens`·`cache_write_tokens` 경로로 집계한다.
OpenAI 호환 응답의 `prompt_tokens_details.cache_write_tokens`도 읽으며 미보고는 `None`, 명시적 0은 `Some(0)`으로 구분한다.
캐시 사용량은 전체 입력 토큰의 일부이므로 입력에 다시 더하지 않는다.

검증은 `src/provider/prompt_cache_tests.rs`의 직렬화·키 안정성·호환성·원문 보존 검사와 기존 HTTP fixture를 사용한다.
실제 계정으로 캐시 적중률이나 과금 절감률을 측정한 것은 아니다.

공식 계약 확인: 2026-11-17.

- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching)
- [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
