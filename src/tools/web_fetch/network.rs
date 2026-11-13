use crate::tools::{ToolError, ToolResult};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use reqwest::{StatusCode, Url, header::HeaderMap};
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

pub(super) const MAX_URL_BYTES: usize = 2048;
const MAX_DNS_ADDRESSES: usize = 32;

pub(super) type Body = Pin<Box<dyn Stream<Item = ToolResult<Bytes>> + Send>>;

pub(super) struct Response {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub peer: Option<SocketAddr>,
    pub body: Body,
}

// 검증 로직은 이 경계를 공통으로 통과한다. 시험 transport도 IP 정책을 교체할 수 없다.
pub(super) trait Transport: Sync {
    fn resolve(&self, url: &Url) -> impl Future<Output = ToolResult<Vec<SocketAddr>>> + Send;
    fn get(&self, url: &Url, addresses: &[SocketAddr]) -> impl Future<Output = ToolResult<Response>> + Send;
}

pub(super) struct Http;

/// 검증된 snapshot만 반환하며 시스템 DNS로 fallback하지 않는 연결 전용 resolver.
pub(super) struct Pinned {
    host: String,
    addresses: Vec<SocketAddr>,
}

impl Pinned {
    pub fn new(url: &Url, addresses: &[SocketAddr]) -> ToolResult<Self> {
        Ok(Self {
            host: host(url)?.trim_end_matches('.').to_ascii_lowercase(),
            addresses: addresses.to_vec(),
        })
    }
}

impl reqwest::dns::Resolve for Pinned {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let result = if self.host.eq_ignore_ascii_case(name.as_str().trim_end_matches('.')) {
            Ok(Box::new(self.addresses.clone().into_iter()) as reqwest::dns::Addrs)
        } else {
            Err(Box::new(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "unplanned DNS host"))
                as Box<dyn std::error::Error + Send + Sync>)
        };
        Box::pin(std::future::ready(result))
    }
}

impl Transport for Http {
    async fn resolve(&self, url: &Url) -> ToolResult<Vec<SocketAddr>> {
        let host = host(url)?;
        let port = port(url)?;
        if let Ok(ip) = host.parse::<IpAddr>() {
            return Ok(vec![SocketAddr::new(ip, port)]);
        }
        let addresses = tokio::net::lookup_host((host, port)).await
            .map_err(|_| ToolError::new("dns_failed", "웹 서버의 DNS 주소를 확인할 수 없습니다"))?
            .take(MAX_DNS_ADDRESSES + 1)
            .collect();
        Ok(addresses)
    }

    async fn get(&self, url: &Url, addresses: &[SocketAddr]) -> ToolResult<Response> {
        // 새 client를 hop마다 만들므로 이전 연결이나 다른 DNS 결과가 재사용되지 않는다.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .referer(false)
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .pool_max_idle_per_host(0)
            .dns_resolver(Arc::new(Pinned::new(url, addresses)?))
            .build()
            .map_err(|_| ToolError::new("network_failed", "웹 조회 HTTP client를 만들 수 없습니다"))?;
        // 사용자·프로필의 헤더, cookie, 자격 증명은 API 입력으로 받지도 복사하지도 않는다.
        let request = request(&client, url)?;
        let response = client.execute(request).await.map_err(network_error)?;
        Ok(Response {
            status: response.status(),
            headers: response.headers().clone(),
            peer: response.remote_addr(),
            body: Box::pin(response.bytes_stream().map(|chunk| chunk.map_err(network_error))),
        })
    }
}

pub(super) fn request(client: &reqwest::Client, url: &Url) -> ToolResult<reqwest::Request> {
    client.get(url.clone())
        .header("Accept", "text/plain, text/markdown, text/html, application/xhtml+xml, application/json, application/xml")
        .header("Accept-Encoding", "gzip, identity")
        .header("User-Agent", "Grove-web-fetch/1")
        .build()
        .map_err(|_| ToolError::new("network_failed", "웹 조회 요청을 만들 수 없습니다"))
}

fn network_error(error: reqwest::Error) -> ToolError {
    // reqwest 오류 문자열은 query·redirect URL·응답을 포함할 수 있다.
    if error.is_timeout() {
        ToolError::new("timeout", "웹 서버 응답 제한 시간을 초과했습니다")
    } else {
        ToolError::new("network_failed", "웹 서버 연결 또는 응답 읽기에 실패했습니다")
    }
}

