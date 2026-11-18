mod common;

use common::TestServer;
use reqwest::{Response, StatusCode, header};

fn cookie_pair(response: &Response) -> String {
    response.headers().get(header::SET_COOKIE).unwrap().to_str().unwrap().split(';').next().unwrap().to_owned()
}

async fn login(server: &TestServer) -> String {
    let (_, response) = server.pair_browser("multi-host").await;
    assert_eq!(response.status(), StatusCode::OK);
    cookie_pair(&response)
}

#[tokio::test]
async fn browser_sessions_on_the_same_hostname_do_not_overwrite_each_other() {
    let a = TestServer::start().await;
    let b = TestServer::start().await;
    let cookie_a = login(&a).await;
    let cookie_b = login(&b).await;
    // 브라우저 쿠키에는 port 경계가 없으므로 이름이 다르지 않으면 두 번째 로그인이 첫 쿠키를 덮어쓴다.
    assert!(cookie_a.split_once('=').unwrap().0 != cookie_b.split_once('=').unwrap().0, "다른 authority의 refresh 쿠키는 이름이 달라야 한다");
    let jar = format!("{cookie_a}; {cookie_b}");
    let refreshed_a = a.client.post(format!("{}/api/v1/auth/refresh", a.base)).header(header::COOKIE, &jar).send().await.unwrap();
    assert_eq!(refreshed_a.status(), StatusCode::OK);
    let refreshed_b = b.client.post(format!("{}/api/v1/auth/refresh", b.base)).header(header::COOKIE, &jar).send().await.unwrap();
    assert_eq!(refreshed_b.status(), StatusCode::OK);
    let next_a = cookie_pair(&refreshed_a);
    let next_b = cookie_pair(&refreshed_b);
    let jar = format!("{next_b}; {next_a}"); // 쿠키 순서와 무관하다.
    let out = a.client.post(format!("{}/api/v1/auth/logout", a.base)).header(header::COOKIE, &jar).send().await.unwrap();
    assert_eq!(out.status(), StatusCode::OK);
    let cookie = out.headers().get(header::SET_COOKIE).unwrap().to_str().unwrap();
    assert!(cookie.starts_with(next_a.split_once('=').unwrap().0));
    assert!(cookie.contains("Max-Age=0"));
    let response = a.client.post(format!("{}/api/v1/auth/refresh", a.base)).header(header::COOKIE, &jar).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = b.client.post(format!("{}/api/v1/auth/refresh", b.base)).header(header::COOKIE, &jar).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK, "A의 로그아웃은 B를 폐기하지 않는다");
}

#[tokio::test]
async fn legacy_refresh_cookie_migrates_without_losing_the_session() {
    let server = TestServer::start().await;
    let cookie = login(&server).await;
    let legacy = format!("{}={}", grove::auth::REFRESH_COOKIE, cookie.split_once('=').unwrap().1);
    let response = server.client.post(format!("{}/api/v1/auth/refresh", server.base)).header(header::COOKIE, &legacy).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let migrated = cookie_pair(&response);
    assert!(migrated.split_once('=').unwrap().0 != grove::auth::REFRESH_COOKIE, "기존 쿠키는 authority별 이름으로 갱신한다");
    let response = server.client.post(format!("{}/api/v1/auth/refresh", server.base)).header(header::COOKIE, &legacy).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "이전 refresh 값은 재사용할 수 없다");
}
