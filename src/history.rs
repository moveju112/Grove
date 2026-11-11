//! 모델 입력 변환의 순차 처리(DB-012). 전체 입력 생성과 페이지 미리보기가 같은 상태 기계를 쓴다.
use crate::error::ApiResult;
use crate::provider::{self, ChatMsg, ToolCall};
use rusqlite::Connection;
use serde_json::{Value, json};

const PREVIEW_CHARS: usize = 4000;

struct Text {
    value: String,
    chars: usize,
}

impl Text {
    fn new(value: &str, preview: bool) -> Self {
        Self { value: if preview { value.chars().take(PREVIEW_CHARS).collect() } else { value.into() }, chars: value.chars().count() }
    }

    fn append(&mut self, other: Self, preview: bool) {
        self.chars += 2 + other.chars;
        if preview {
            let remaining = PREVIEW_CHARS.saturating_sub(self.value.chars().count());
            self.value.extend("\n\n".chars().chain(other.value.chars()).take(remaining));
        } else {
            self.value.push_str("\n\n");
            self.value.push_str(&other.value);
        }
    }
}

struct Entry {
    message: ChatMsg,
    chars: usize,
    extra_chars: usize,
}

/// 완료된 항목은 선택한 페이지만 보관한다. 연속 user 병합을 위해 마지막 항목 하나만 유동 상태로 둔다.
struct Output {
    preview: bool,
    offset: usize,
    limit: usize,
    current: Option<Entry>,
    items: Vec<Entry>,
    total: usize,
    estimated_chars: usize,
}

impl Output {
    fn new(page: Option<(usize, usize)>) -> Self {
        let (offset, limit) = page.unwrap_or((0, usize::MAX));
        Self { preview: page.is_some(), offset, limit, current: None, items: vec![], total: 0, estimated_chars: 0 }
    }

    fn selected(&self) -> bool {
        self.total >= self.offset && self.total - self.offset < self.limit
    }

    fn finish_current(&mut self) {
        if let Some(entry) = self.current.take() {
            self.estimated_chars += entry.chars + entry.extra_chars;
            if self.selected() { self.items.push(entry); }
            self.total += 1;
        }
    }

    fn push(&mut self, mut message: ChatMsg) {
        self.finish_current();
        let (text, extra_chars) = match &mut message {
            ChatMsg::User { text, images } => (text, images.len() * 4096 * 4),
            ChatMsg::Assistant { text, tool_calls } => {
                let extra = tool_calls.iter().map(|call| call.arguments.to_string().len() + call.name.len()).sum();
                if self.preview {
                    for call in tool_calls { call.arguments = Value::Null; }
                }
                (text, extra)
            }
            ChatMsg::Tool { content, .. } => (content, 0),
        };
        let chars = text.chars().count();
        if self.preview {
            *text = if self.selected() { text.chars().take(PREVIEW_CHARS).collect() } else { String::new() };
        }
        self.current = Some(Entry { message, chars, extra_chars });
    }

    fn user(&mut self, text: Text) {
        if let Some(Entry { message: ChatMsg::User { text: previous, .. }, chars, .. }) = &mut self.current {
            let mut merged = Text { value: std::mem::take(previous), chars: *chars };
            merged.append(text, self.preview);
            *previous = merged.value;
            *chars = merged.chars;
        } else {
            self.finish_current();
            let value = if !self.preview || self.selected() { text.value } else { String::new() };
            self.current = Some(Entry { message: ChatMsg::User { text: value, images: vec![] }, chars: text.chars, extra_chars: 0 });
        }
    }

    fn images(&mut self, values: &[Value]) {
        let selected = !self.preview || self.selected();
        if let Some(Entry { message: ChatMsg::User { images, .. }, extra_chars, .. }) = &mut self.current {
            *extra_chars += values.len() * 4096 * 4;
            if selected {
                for item in values {
                    // 잘못된 영속 입력은 hydration 단계에서 명시적으로 실패시킨다.
                    images.push(serde_json::from_value(item.clone()).unwrap_or(provider::ImageInput {
                        id: String::new(), sha256: String::new(), width: 0, height: 0, mime: String::new(), data: String::new(),
                    }));
                }
            }
        }
    }
}