pub(super) fn parse_url(raw: &str) -> ToolResult<Url> {
    if raw.is_empty() || raw.len() > MAX_URL_BYTES || raw.chars().any(char::is_control) {
        return Err(ToolError::new("invalid_url", "URL이 비어 있거나 길이·문자 제한을 위반했습니다"));
    }
    let mut url = Url::parse(raw).map_err(|_| ToolError::new("invalid_url", "올바른 절대 URL이 필요합니다"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ToolError::new("blocked_url", "HTTP(S) URL만 허용합니다"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ToolError::new("blocked_url", "사용자 자격 정보가 포함된 URL은 허용하지 않습니다"));
    }
    let name = host(&url)?.trim_end_matches('.').to_ascii_lowercase();
    if name == "localhost" || ["localhost", "local", "internal", "home.arpa", "invalid", "test"]
        .iter().any(|suffix| name.ends_with(&format!(".{suffix}")))
    {
        return Err(blocked_address());
    }
    if let Ok(ip) = name.parse::<IpAddr>() {
        if !public_ip(ip) {
            return Err(blocked_address());
        }
    }
    port(&url)?;
    url.set_fragment(None);
    if url.as_str().len() > MAX_URL_BYTES {
        return Err(ToolError::new("invalid_url", "정규화된 URL이 길이 제한을 초과했습니다"));
    }
    Ok(url)
}

fn host(url: &Url) -> ToolResult<&str> {
    url.host_str().map(|host| host.trim_start_matches('[').trim_end_matches(']'))
        .filter(|host| !host.is_empty())
        .ok_or_else(|| ToolError::new("invalid_url", "URL host가 필요합니다"))
}

fn port(url: &Url) -> ToolResult<u16> {
    url.port_or_known_default().filter(|port| *port != 0)
        .ok_or_else(|| ToolError::new("invalid_url", "올바른 HTTP(S) port가 필요합니다"))
}

fn blocked_address() -> ToolError {
    ToolError::new("blocked_address", "비공개·예약·metadata 네트워크 대상은 허용하지 않습니다")
}

pub(super) fn validate_addresses(url: &Url, addresses: &[SocketAddr]) -> ToolResult<()> {
    if addresses.is_empty() || addresses.len() > MAX_DNS_ADDRESSES {
        return Err(ToolError::new("dns_failed", "DNS 주소가 없거나 개수 제한을 초과했습니다"));
    }
    let expected_port = port(url)?;
    let literal = host(url)?.parse::<IpAddr>().ok();
    if addresses.iter().any(|addr| {
        !public_ip(addr.ip()) || addr.port() != expected_port || literal.is_some_and(|ip| ip != addr.ip())
    }) {
        return Err(blocked_address());
    }
    Ok(())
}

pub(super) fn validate_peer(addresses: &[SocketAddr], peer: Option<SocketAddr>) -> ToolResult<()> {
    match peer {
        Some(peer) if public_ip(peer.ip()) && addresses.contains(&peer) => Ok(()),
        _ => Err(ToolError::new("blocked_address", "실제 연결 주소가 검증된 공개 대상과 다릅니다")),
    }
}

fn v4_prefix(ip: Ipv4Addr, network: [u8; 4], bits: u32) -> bool {
    let mask = u32::MAX << (32 - bits);
    u32::from(ip) & mask == u32::from(Ipv4Addr::from(network)) & mask
}

pub(super) fn public_ip(ip: IpAddr) -> bool {
    // IANA special-purpose registry(2025-10-09)를 기준으로 일부 예외도 보수적으로 거부한다.
    // https://www.iana.org/assignments/iana-ipv4-special-registry/
    // https://www.iana.org/assignments/iana-ipv6-special-registry/
    match ip {
        IpAddr::V4(ip) => {
            ![
                ([0, 0, 0, 0], 8), ([10, 0, 0, 0], 8), ([100, 64, 0, 0], 10),
                ([127, 0, 0, 0], 8), ([169, 254, 0, 0], 16), ([172, 16, 0, 0], 12),
                ([192, 0, 0, 0], 24), ([192, 0, 2, 0], 24), ([192, 88, 99, 0], 24),
                ([192, 168, 0, 0], 16), ([198, 18, 0, 0], 15), ([198, 51, 100, 0], 24),
                ([203, 0, 113, 0], 24), ([224, 0, 0, 0], 4), ([240, 0, 0, 0], 4),
            ].into_iter().any(|(network, bits)| v4_prefix(ip, network, bits))
                // Azure의 플랫폼 가상 IP는 공인 형태지만 일반 공개 웹 대상이 아니다.
                && ip != Ipv4Addr::new(168, 63, 129, 16)
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            // 보수적으로 global unicast만 허용한다. mapped/NAT64/ULA/link-local도 제외된다.
            (s[0] & 0xe000 == 0x2000)
                && !(s[0] == 0x2001 && s[1] < 0x0200) // IETF·Teredo·ORCHID 특수 영역
                && !(s[0] == 0x2001 && s[1] == 0x0db8) // 문서 전용
                && s[0] != 0x2002 // 6to4를 통한 내장 IPv4 우회 금지
                && !(s[0] == 0x3fff && s[1] < 0x1000) // 문서 전용
        }
    }
}
