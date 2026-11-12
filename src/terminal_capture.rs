//! 터미널 제어문자를 해석한 화면의 읽기 전용 사본. 셸에 입력하거나 명령을 재실행하지 않는다.
use crate::error::{ApiError, ApiResult};
use serde::{Deserialize, Serialize};

pub const HISTORY: usize = 1024;
pub const MAX_SAVED_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
pub struct Snapshot {
    format: u8,
    pub rows: u16,
    pub cols: u16,
    pub lines: Vec<String>,
}

impl Snapshot {
    pub fn from_screen(mut screen: vt100::Screen) -> Self {
        let (rows, cols) = screen.size();
        screen.set_scrollback(usize::MAX);
        let history = screen.scrollback();
        let total = history + usize::from(rows);
        let mut lines = Vec::with_capacity(total);
        while lines.len() < total {
            let window = lines.len().min(history);
            screen.set_scrollback(history - window);
            let skip = lines.len() - window;
            lines.extend(screen.rows(0, cols).skip(skip).map(|line| line.trim_end().to_string()));
        }
        Self { format: 1, rows, cols, lines }
    }

    pub fn validate(&self) -> ApiResult<()> {
        if self.format != 1 || !(4..=300).contains(&self.rows) || !(10..=500).contains(&self.cols)
            || self.lines.len() < usize::from(self.rows) || self.lines.len() > HISTORY + usize::from(self.rows)
        {
            return Err(unavailable());
        }
        Ok(())
    }

    pub fn select(&self, start: Option<i64>, end: Option<i64>) -> serde_json::Value {
        let total = self.lines.len();
        let index = |value: i64| {
            let resolved = if value < 0 { (total as i64).saturating_add(value) } else { value };
            resolved.clamp(0, total.saturating_sub(1) as i64) as usize
        };
        let first = start.map(index).unwrap_or(0);
        let last = end.map(index).unwrap_or(total.saturating_sub(1));
        let lines = if total == 0 || first > last { &[] } else { &self.lines[first..=last] };
        serde_json::json!({"lines":lines,"total_lines":total,"start":first,"end":last,"rows":self.rows,"cols":self.cols})
    }
}

pub fn unavailable() -> ApiError {
    ApiError::conflict("terminal_capture_unavailable", "보존된 터미널 화면을 읽지 못했습니다. 빈 캡처나 명령 재실행으로 대체하지 않습니다.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture(bytes: &[u8], rows: u16, cols: u16) -> Snapshot {
        let mut parser = vt100::Parser::new(rows, cols, HISTORY);
        for chunk in bytes.chunks(1) { parser.process(chunk); }
        Snapshot::from_screen(parser.screen().clone())
    }

    #[test]
    fn interprets_controls_utf8_wrapping_and_keeps_physical_rows() {
        let snapshot = capture("old\r\u{1b}[2K\u{1b}[31m한글\u{1b}[m\r\nabcdefghijk".as_bytes(), 4, 10);
        assert_eq!(snapshot.lines, ["한글", "abcdefghij", "k", ""]);
        assert_eq!(snapshot.select(Some(0),Some(0))["lines"],serde_json::json!(["한글"]));
        let alternate = capture(b"normal\x1b[?1049halternate\x1b[?1049l", 4, 10);
        assert_eq!(alternate.lines[0],"normal");
        let erased = capture(b"secret\x1b[2J\x1b[Hsafe", 4, 10);
        assert_eq!(erased.lines[0],"safe");
        assert!(!erased.lines.join("\n").contains("secret"));
    }

    #[test]
    fn clamps_inclusive_negative_ranges_and_handles_reversed_ranges() {
        let snapshot = capture(b"one\r\ntwo\r\nthree\r\nfour",4,10);
        assert_eq!(snapshot.select(Some(-2),None)["lines"],serde_json::json!(["three","four"]));
        assert_eq!(snapshot.select(Some(i64::MIN),Some(i64::MAX))["lines"],serde_json::json!(snapshot.lines));
        assert_eq!(snapshot.select(Some(3),Some(1))["lines"],serde_json::json!([]));
        assert_eq!(snapshot.select(Some(100),Some(100))["lines"],serde_json::json!(["four"]));
    }

    #[test]
    fn bounded_history_and_partial_last_window_have_no_duplicates() {
        let mut bytes = Vec::new();
        for index in 0..(HISTORY+50) { bytes.extend_from_slice(format!("{index}\r\n").as_bytes()); }
        let snapshot = capture(&bytes, 7, 20);
        assert_eq!(snapshot.lines.len(),HISTORY+7);
        let expected: Vec<_> = (44..HISTORY+50).map(|index|index.to_string()).chain(std::iter::once(String::new())).collect();
        assert_eq!(snapshot.lines,expected);
    }

    #[test]
    fn saved_format_is_checked_without_turning_corruption_into_empty_success() {
        let mut snapshot = capture(b"fixture",4,10);
        snapshot.validate().unwrap();
        snapshot.format = 2;
        assert_eq!(snapshot.validate().unwrap_err().code,"terminal_capture_unavailable");
        snapshot.format = 1;
        snapshot.lines.clear();
        assert!(snapshot.validate().is_err());
    }
}