struct Builder {
    output: Output,
    pending: Vec<(String, String)>,
    deferred: Option<Text>,
}

impl Builder {
    fn new(page: Option<(usize, usize)>) -> Self {
        Self { output: Output::new(page), pending: vec![], deferred: None }
    }

    fn flush_notes(&mut self) {
        if let Some(text) = self.deferred.take() { self.output.user(text); }
    }

    fn flush(&mut self) {
        for (id, name) in self.pending.drain(..) {
            self.output.push(ChatMsg::Tool { call_id: id, name, content: "{\"error\":\"결과가 기록되지 않았습니다(중단됨)\"}".into(), is_error: true });
        }
        self.flush_notes();
    }

    fn note(&mut self, text: String) {
        let text = Text::new(&text, self.output.preview);
        if self.pending.is_empty() {
            self.output.user(text);
        } else if let Some(previous) = &mut self.deferred {
            previous.append(text, self.output.preview);
        } else {
            self.deferred = Some(text);
        }
    }

    fn feed(&mut self, role: &str, c: &Value) {
        match role {
            "user" => {
                self.flush();
                self.output.user(Text::new(c["text"].as_str().unwrap_or(""), self.output.preview));
                if let Some(images) = c["images"].as_array() { self.output.images(images); }
            }
            "note" if c["type"] == "task_result" || c["type"] == "agent_result" => {
                let text = if c["type"] == "task_result" {
                    format!("[background task result]\n{}", crate::tasks::note_text(c))
                } else {
                    format!("[child agent result]\n{}", crate::agents::note_text(c))
                };
                self.note(text);
            }
            "note" if c["type"] == "turn_ended" => {
                let mut error = c["error"].clone();
                if let Some(object) = error.as_object_mut() { object.remove("scope"); }
                self.note(format!("[previous request ended: status={}]\n{}", c["status"].as_str().unwrap_or(""), error));
            }
            "assistant" => {
                self.flush();
                let calls: Vec<ToolCall> = c["tool_calls"].as_array().into_iter().flatten().map(|call| ToolCall {
                    id: call["id"].as_str().unwrap_or("").into(),
                    name: call["name"].as_str().unwrap_or("").into(),
                    arguments: call["arguments"].clone(),
                }).collect();
                self.pending = calls.iter().map(|call| (call.id.clone(), call.name.clone())).collect();
                self.output.push(ChatMsg::Assistant { text: c["text"].as_str().unwrap_or("").into(), tool_calls: calls });
            }
            "tool" => {
                let id = c["provider_call_id"].as_str().unwrap_or("");
                if let Some(index) = self.pending.iter().position(|(pending, _)| pending == id) {
                    self.pending.remove(index);
                    self.output.push(ChatMsg::Tool {
                        call_id: id.into(), name: c["name"].as_str().unwrap_or("").into(),
                        content: truncate_tool_output(&provider::tool_content_string(&c["output"])),
                        is_error: c["is_error"].as_bool().unwrap_or(false),
                    });
                    if self.pending.is_empty() { self.flush_notes(); }
                }
            }
            _ => {}
        }
    }

    fn finish(mut self) -> Output {
        self.flush();
        self.output.finish_current();
        self.output
    }
}

fn truncate_tool_output(text: &str) -> String {
    const MAX: usize = 100 * 1024;
    if text.len() <= MAX { return text.into(); }
    let mut end = MAX;
    while !text.is_char_boundary(end) { end -= 1; }
    format!("{}\n…(출력 {}바이트 중 {}바이트만 전달)", &text[..end], text.len(), end)
}

