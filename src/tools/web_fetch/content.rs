use super::{check, network::Response};
use crate::tools::{ToolError, ToolResult};
use flate2::read::MultiGzDecoder;
use futures_util::StreamExt;
use reqwest::header::HeaderMap;
use std::io::Read;
use std::time::Instant;
use tokio::sync::watch;

pub(super) const MAX_WIRE_BYTES: usize = 1024 * 1024;
pub(super) const MAX_DECODED_BYTES: usize = 2 * 1024 * 1024;

pub(super) struct Decoded {
    pub text: String,
    pub media_type: String,
    pub representation: &'static str,
    pub extraction: &'static str,
    pub wire_bytes: usize,
    pub decoded_bytes: usize,
}

pub(super) fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> ToolResult<Option<&'a str>> {
    let mut values = headers.get_all(name).iter();
    let first = values.next();
    if values.next().is_some() {
        return Err(ToolError::new("invalid_response", "중복된 웹 응답 제어 헤더는 지원하지 않습니다"));
    }
    first.map(|value| value.to_str().map_err(|_| ToolError::new("invalid_response", "올바르지 않은 웹 응답 헤더입니다"))).transpose()
}

fn media_type(headers: &HeaderMap) -> ToolResult<(String, bool)> {
    let value = single_header(headers, "content-type")?
        .filter(|value| value.len() <= 512)
        .ok_or_else(|| ToolError::new("unsupported_content_type", "지원하는 텍스트 Content-Type이 필요합니다"))?;
    let mut parts = value.split(';');
    let media = parts.next().unwrap_or("").trim().to_ascii_lowercase();
    if !matches!(media.as_str(), "text/plain" | "text/markdown" | "text/html" | "application/xhtml+xml" | "application/json" | "application/xml" | "text/xml") {
        return Err(ToolError::new("unsupported_content_type", "이 응답 형식의 웹 본문 조회는 지원하지 않습니다"));
    }
    let mut charset = None;
    for part in parts {
        let Some((key, value)) = part.trim().split_once('=') else {
            return Err(ToolError::new("invalid_response", "Content-Type 매개변수가 올바르지 않습니다"));
        };
        if key.trim().eq_ignore_ascii_case("charset") {
            if charset.is_some() {
                return Err(ToolError::new("invalid_response", "중복된 charset은 지원하지 않습니다"));
            }
            charset = Some(value.trim().trim_matches('"').to_ascii_lowercase());
        }
    }
    let ascii = match charset.as_deref() {
        None | Some("utf-8" | "utf8") => false,
        Some("us-ascii" | "ascii") => true,
        _ => return Err(ToolError::new("unsupported_charset", "UTF-8·ASCII 이외의 문자 인코딩은 지원하지 않습니다")),
    };
    Ok((media, ascii))
}

pub(super) async fn read(
    mut response: Response,
    cancel: &watch::Receiver<bool>,
    deadline: Instant,
) -> ToolResult<Decoded> {
    let (media_type, ascii) = media_type(&response.headers)?;
    let encoding = single_header(&response.headers, "content-encoding")?.unwrap_or("identity").trim().to_ascii_lowercase();
    if !matches!(encoding.as_str(), "identity" | "gzip") {
        return Err(ToolError::new("unsupported_encoding", "identity·gzip 이외의 전송 압축은 지원하지 않습니다"));
    }
    if let Some(length) = single_header(&response.headers, "content-length")? {
        let length = length.trim().parse::<u64>()
            .map_err(|_| ToolError::new("invalid_response", "Content-Length가 올바르지 않습니다"))?;
        if length > MAX_WIRE_BYTES as u64 {
            return Err(too_large());
        }
    }
    let mut wire = Vec::new();
    while let Some(chunk) = response.body.next().await {
        check(cancel, deadline)?;
        let chunk = chunk?;
        if chunk.len() > MAX_WIRE_BYTES.saturating_sub(wire.len()) {
            return Err(too_large());
        }
        wire.extend_from_slice(&chunk);
    }
    check(cancel, deadline)?;
    let wire_bytes = wire.len();
    let bytes = decode(&wire, &encoding, cancel, deadline)?;
    let decoded_bytes = bytes.len();
    if ascii && !bytes.is_ascii() {
        return Err(ToolError::new("unsupported_charset", "응답이 선언된 ASCII 인코딩과 다릅니다"));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| ToolError::new("unsupported_charset", "웹 응답은 올바른 UTF-8 텍스트가 아닙니다"))?;
    let (representation, extraction) = match media_type.as_str() {
        "text/plain" | "text/markdown" => ("text", "not_needed"),
        "text/html" | "application/xhtml+xml" => ("html_source", "unsupported"),
        _ => ("structured_source", "unsupported"),
    };
    Ok(Decoded { text, media_type, representation, extraction, wire_bytes, decoded_bytes })
}

pub(super) fn decode(
    wire: &[u8],
    encoding: &str,
    cancel: &watch::Receiver<bool>,
    deadline: Instant,
) -> ToolResult<Vec<u8>> {
    check(cancel, deadline)?;
    if wire.len() > MAX_WIRE_BYTES {
        return Err(too_large());
    }
    if encoding == "identity" {
        return Ok(wire.to_vec());
    }
    if encoding != "gzip" {
        return Err(ToolError::new("unsupported_encoding", "지원하지 않는 전송 압축입니다"));
    }
    // 다중 gzip member와 checksum도 확인한다. 압축 폭탄은 출력 상한+1 byte에서 중단한다.
    let mut reader = MultiGzDecoder::new(wire);
    let mut decoded = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        check(cancel, deadline)?;
        let limit = buffer.len().min(MAX_DECODED_BYTES + 1 - decoded.len());
        let read = reader.read(&mut buffer[..limit])
            .map_err(|_| ToolError::new("invalid_encoding", "gzip 응답을 해제할 수 없습니다"))?;
        if read == 0 {
            return Ok(decoded);
        }
        if read > MAX_DECODED_BYTES.saturating_sub(decoded.len()) {
            return Err(too_large());
        }
        decoded.extend_from_slice(&buffer[..read]);
    }
}

fn too_large() -> ToolError {
    ToolError::new("response_too_large", "웹 응답 또는 압축 해제 결과가 크기 제한을 초과했습니다")
}

pub(super) fn boundary(text: &str, mut end: usize) -> usize {
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}
