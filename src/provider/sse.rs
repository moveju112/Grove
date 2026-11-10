//! HTTP 응답의 SSE framing(ADAPTER-003). 바이트 단위로 누적해 부분 UTF-8·부분 줄을 안전하게 처리한다.

use super::{MAX_OUTPUT_BYTES, ProviderError, transport_error};

#[derive(Debug, Default, Clone, PartialEq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    cur: SseEvent,
    has_data: bool,
    total: usize,
}

impl SseParser {
    /// 새 바이트를 넣고 완성된 이벤트들을 반환한다.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<SseEvent>, ProviderError> {
        self.total += bytes.len();
        if self.total > MAX_OUTPUT_BYTES * 2 {
            return Err(ProviderError::new("output_too_large", "provider 응답이 너무 큽니다"));
        }
        self.buf.extend_from_slice(bytes);
        let mut out = vec![];
        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            // 완성된 줄은 UTF-8 경계가 맞아야 한다. 깨진 바이트는 대체 문자로 표시한다.
            let line = String::from_utf8_lossy(&line).to_string();
            if line.is_empty() {
                if self.has_data || self.cur.event.is_some() {
                    out.push(std::mem::take(&mut self.cur));
                    self.has_data = false;
                }
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
                None => (line.as_str(), ""),
            };
            match field {
                "event" => self.cur.event = Some(value.to_string()),
                "data" => {
                    if self.has_data {
                        self.cur.data.push('\n');
                    }
                    self.cur.data.push_str(value);
                    self.has_data = true;
                }
                _ => {}
            }
        }
        Ok(out)
    }

    /// stream 종료 시 남은 이벤트(빈 줄 없이 끝난 경우).
    pub fn finish(&mut self) -> Option<SseEvent> {
        if !self.buf.is_empty() {
            let rest = std::mem::take(&mut self.buf);
            let _ = self.push(&[]);
            let line = String::from_utf8_lossy(&rest).to_string();
            if let Some(v) = line.strip_prefix("data:") {
                if self.has_data {
                    self.cur.data.push('\n');
                }
                self.cur.data.push_str(v.strip_prefix(' ').unwrap_or(v));
                self.has_data = true;
            }
        }
        if self.has_data {
            self.has_data = false;
            return Some(std::mem::take(&mut self.cur));
        }
        None
    }
}

/// 응답 본문을 SSE 이벤트로 읽어 콜백에 전달한다. 콜백이 true를 반환하면 정상 종료로 본다.
pub async fn read_events(
    mut resp: reqwest::Response,
    mut on_event: impl FnMut(SseEvent) -> Result<bool, ProviderError>,
) -> Result<bool, ProviderError> {
    let mut p = SseParser::default();
    loop {
        let chunk = resp.chunk().await.map_err(transport_error)?;
        let Some(chunk) = chunk else { break };
        for ev in p.push(&chunk)? {
            if on_event(ev)? {
                return Ok(true);
            }
        }
    }
    if let Some(ev) = p.finish() {
        if on_event(ev)? {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_frames_and_utf8_boundaries() {
        let mut p = SseParser::default();
        let full = "event: a\ndata: 안녕\n\ndata: x\ndata: y\n\n".as_bytes();
        let mut events = vec![];
        // 한 바이트씩 넣어도 같은 결과(부분 UTF-8 포함)
        for b in full {
            events.extend(p.push(std::slice::from_ref(b)).unwrap());
        }
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event.as_deref(), Some("a"));
        assert_eq!(events[0].data, "안녕");
        assert_eq!(events[1].data, "x\ny");
    }

    #[test]
    fn crlf_comments_and_unterminated_tail() {
        let mut p = SseParser::default();
        let ev = p.push(b": keepalive\r\ndata: 1\r\n\r\ndata: tail").unwrap();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].data, "1");
        assert_eq!(p.finish().unwrap().data, "tail");
        assert!(p.finish().is_none());
    }
}
