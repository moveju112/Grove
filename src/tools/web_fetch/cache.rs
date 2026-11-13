use reqwest::{Url, header::HeaderMap};
use serde_json::Value;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

const MAX_ENTRIES: usize = 16;
const MAX_BYTES: usize = 512 * 1024;
const MAX_TTL: Duration = Duration::from_secs(60);

struct Entry {
    key: String,
    value: Value,
    size: usize,
    expires: Instant,
}

#[derive(Default)]
pub(super) struct Cache {
    entries: VecDeque<Entry>,
    bytes: usize,
}

impl Cache {
    fn prune(&mut self, now: Instant) {
        self.entries.retain(|entry| entry.expires > now);
        self.bytes = self.entries.iter().map(|entry| entry.size).sum();
    }

    pub fn get(&mut self, key: &str, now: Instant) -> Option<Value> {
        self.prune(now);
        self.entries.iter().find(|entry| entry.key == key).map(|entry| entry.value.clone())
    }

    pub fn put(&mut self, key: String, value: Value, ttl: Duration, now: Instant) {
        self.prune(now);
        let Ok(encoded) = serde_json::to_vec(&value) else { return };
        let size = key.len() + encoded.len();
        if ttl.is_zero() || size > MAX_BYTES {
            return;
        }
        self.entries.retain(|entry| entry.key != key);
        self.bytes = self.entries.iter().map(|entry| entry.size).sum();
        while self.entries.len() >= MAX_ENTRIES || self.bytes + size > MAX_BYTES {
            let Some(entry) = self.entries.pop_front() else { break };
            self.bytes -= entry.size;
        }
        self.bytes += size;
        self.entries.push_back(Entry { key, value, size, expires: now + ttl.min(MAX_TTL) });
    }
}

pub(super) fn eligible_url(url: &Url) -> bool {
    // query에는 서명·일회용 토큰·검색 개인정보가 들어갈 수 있다.
    url.query().is_none() && url.username().is_empty() && url.password().is_none()
}

pub(super) fn ttl(url: &Url, headers: &HeaderMap) -> Option<Duration> {
    if !eligible_url(url) || [
        "set-cookie", "www-authenticate", "proxy-authenticate", "authentication-info",
        "proxy-authentication-info", "vary", "pragma", "content-disposition",
    ].iter().any(|name| headers.contains_key(*name)) {
        return None;
    }
    let control = super::content::single_header(headers, "cache-control").ok()??;
    // 명시적으로 public + max-age를 선언한 직접 200 응답만 cache한다.
    let mut public = false;
    let mut max_age = None;
    for directive in control.split(',') {
        let directive = directive.trim().to_ascii_lowercase();
        if directive == "public" {
            public = true;
        } else if let Some(age) = directive.strip_prefix("max-age=") {
            if max_age.is_some() {
                return None;
            }
            max_age = Some(age.trim_matches('"').parse::<u64>().ok()?);
        } else {
            // private/no-store/no-cache 및 알 수 없는 정책도 보수적으로 cache 제외.
            return None;
        }
    }
    let age = super::content::single_header(headers, "age").ok()?
        .map(|value| value.trim().parse::<u64>()).transpose().ok()?.unwrap_or(0);
    let remaining = max_age?.saturating_sub(age).min(MAX_TTL.as_secs());
    (public && remaining > 0).then_some(Duration::from_secs(remaining))
}
