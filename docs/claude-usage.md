# Claude Code 사용량 파일

Grove는 서버의 데이터 디렉터리 아래 `usage/v1/claude.json`을 갱신합니다. `--data-dir` 또는 `GROVE_DATA_DIR`를 지정했다면 그 위치가 기준입니다. 같은 OS 사용자로 실행하는 프로그램은 이 파일을 읽을 수 있습니다.

Claude Code가 실제 대화 중 `rate_limit_event`로 제공한 5시간·7일 구독 한도의 최신 관측값을 저장합니다. 한 턴에서 받은 값은 턴을 마칠 때 함께 반영하며, CLI가 결과 뒤에 보낸 값도 도착하면 반영합니다. 사용률이 없는 이벤트나 아무 이벤트가 없는 턴은 기존 값과 수신 시각을 유지합니다. 첫 유효 이벤트 전에는 파일이 없을 수 있습니다.

```json
{
  "version": 1,
  "account": null,
  "windows": {
    "five_hour": {
      "used_percent": 12.5,
      "resets_at": 1911938400,
      "received_at": 1911930000.5
    }
  }
}
```

- `windows`의 키는 `five_hour`, `seven_day`입니다. 수신한 기간만 존재합니다. `used_percent`는 0~100이며 실제 0도 유효합니다.
- `received_at`과 `resets_at`은 Unix 초입니다. 수신 시각은 기간마다 독립적입니다. 초기화 시각을 모르면 `resets_at`이 `null`입니다.
- `account`는 UTF-8 문자열 `claude-account-v1/`와 CLI 프로필의 양 끝 공백을 제거한 계정 UUID를 연결해 SHA-256으로 해시한 소문자 16진수입니다. 확인할 수 없으면 `null`입니다.
- 같은 경로의 파일을 원자적으로 교체합니다. 변경 알림을 사용할 때는 상위 디렉터리를 감시하고 파일을 다시 여세요. 최신 여부는 각 기간의 `received_at`으로 판단합니다.