pub(crate) fn from_rows(rows: &[(String, Value, Option<Value>)]) -> Vec<ChatMsg> {
    let mut builder = Builder::new(None);
    for (role, content, model_input) in rows { builder.feed(role, model_input.as_ref().unwrap_or(content)); }
    builder.finish().items.into_iter().map(|entry| entry.message).collect()
}

fn read(conn: &Connection, session: &str, upto: Option<i64>, page: Option<(usize, usize)>) -> ApiResult<Output> {
    let mut builder = Builder::new(page);
    crate::sessions::visit_model_history(conn, session, upto, &mut |role, input| builder.feed(role, input))?;
    Ok(builder.finish())
}

pub(crate) fn model_chat(conn: &Connection, session: &str, upto: Option<i64>) -> ApiResult<Vec<ChatMsg>> {
    Ok(read(conn, session, upto, None)?.items.into_iter().map(|entry| entry.message).collect())
}

pub(crate) fn estimated_tokens(conn: &Connection, session: &str) -> ApiResult<u64> {
    Ok((read(conn, session, None, Some((0, 0)))?.estimated_chars as u64).div_ceil(4))
}

pub(crate) fn preview(conn: &Connection, session: &str, offset: usize, limit: usize) -> ApiResult<Value> {
    let output = read(conn, session, None, Some((offset, limit)))?;
    let offset = offset.min(output.total);
    let items: Vec<Value> = output.items.into_iter().enumerate().map(|(index, entry)| {
        let cut = |text: String| {
            let count = text.chars().count();
            if count < entry.chars { json!({ "text": text, "truncated_chars": entry.chars - count }) }
            else { json!({ "text": text }) }
        };
        let mut value = match entry.message {
            ChatMsg::User { text, images } => json!({ "role": "user", "content": cut(text), "images": images }),
            ChatMsg::Assistant { text, tool_calls } => json!({ "role": "assistant", "content": cut(text), "tool_calls": tool_calls.iter().map(|c| json!({ "id": c.id, "name": c.name })).collect::<Vec<_>>() }),
            ChatMsg::Tool { call_id, name, content, is_error } => json!({ "role": "tool", "call_id": call_id, "name": name, "is_error": is_error, "content": cut(content) }),
        };
        value["index"] = json!(offset + index);
        value
    }).collect();
    let next = (offset + items.len() < output.total).then_some(offset + items.len());
    Ok(json!({ "total": output.total, "offset": offset, "items": items, "next_offset": next,
        "note": "시스템 프롬프트와 도구 정의는 턴마다 정의 snapshot으로 따로 붙는다" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_keeps_one_page_and_counts_merged_unicode_without_retaining_other_text() {
        let mut builder = Builder::new(Some((2, 1)));
        for index in 0..1000 {
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            builder.feed(role, &json!({ "text": "가".repeat(5000) }));
            if index == 2 { builder.feed("user", &json!({ "text": "나".repeat(5000) })); }
        }
        let output = builder.finish();
        assert_eq!(output.total, 1000);
        assert_eq!(output.items.len(), 1);
        assert_eq!(output.items[0].chars, 10002);
        let ChatMsg::User { text, .. } = &output.items[0].message else { panic!("user expected") };
        assert_eq!(text.chars().count(), PREVIEW_CHARS);
        assert_eq!(output.estimated_chars, 5_005_002);
    }

    #[test]
    fn deferred_notes_are_bounded_and_keep_the_same_user_merge_and_estimate() {
        let mut builder = Builder::new(Some((0, 10)));
        builder.feed("assistant", &json!({ "tool_calls": [{ "id": "a", "name": "read", "arguments": {} }] }));
        for _ in 0..1000 { builder.note("가".repeat(100)); }
        assert_eq!(builder.deferred.as_ref().unwrap().value.chars().count(), PREVIEW_CHARS);
        builder.feed("tool", &json!({ "provider_call_id": "a", "name": "read", "output": "ok" }));
        let output = builder.finish();
        assert_eq!(output.total, 3);
        assert_eq!(output.items[2].chars, 101_998);
    }
}
