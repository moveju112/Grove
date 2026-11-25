//! 첨부 원문·참조·모델 입력·복구를 실제 로컬 HTTP 서버로 검증한다.
use crate::common;

use base64::{Engine, engine::general_purpose::STANDARD};
use common::fixture::{self, Fixture};
use common::*;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

async fn upload(s: &TestServer, pid: &str, name: &str, bytes: &[u8]) -> Value {
    let (st, v) = s
        .post(
            &format!("/api/v1/projects/{pid}/attachments"),
            json!({"name":name,"data_base64":STANDARD.encode(&bytes)}),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    v
}
fn blob(s: &TestServer, v: &Value) -> PathBuf {
    let sha = v["sha256"].as_str().unwrap();
    s.data_dir()
        .join("attachments/blobs")
        .join(&sha[..2])
        .join(sha)
}
fn age(p: &Path) {
    std::fs::File::open(p)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(7200))
        .unwrap();
}
async fn gc(s: &TestServer) -> Value {
    let app = s.server.as_ref().unwrap().app.clone();
    tokio::task::spawn_blocking(move || grove::storage::gc(&app))
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn previews_preserve_originals_and_check_access() {
    let s = TestServer::start().await;
    let project = s.create_project("preview").await;
    let pid = project["id"].as_str().unwrap();
    let other = s.registered_device("preview reader").await;
    let text = "한".repeat(9000);
    let image = png(320, 80);
    for (name, bytes, mode) in [("text.txt", text.as_bytes(), "text"), ("image.png", image.as_slice(), "image")] {
        let a = upload(&s, pid, name, bytes).await;
        let path = format!("/api/v1/attachments/{}/content", a["id"].as_str().unwrap());
        let preview = format!("{path}?preview={mode}");
        let denied = s.raw(Method::GET, &preview, None, None, other["token"].as_str()).await;
        assert_eq!(denied.status(), StatusCode::NOT_FOUND);
        let result = s.raw(Method::GET, &preview, None, None, None).await;
        assert_eq!(result.status(), StatusCode::OK);
        if mode == "text" {
            assert_eq!(result.text().await.unwrap(), "한".repeat(8192));
        } else {
            let img = image::load_from_memory(&result.bytes().await.unwrap()).unwrap();
            assert_eq!((img.width(), img.height()), (160, 40));
        }
        assert_eq!(s.raw(Method::GET, &path, None, None, None).await.bytes().await.unwrap().as_ref(), bytes);
    }
}

#[tokio::test]
async fn final_media_is_snapshotted_and_never_reads_outside_the_project_or_past_policy() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let project = s.create_project("media").await;
    let pid = project["id"].as_str().unwrap();
    let session = s.create_session(pid).await;
    let sid = session["id"].as_str().unwrap();
    let root = Path::new(project["root_path"].as_str().unwrap());
    let png = png(10, 10);
    let gif = include_bytes!("../fixtures/images/animated.gif");
    let mp4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom";
    std::fs::write(root.join("시안 이미지.png"), &png).unwrap();
    std::fs::write(root.join("motion.gif"), gif).unwrap();
    std::fs::write(root.join("clip.mp4"), mp4).unwrap();
    std::fs::write(root.join("unsafe.html"), "<script>not media</script>").unwrap();
    #[cfg(unix)]
    {
        let outside = root.parent().unwrap().join("outside.png");
        std::fs::write(&outside, &png).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("outside-link.png")).unwrap();
    }
    let manifest = "시안이 준비됐어요.\n\n```grove-media\n시안 이미지.png\nmotion.gif\nclip.mp4\nunsafe.html\n../outside.png\noutside-link.png\n```";
    for blocked in [false, true] {
        if blocked {
            let (status, _) = s.send(Method::PUT, &format!("/api/v1/settings/session/{sid}/tools.deny"),
                json!({"expected_revision":0,"value":"read"})).await;
            assert_eq!(status, StatusCode::OK);
        }
        f.push(fixture::text(manifest));
        let (status, body) = s.post(&format!("/api/v1/sessions/{sid}/turns"),
            json!({"profile_id":profile,"text":"결과를 파일로 보여줘"})).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{body}");
        s.wait_status(body["turn"]["id"].as_str().unwrap(), "completed").await;
        let messages = s.get(&format!("/api/v1/sessions/{sid}/messages")).await.1;
        let message = messages["items"].as_array().unwrap().iter().find(|m|
            m["role"] == "assistant" && m["turn_id"] == body["turn"]["id"]).unwrap();
        let content = &message["content"];
        let text = content["text"].as_str().unwrap();
        assert!(!text.contains("grove-media"));
        assert!(text.contains("첨부하지 못했어요"));
        if blocked {
            assert!(content.get("attachments").is_none());
            continue;
        }
        let attached = content["attachments"].as_array().unwrap();
        assert_eq!(attached.iter().map(|a| a["mime"].as_str().unwrap()).collect::<Vec<_>>(),
            ["image/png", "image/gif", "video/mp4"]);
        for (a, expected) in attached.iter().zip([png.as_slice(), gif.as_slice(), mp4.as_slice()]) {
            std::fs::remove_file(root.join(a["name"].as_str().unwrap())).unwrap();
            let response = s.raw(Method::GET, &format!("/api/v1/attachments/{}/content", a["id"].as_str().unwrap()), None, None, None).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["content-type"], a["mime"].as_str().unwrap());
            assert_eq!(response.bytes().await.unwrap().as_ref(), expected);
            // 다음 턴에서 미디어가 존재해도 정책이 거절하는지 확인한다.
            std::fs::write(root.join(a["name"].as_str().unwrap()), expected).unwrap();
        }
    }
}

#[tokio::test]
async fn upload_replay_download_and_pending_ownership() {
    let s = TestServer::start().await;
    let p = s.create_project("upload").await;
    let pid = p["id"].as_str().unwrap();
    let url = format!("/api/v1/projects/{pid}/attachments");
    let body =
        json!({"name":"원문.html","data_base64":STANDARD.encode("<script>fixture</script>")});
    let r = s
        .raw(
            Method::POST,
            &url,
            Some(body.clone()),
            Some("upload-once"),
            None,
        )
        .await;
    assert_eq!(r.status(), StatusCode::CREATED);
    let a: Value = r.json().await.unwrap();
    let r = s
        .raw(
            Method::POST,
            &url,
            Some(body.clone()),
            Some("upload-once"),
            None,
        )
        .await;
    assert_eq!(r.status(), StatusCode::CREATED);
    assert_eq!(r.json::<Value>().await.unwrap(), a);
    let mut changed = body.clone();
    changed["name"] = json!("other.html");
    assert_eq!(
        s.raw(Method::POST, &url, Some(changed), Some("upload-once"), None)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        s.raw(Method::POST, &url, Some(body), None, None)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    let disclosed: i64 = db.query_row("SELECT COUNT(*) FROM events WHERE kind='attachment.updated' AND json_extract(payload,'$.name')='원문.html'", [], |r| r.get(0)).unwrap();
    assert_eq!(
        disclosed, 0,
        "미전송 파일명은 공용 이벤트에 노출하지 않는다"
    );
    assert_eq!(a["mime"], "text/plain");
    assert_eq!(
        a["sha256"],
        grove::util::sha256_hex(b"<script>fixture</script>")
    );
    assert!(a.get("owner_id").is_none() && a.get("storage_key").is_none());
    let id = a["id"].as_str().unwrap();
    let content_url = format!("/api/v1/attachments/{id}/content");
    let r = s.raw(Method::GET, &content_url, None, None, None).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()["content-type"], "text/plain");
    assert_eq!(r.headers()["x-content-type-options"], "nosniff");
    assert!(
        r.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .starts_with("sandbox")
    );
    assert_eq!(r.text().await.unwrap(), "<script>fixture</script>");
    assert_eq!(
        s.raw(Method::GET, &content_url, None, None, Some(""))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let dev = s.registered_device("fixture device").await;
    let token = dev["token"].as_str().unwrap();
    assert_eq!(
        s.raw(Method::GET, &content_url, None, None, Some(token))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let session = s.create_session(pid).await;
    let sid = session["id"].as_str().unwrap();
    assert_eq!(
        s.post(
            &format!("/api/v1/sessions/{sid}/messages"),
            json!({"text":"","attachments":[id]})
        )
        .await
        .0,
        StatusCode::CREATED
    );
    assert_eq!(
        s.raw(Method::GET, &content_url, None, None, Some(token))
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        s.send(
            Method::DELETE,
            &format!("/api/v1/attachments/{id}"),
            json!({})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let dup = upload(&s, pid, "same.txt", b"<script>fixture</script>").await;
    assert_ne!(dup["id"], a["id"]);
    assert_eq!(blob(&s, &dup), blob(&s, &a));
    let url = format!("/api/v1/attachments/{}", dup["id"].as_str().unwrap());
    for _ in 0..2 {
        assert_eq!(
            s.raw(Method::DELETE, &url, None, Some("delete-once"), None)
                .await
                .status(),
            StatusCode::OK
        );
    }
    age(&blob(&s, &a));
    gc(&s).await;
    assert!(
        blob(&s, &a).is_file(),
        "다른 메타데이터를 지워도 참조 원문 보존"
    );
}

#[tokio::test]
async fn upload_rejects_invalid_names_base64_and_oversize() {
    let s = TestServer::start().await;
    let p = s.create_project("limits").await;
    let url = format!("/api/v1/projects/{}/attachments", p["id"].as_str().unwrap());
    for name in ["../x", "x/y", "x\\y", "\n", ".."] {
        assert_eq!(
            s.post(&url, json!({"name":name,"data_base64":"eA=="}))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        s.post(&url, json!({"name":"x", "data_base64":"!invalid"}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let mut bytes = vec![b'x'; grove::attachments::MAX_FILE_BYTES + 1];
    assert_eq!(
        s.post(
            &url,
            json!({"name":"big", "data_base64":STANDARD.encode(&bytes)})
        )
        .await
        .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    bytes.pop();
    assert_eq!(
        s.post(
            &url,
            json!({"name":"maximum.txt","data_base64":STANDARD.encode(&bytes)})
        )
        .await
        .0,
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn message_binding_is_atomic_and_persistent_with_distinct_model_input() {
    let mut s = TestServer::start().await;
    let p = s.create_project("binding").await;
    let pid = p["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let a = upload(&s, pid, "한국어.txt", "첨부 원문".as_bytes()).await;
    let id = a["id"].as_str().unwrap().to_owned();
    let q = s.create_project("other").await;
    let foreign = upload(&s, q["id"].as_str().unwrap(), "foreign", b"foreign").await;
    let url = format!("/api/v1/sessions/{sid}/messages");
    for ids in [
        json!([id, foreign["id"]]),
        json!([id, id]),
        json!(vec![id.clone(); 9]),
    ] {
        let (st, _) = s.post(&url, json!({"text":"fail","attachments":ids})).await;
        assert!(st.is_client_error());
    }
    let (_, history) = s.get(&url).await;
    assert!(history["items"].as_array().unwrap().is_empty());
    assert_eq!(
        s.get(&format!("/api/v1/attachments/{id}")).await.1["ref_count"],
        0
    );
    let body = json!({"text":"화면 본문","attachments":[id]});
    let r = s
        .raw(
            Method::POST,
            &url,
            Some(body.clone()),
            Some("message-once"),
            None,
        )
        .await;
    assert_eq!(r.status(), StatusCode::CREATED);
    let message: Value = r.json().await.unwrap();
    assert_eq!(message["content"]["text"], "화면 본문");
    assert_eq!(message["content"]["attachments"][0]["id"], id);
    assert!(!message.to_string().contains("첨부 원문"));
    let mid = message["id"].as_str().unwrap().to_owned();
    let r = s
        .raw(Method::POST, &url, Some(body), Some("message-once"), None)
        .await;
    assert_eq!(r.json::<Value>().await.unwrap()["id"], mid);
    s.restart().await;
    let (_, history) = s.get(&url).await;
    assert_eq!(history["items"][0]["id"], mid);
    assert_eq!(
        s.get(&format!("/api/v1/attachments/{id}")).await.1["ref_count"],
        1
    );
    let (_, input) = s.get(&format!("/api/v1/sessions/{sid}/model-input")).await;
    assert!(input.to_string().contains("첨부 원문"));
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    let payload: String = db.query_row("SELECT payload FROM events WHERE kind='message.created' AND json_extract(payload,'$.id')=?1", [&mid], |r|r.get(0)).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&payload).unwrap()["content"],
        message["content"]
    );
    std::fs::write(
        blob(&s, &a),
        vec![b'x'; a["size"].as_u64().unwrap() as usize],
    )
    .unwrap();
    assert_eq!(
        s.post(&url, json!({"text":"broken","attachments":[id]}))
            .await
            .0,
        StatusCode::GONE
    );
    assert_eq!(s.get(&url).await.1["items"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn model_turn_and_retry_keep_attachment_and_bounded_excerpt() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let prof = s.fixture_profile(&f.base).await;
    let p = s.create_project("model-attachment").await;
    let pid = p["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let text = format!("{}UNSENT_TAIL", "가".repeat(9000));
    let a = upload(&s, pid, "long.txt", text.as_bytes()).await;
    f.push(fixture::Step::Error(400, "fixture refusal".into()));
    let (st, v) = s
        .post(
            &format!("/api/v1/sessions/{sid}/turns"),
            json!({"text":"","profile_id":prof,"attachments":[a["id"]]}),
        )
        .await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    let tid = v["turn"]["id"].as_str().unwrap();
    assert_eq!(v["message"]["content"]["attachments"][0]["id"], a["id"]);
    s.wait_status(tid, "failed").await;
    f.push(fixture::text("확인 완료"));
    let (st, retry) = s
        .post(&format!("/api/v1/turns/{tid}/retry"), json!({}))
        .await;
    assert_eq!(st, StatusCode::ACCEPTED, "{retry}");
    assert_eq!(retry["message"]["content"]["attachments"][0]["id"], a["id"]);
    s.wait_status(retry["turn"]["id"].as_str().unwrap(), "completed")
        .await;
    for req in f.requests() {
        let body = req["messages"].to_string();
        assert!(body.contains("Attached file:") && body.contains("long.txt") && body.contains("Excerpt only:"));
        assert!(!body.contains("UNSENT_TAIL"));
        let files = local_attachments(&req);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["name"], "long.txt");
        assert_eq!(files[0].as_object().unwrap().len(), 2);
        assert_eq!(
            files[0]["local_path"],
            grove::util::canonical(blob(&s, &a)).unwrap().to_str().unwrap(),
        );
    }
    let r = s
        .raw(
            Method::GET,
            &format!("/api/v1/attachments/{}/content", a["id"].as_str().unwrap()),
            None,
            None,
            None,
        )
        .await;
    assert_eq!(r.text().await.unwrap(), text, "원문은 발췌와 별개로 보존");
}

fn local_attachments(request: &Value) -> Vec<Value> {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "user")
        .flat_map(|message| {
            let content = &message["content"];
            if let Some(text) = content.as_str() {
                vec![text]
            } else {
                content
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|part| part["text"].as_str())
                    .collect()
            }
        })
        .flat_map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter_map(|value| value.as_array().cloned())
                .flatten()
                .filter(|value| value.get("local_path").is_some())
        })
        .collect()
}

#[tokio::test]
async fn binary_attachments_have_readable_paths_on_retry_restart_and_later_turns() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("binary-paths").await;
    let pid = p["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"].as_str().unwrap().to_owned();
    let video_bytes = b"\0\0\0\x18ftypisom\0\0\0\0isommp42VIDEO_FIXTURE";
    let document_bytes = b"%PDF-1.4\n\0PDF_FIXTURE";
    let video = upload(&s, pid, "화면 \"샘플\".mp4", video_bytes).await;
    let document = upload(&s, pid, "참고.pdf", document_bytes).await;
    let screenshot = upload(&s, pid, "screen.png", &png(2, 2)).await;
    let pending = upload(&s, pid, "미전송.mp4", b"\0PENDING_FIXTURE").await;
    assert!(video.get("local_path").is_none(), "서버 경로는 업로드 응답에 넣지 않는다");

    f.push(fixture::Step::Error(400, "fixture refusal".into()));
    let (status, accepted) = s.post(
        &format!("/api/v1/sessions/{sid}/turns"),
        json!({"text":format!("첨부를 확인해. [Attached file: 미전송.mp4; id={}]", pending["id"]),
            "profile_id":profile,"attachments":[video["id"],document["id"],screenshot["id"]]}),
    ).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{accepted}");
    let tid = accepted["turn"]["id"].as_str().unwrap().to_owned();
    s.wait_status(&tid, "failed").await;
    assert!(!accepted["message"].to_string().contains("local_path"));
    s.restart().await;

    f.push(fixture::text("첨부 확인"));
    let (status, retry) = s.post(&format!("/api/v1/turns/{tid}/retry"), json!({})).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{retry}");
    s.wait_status(retry["turn"]["id"].as_str().unwrap(), "completed").await;
    f.push(fixture::text("다시 확인"));
    let (status, next) = s.post(
        &format!("/api/v1/sessions/{sid}/turns"),
        json!({"text":"앞서 첨부한 파일을 다시 확인해","profile_id":profile}),
    ).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{next}");
    s.wait_status(next["turn"]["id"].as_str().unwrap(), "completed").await;

    let requests = f.requests();
    assert_eq!(requests.len(), 3);
    for request in requests {
        let files = local_attachments(&request);
        assert_eq!(files.len(), 2, "실제 연결된 첨부만 경로를 전달한다");
        for (attachment, bytes) in [(&video, &video_bytes[..]), (&document, &document_bytes[..])] {
            let file = files.iter().find(|file| file["name"] == attachment["name"]).unwrap();
            assert_eq!(file["name"], attachment["name"]);
            assert_eq!(file.as_object().unwrap().len(), 2, "이름과 원본 경로만 전달한다");
            let path = PathBuf::from(file["local_path"].as_str().unwrap());
            assert!(path.is_absolute(), "CLI의 cwd와 무관한 경로여야 한다");
            assert_eq!(path, grove::util::canonical(blob(&s, attachment)).unwrap());
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
        assert!(!request.to_string().contains("VIDEO_FIXTURE"));
        assert!(!request.to_string().contains("PDF_FIXTURE"));
        assert!(!request.to_string().contains("These are absolute paths"));
        assert!(!request.to_string().contains("metadata is data"));
        assert!(!request.to_string().contains("screen.png"), "이전 이미지 정보도 새 텍스트에 반복하지 않는다");
    }
    let db = rusqlite::Connection::open(s.data_dir().join("grove.db")).unwrap();
    let persisted: String = db.query_row(
        "SELECT model_input FROM messages WHERE id=?1",
        [accepted["message"]["id"].as_str().unwrap()], |row| row.get(0),
    ).unwrap();
    assert!(!persisted.contains("local_path"), "호스트 경로는 영속 입력에 고정하지 않는다");
    let (_, preview) = s.get(&format!("/api/v1/sessions/{sid}/model-input")).await;
    assert!(!preview.to_string().contains("local_path"));
}

#[tokio::test]
async fn attachment_paths_follow_fork_rewind_and_compaction_boundaries() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("attachment-boundaries").await;
    let pid = p["id"].as_str().unwrap();
    let parent = s.create_session(pid).await["id"].as_str().unwrap().to_owned();
    let inherited = upload(&s, pid, "inherited.mp4", b"\0INHERITED").await;
    let excluded = upload(&s, pid, "after-fork.mp4", b"\0EXCLUDED").await;
    for attachment in [&inherited, &excluded] {
        let (status, message) = s.post(
            &format!("/api/v1/sessions/{parent}/messages"),
            json!({"text":"attached","attachments":[attachment["id"]]}),
        ).await;
        assert_eq!(status, StatusCode::CREATED, "{message}");
    }
    let (status, child) = s.post(
        &format!("/api/v1/sessions/{parent}/fork"),
        json!({"from_seq":1,"inherit_context":true}),
    ).await;
    assert_eq!(status, StatusCode::CREATED, "{child}");
    let child = child["id"].as_str().unwrap();
    f.push(fixture::text("분기 첨부 확인"));
    let (status, turn) = s.post(
        &format!("/api/v1/sessions/{child}/turns"),
        json!({"text":"이전 첨부 확인","profile_id":profile}),
    ).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{turn}");
    s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
    let files = local_attachments(&f.requests()[0]);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0]["name"], inherited["name"]);
    assert!(!f.requests()[0].to_string().contains("after-fork.mp4"));

    // 압축 경계와 되감긴 메시지는 경로 조회를 위해 다시 살리지 않는다.
    let app = s.server.as_ref().unwrap().app.clone();
    let parent_id = parent.clone();
    app.db.call(move |c| {
        c.execute(
            "UPDATE messages SET rewound_at=?1 WHERE session_id=?2 AND seq=2",
            rusqlite::params!["2026-01-01T00:00:00Z", parent_id],
        )?;
        grove::sessions::append_message(
            c, "2026-01-01T00:00:00Z", &parent_id, "note",
            &json!({"type":"compaction","upto_seq":1,"summary":"첨부가 있었다"}), None, None,
        )?;
        Ok(())
    }).await.unwrap();
    // 제외된 원문이 없어도 경계 뒤의 모델 요청을 막으면 안 된다.
    std::fs::remove_file(blob(&s, &inherited)).unwrap();
    std::fs::remove_file(blob(&s, &excluded)).unwrap();
    f.push(fixture::text("새 context 확인"));
    let (status, turn) = s.post(
        &format!("/api/v1/sessions/{parent}/turns"),
        json!({"text":"새 요청","profile_id":profile}),
    ).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{turn}");
    s.wait_status(turn["turn"]["id"].as_str().unwrap(), "completed").await;
    assert!(local_attachments(&f.requests()[1]).is_empty());
    assert!(!f.requests()[1].to_string().contains("local_path"));
}

#[tokio::test]
async fn failed_commit_leaves_only_graced_orphan_and_staging_cleanup_is_owned() {
    let mut s = TestServer::start().await;
    let p = s.create_project("orphan").await;
    let pid = p["id"].as_str().unwrap();
    s.server.as_ref().unwrap().app.db.call(|c| {c.execute_batch("CREATE TRIGGER fail_upload BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT,'fixture'); END;")?;Ok(())}).await.unwrap();
    let bytes = b"uncommitted attachment";
    let (st, _) = s
        .post(
            &format!("/api/v1/projects/{pid}/attachments"),
            json!({"name":"orphan.txt","data_base64":STANDARD.encode(&bytes)}),
        )
        .await;
    assert_eq!(st, StatusCode::INTERNAL_SERVER_ERROR);
    let sha = grove::util::sha256_hex(bytes);
    let path = s
        .data_dir()
        .join("attachments/blobs")
        .join(&sha[..2])
        .join(&sha);
    assert!(path.is_file());
    gc(&s).await;
    assert!(path.is_file(), "새 원문을 즉시 삭제하지 않는다");
    age(&path);
    let temp = path.with_file_name(format!(".{sha}.grove-{}.tmp", grove::util::new_id()));
    let unrelated = path.with_file_name(format!(".{sha}.grove-not-owned.tmp"));
    let unicode = path.with_file_name("소유하지않은파일.txt");
    std::fs::write(&unicode, b"keep").unwrap();
    age(&unicode);
    std::fs::write(&temp, b"interrupted write").unwrap();
    age(&temp);
    std::fs::write(&unrelated, b"keep").unwrap();
    age(&unrelated);
    s.restart().await;
    for _ in 0..3 {
        gc(&s).await;
    }
    assert!(!path.exists() && !temp.exists());
    assert!(unrelated.is_file() && unicode.is_file());
}

#[tokio::test]
async fn gc_bounds_pending_expiry_keeps_references_and_marks_missing_after_restart() {
    let mut s = TestServer::start().await;
    let p = s.create_project("gc").await;
    let pid = p["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let attached = upload(&s, pid, "attached.txt", b"keep forever").await;
    s.post(
        &format!("/api/v1/sessions/{sid}/messages"),
        json!({"text":"keep","attachments":[attached["id"]]}),
    )
    .await;
    let pending = upload(&s, pid, "pending.txt", b"pending").await;
    let template = pending["id"].as_str().unwrap().to_owned();
    let app = s.server.as_ref().unwrap().app.clone();
    app.db.call(move |c|{
        let tx=c.transaction()?;
        for i in 0..300 {tx.execute("INSERT INTO attachments(id,project_id,owner_id,name,mime,size,sha256,storage_key,created_at) SELECT ?1,project_id,owner_id,name,mime,size,sha256,storage_key,'2000-01-01T00:00:00Z' FROM attachments WHERE id=?2",rusqlite::params![format!("pending-{i}"),template])?;}
        tx.execute("UPDATE attachments SET created_at='2000-01-01T00:00:00Z'",[])?;
        tx.commit()?;Ok(())
    }).await.unwrap();
    drop(app);
    age(&blob(&s, &attached));
    age(&blob(&s, &pending));
    let one = gc(&s).await;
    assert_eq!(
        one["attachments"]["unattached_expired"], 249,
        "참조 있는 1행도 250행 검사 상한에 포함한다"
    );
    assert!(blob(&s, &attached).is_file());
    s.restart().await;
    for _ in 0..4 {
        gc(&s).await;
    }
    assert!(!blob(&s, &pending).exists());
    assert_eq!(
        s.get(&format!(
            "/api/v1/attachments/{}",
            attached["id"].as_str().unwrap()
        ))
        .await
        .1["ref_count"],
        1
    );
    std::fs::remove_file(blob(&s, &attached)).unwrap();
    let result = gc(&s).await;
    assert_eq!(result["attachments"]["missing_marked"], 1);
    assert_eq!(
        s.get(&format!(
            "/api/v1/attachments/{}",
            attached["id"].as_str().unwrap()
        ))
        .await
        .1["stored"],
        false
    );
    assert_eq!(
        s.raw(
            Method::GET,
            &format!(
                "/api/v1/attachments/{}/content",
                attached["id"].as_str().unwrap()
            ),
            None,
            None,
            None
        )
        .await
        .status(),
        StatusCode::GONE
    );
}

#[tokio::test]
async fn reupload_repairs_missing_shared_original_without_rebinding_messages() {
    let s = TestServer::start().await;
    let p = s.create_project("repair").await;
    let pid = p["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let a = upload(&s, pid, "original.txt", b"recoverable original").await;
    s.post(
        &format!("/api/v1/sessions/{sid}/messages"),
        json!({"text":"keep","attachments":[a["id"]]}),
    )
    .await;
    std::fs::remove_file(blob(&s, &a)).unwrap();
    gc(&s).await;
    let url = format!("/api/v1/attachments/{}", a["id"].as_str().unwrap());
    assert_eq!(s.get(&url).await.1["stored"], false);
    upload(&s, pid, "replacement.txt", b"recoverable original").await;
    let (_, repaired) = s.get(&url).await;
    assert_eq!(repaired["stored"], true);
    assert_eq!(repaired["ref_count"], 1);
    let r = s
        .raw(Method::GET, &format!("{url}/content"), None, None, None)
        .await;
    assert_eq!(r.text().await.unwrap(), "recoverable original");
}

#[tokio::test]
async fn failed_reference_insert_rolls_back_message_sequence_and_events_then_delete_releases_reference()
 {
    let s = TestServer::start().await;
    let p = s.create_project("reference-transaction").await;
    let pid = p["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let a = upload(&s, pid, "note.txt", b"permanent original").await;
    let url = format!("/api/v1/sessions/{sid}");
    let app = s.server.as_ref().unwrap().app.clone();
    app.db.call(|c| {c.execute_batch("CREATE TRIGGER fail_ref BEFORE INSERT ON attachment_refs BEGIN SELECT RAISE(ABORT,'fixture'); END;")?;Ok(())}).await.unwrap();
    let (st, _) = s
        .post(
            &format!("{url}/messages"),
            json!({"text":"rollback","attachments":[a["id"]]}),
        )
        .await;
    assert_eq!(st, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(s.get(&url).await.1["last_message_seq"], 0);
    assert!(
        s.get(&format!("{url}/messages")).await.1["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        app.db
            .call(|c| Ok(c.query_row(
                "SELECT COUNT(*) FROM events WHERE kind='message.created'",
                [],
                |r| r.get::<_, i64>(0)
            )?))
            .await
            .unwrap(),
        0
    );
    app.db
        .call(|c| {
            c.execute_batch("DROP TRIGGER fail_ref;")?;
            Ok(())
        })
        .await
        .unwrap();
    let (st, _) = s
        .post(
            &format!("{url}/messages"),
            json!({"text":"keep","attachments":[a["id"]]}),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED);
    let session = s.get(&url).await.1;
    let (st, archived) = s
        .send(
            Method::PATCH,
            &url,
            json!({"expected_revision":session["revision"],"archived":true}),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{archived}");
    let (st, result) = s
        .send(
            Method::POST,
            &format!("{url}/delete"),
            json!({"expected_revision":archived["revision"],"confirm_title":archived["title"]}),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{result}");
    let attachment_url = format!("/api/v1/attachments/{}", a["id"].as_str().unwrap());
    assert_eq!(s.get(&attachment_url).await.1["ref_count"], 0);
    assert_eq!(
        s.send(Method::DELETE, &attachment_url, json!({})).await.0,
        StatusCode::OK
    );
    age(&blob(&s, &a));
    for _ in 0..3 {
        gc(&s).await;
    }
    assert!(!blob(&s, &a).exists());
    assert_eq!(
        app.db
            .call(|c| Ok(c.query_row(
                "SELECT COUNT(*) FROM pragma_foreign_key_check",
                [],
                |r| r.get::<_, i64>(0)
            )?))
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn message_total_size_limit_is_checked_before_any_reference_is_committed() {
    let s = TestServer::start().await;
    let p = s.create_project("message-size").await;
    let pid = p["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let bytes = vec![b'x'; grove::attachments::MAX_FILE_BYTES];
    let mut ids = vec![];
    for i in 0..4 {
        ids.push(
            upload(&s, pid, &format!("{i}.txt"), &bytes).await["id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    ids.push(
        upload(&s, pid, "extra.txt", b"x").await["id"]
            .as_str()
            .unwrap()
            .to_owned(),
    );
    let (st, _) = s
        .post(
            &format!("/api/v1/sessions/{sid}/messages"),
            json!({"text":"too big","attachments":ids}),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    for id in &ids {
        assert_eq!(
            s.get(&format!("/api/v1/attachments/{id}")).await.1["ref_count"],
            0
        );
    }
    assert_eq!(
        s.get(&format!("/api/v1/sessions/{sid}")).await.1["last_message_seq"],
        0
    );
    let (st, message) = s
        .post(
            &format!("/api/v1/sessions/{sid}/messages"),
            json!({"text":"maximum total","attachments":&ids[..4]}),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED, "{message}");
    for id in &ids[..4] {
        assert_eq!(
            s.get(&format!("/api/v1/attachments/{id}")).await.1["ref_count"],
            1
        );
    }
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let image = image::RgbaImage::from_pixel(width, height, image::Rgba([0, 0, 0, 0]));
    let mut bytes = std::io::Cursor::new(vec![]);
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

#[tokio::test]
async fn image_original_survives_restart_and_retry_sends_only_bounded_normalized_input() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("image").await;
    let pid = p["id"].as_str().unwrap().to_owned();
    let sid = s.create_session(&pid).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let bytes = png(2000, 1200);
    let a = upload(&s, &pid, "transparent.png", &bytes).await;
    assert_eq!(a["image"]["width"], 2000);
    assert_eq!(a["image"]["model_width"], 1024);
    assert_eq!(a["image"]["model_height"], 614);
    f.push(fixture::Step::Error(400, "fixture refusal".into()));
    let (st, v) = s
        .post(
            &format!("/api/v1/sessions/{sid}/turns"),
            json!({"text":"","profile_id":profile,"attachments":[a["id"]]}),
        )
        .await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    let tid = v["turn"]["id"].as_str().unwrap().to_owned();
    s.wait_status(&tid, "failed").await;
    s.restart().await;
    f.push(fixture::text("image fixture complete"));
    let (st, retry) = s
        .post(&format!("/api/v1/turns/{tid}/retry"), json!({}))
        .await;
    assert_eq!(st, StatusCode::ACCEPTED, "{retry}");
    s.wait_status(retry["turn"]["id"].as_str().unwrap(), "completed")
        .await;
    let requests = f.requests();
    assert_eq!(requests.len(), 2);
    for (index, req) in requests.into_iter().enumerate() {
        let parts = req["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "user")
            .last()
            .unwrap()["content"]
            .as_array()
            .unwrap();
        let data = parts
            .iter()
            .find_map(|v| v["image_url"]["url"].as_str())
            .unwrap()
            .strip_prefix("data:image/jpeg;base64,")
            .unwrap();
        let text = parts.iter().filter_map(|part| part["text"].as_str()).collect::<String>();
        if index == 0 { assert!(text.is_empty(), "이미지만 첨부한 첫 요청에는 안내 텍스트가 없다"); }
        // 재시도에는 이전 실패 기록이 붙을 수 있지만 첨부 안내는 다시 넣지 않는다.
        for metadata in ["Attached file:", "Local attachments:", "transparent.png", "local_path", "Image supplied separately"] {
            assert!(!text.contains(metadata), "이미지 메타데이터가 남아 있다: {metadata}");
        }
        let encoded = STANDARD.decode(data).unwrap();
        assert_ne!(encoded, bytes);
        let image = image::load_from_memory(&encoded).unwrap().to_rgb8();
        assert_eq!(image.dimensions(), (1024, 614));
        assert!(
            image.get_pixel(0, 0).0.iter().all(|v| *v > 250),
            "투명 배경은 흰색으로 합성한다"
        );
    }
    let r = s
        .raw(
            Method::GET,
            &format!("/api/v1/attachments/{}/content", a["id"].as_str().unwrap()),
            None,
            None,
            None,
        )
        .await;
    assert_eq!(r.bytes().await.unwrap().as_ref(), bytes);
    let app = s.server.as_ref().unwrap().app.clone();
    app.db
        .call(move |c| {
            let input: String = c.query_row(
                "SELECT model_input FROM messages WHERE role='user' ORDER BY seq LIMIT 1",
                [],
                |r| r.get(0),
            )?;
            let v: Value = serde_json::from_str(&input)?;
            assert_eq!(v["text"], "");
            assert!(v["images"][0]["id"].is_string());
            assert!(v["images"][0].get("data").is_none());
            Ok(())
        })
        .await
        .unwrap();
    // 저장 후 손상은 HTTP provider 호출 전에 거절한다.
    std::fs::write(blob(&s, &a), b"corrupt").unwrap();
    let (_, v) = s
        .post(
            &format!("/api/v1/sessions/{sid}/turns"),
            json!({"text":"look again","profile_id":profile}),
        )
        .await;
    let failed = s
        .wait_status(v["turn"]["id"].as_str().unwrap(), "failed")
        .await;
    assert_eq!(failed["error"]["code"], "gone");
    assert_eq!(f.requests().len(), 2);
}

#[tokio::test]
async fn malformed_and_excessive_image_dimensions_never_create_metadata() {
    let s = TestServer::start().await;
    let p = s.create_project("invalid-image").await;
    let pid = p["id"].as_str().unwrap();
    let tiny = upload(&s, pid, "tiny.png", &png(1, 1)).await;
    assert_eq!(
        tiny["image"]["model_width"], 1,
        "작은 이미지는 확대하지 않는다"
    );
    for bytes in [b"\x89PNG\r\n\x1a\ninvalid".to_vec(), png(8193, 1)] {
        let (st, v) = s
            .post(
                &format!("/api/v1/projects/{pid}/attachments"),
                json!({"name":"unsafe.png","data_base64":STANDARD.encode(bytes)}),
            )
            .await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{v}");
    }
    s.server
        .as_ref()
        .unwrap()
        .app
        .db
        .call(|c| {
            assert_eq!(
                c.query_row("SELECT COUNT(*) FROM attachments", [], |r| r
                    .get::<_, i64>(0))?,
                1
            );
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn image_parts_map_to_three_http_protocols_and_cli_is_explicitly_rejected() {
    use grove::provider::{self, ChatMsg, ImageInput, ModelRequest, Profile};
    let image = ImageInput {
        id: "fixture".into(),
        sha256: "0".repeat(64),
        width: 1,
        height: 1,
        mime: "image/jpeg".into(),
        data: "fixture-image-data".into(),
    };
    assert!(!format!("{image:?}").contains("fixture-image-data"));
    let req = ModelRequest {
        system: String::new(),
        messages: vec![ChatMsg::User {
            text: "look".into(),
            images: vec![image],
        }],
        tools: vec![],
        max_tokens: None,
        temperature: None,
        effort: None,
        cli: None,
    };
    let mut profile = Profile {
        protocol: "openai".into(),
        base_url: "http://127.0.0.1:1".into(),
        model: "fixture".into(),
        api_key: None,
        timeout: Duration::from_secs(1),
        extra_headers: vec![], sensitive_headers: vec![],
    };
    let openai = provider::openai::build_body(&profile, &req);
    assert_eq!(
        openai["messages"][0]["content"][1]["image_url"]["url"],
        "data:image/jpeg;base64,fixture-image-data"
    );
    let anthropic = provider::anthropic::build_body(&profile, &req);
    assert_eq!(
        anthropic["messages"][0]["content"][1]["source"],
        json!({"type":"base64","media_type":"image/jpeg","data":"fixture-image-data"})
    );
    let gemini = provider::gemini::build_body(&req);
    assert_eq!(
        gemini["contents"][0]["parts"][1]["inlineData"],
        json!({"mimeType":"image/jpeg","data":"fixture-image-data"})
    );
    profile.protocol = "codex_cli".into();
    let (_tx, mut cancel) = tokio::sync::watch::channel(false);
    let e = provider::stream(&profile, &req, &mut cancel, &mut |_| {})
        .await
        .unwrap_err();
    assert_eq!(e.code, "unsupported_image");
}

#[tokio::test]
async fn queued_attachments_survive_gc_restart_and_failed_start_without_losing_references() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("queued-files").await;
    let pid = p["id"].as_str().unwrap().to_owned();
    let sid = s.create_session(&pid).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    f.push(fixture::Step::Hang(vec![]));
    let (_, t) = s
        .post(
            &format!("/api/v1/sessions/{sid}/turns"),
            json!({"text":"wait","profile_id":profile}),
        )
        .await;
    let tid = t["turn"]["id"].as_str().unwrap();
    s.wait_status(tid, "running").await;
    let bytes = png(4, 2);
    let a = upload(&s, &pid, "queue.png", &bytes).await;
    let body = json!({"kind":"queue","text":"","profile_id":profile,"attachments":[a["id"]]});
    let url = format!("/api/v1/sessions/{sid}/followups");
    let r = s
        .raw(
            Method::POST,
            &url,
            Some(body.clone()),
            Some("queue-once"),
            None,
        )
        .await;
    assert_eq!(r.status(), StatusCode::CREATED);
    let queued: Value = r.json().await.unwrap();
    let fid = queued["followup"]["id"].as_str().unwrap().to_owned();
    let replay: Value = s
        .raw(Method::POST, &url, Some(body), Some("queue-once"), None)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(queued, replay);
    assert_eq!(
        s.get(&format!(
            "/api/v1/attachments/{}",
            a["id"].as_str().unwrap()
        ))
        .await
        .1["ref_count"],
        1
    );
    assert_eq!(
        s.raw(
            Method::DELETE,
            &format!("/api/v1/attachments/{}", a["id"].as_str().unwrap()),
            None,
            Some("referenced-delete"),
            None
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    s.server
        .as_ref()
        .unwrap()
        .app
        .db
        .call(|c| {
            c.execute(
                "UPDATE attachments SET created_at='2020-01-01T00:00:00Z'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    gc(&s).await;
    assert!(blob(&s, &a).is_file());
    s.post(&format!("/api/v1/turns/{tid}/cancel"), json!({}))
        .await;
    s.wait_status(tid, "cancelled").await;
    s.restart().await;
    std::fs::remove_file(blob(&s, &a)).unwrap();
    let (st, _) = s.post(&format!("{url}/{fid}/start"), json!({})).await;
    assert_eq!(st, StatusCode::GONE);
    let pending = s.get(&url).await.1;
    assert_eq!(pending["items"][0]["last_error"]["code"], "gone");
    assert_eq!(
        s.get(&format!(
            "/api/v1/attachments/{}",
            a["id"].as_str().unwrap()
        ))
        .await
        .1["ref_count"],
        1,
        "실패해도 대기열 참조는 남는다"
    );
    upload(&s, &pid, "repair.png", &bytes).await;
    f.push(fixture::text("queue image complete"));
    let (st, v) = s.post(&format!("{url}/{fid}/start"), json!({})).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    s.wait_status(v["turn_id"].as_str().unwrap(), "completed")
        .await;
    assert!(s.get(&url).await.1["items"].as_array().unwrap().is_empty());
    assert_eq!(
        s.get(&format!(
            "/api/v1/attachments/{}",
            a["id"].as_str().unwrap()
        ))
        .await
        .1["ref_count"],
        1
    );
    s.server
        .as_ref()
        .unwrap()
        .app
        .db
        .call(|c| {
            assert_eq!(
                c.query_row("SELECT COUNT(*) FROM followup_attachment_refs", [], |r| r
                    .get::<_, i64>(
                    0
                ))?,
                0
            );
            assert_eq!(
                c.query_row("SELECT COUNT(*) FROM attachment_refs", [], |r| r
                    .get::<_, i64>(0))?,
                1
            );
            assert_eq!(
                c.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r
                    .get::<_, i64>(
                    0
                ))?,
                0
            );
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn steer_transfers_attachment_after_tool_result_and_queue_deletion_releases_reference() {
    let s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("steer-files").await;
    let pid = p["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    f.push(fixture::tool_calls(&[(
        "write-fixture",
        "write",
        json!({"path":"steer.txt","content":"fixture"}),
    )]));
    f.push(fixture::text("steered"));
    let (_, t) = s
        .post(
            &format!("/api/v1/sessions/{sid}/turns"),
            json!({"text":"start","profile_id":profile,"tools":true}),
        )
        .await;
    let tid = t["turn"]["id"].as_str().unwrap();
    let awaiting = s.wait_status(tid, "awaiting_approval").await;
    let a = upload(&s, pid, "steer.txt", b"ATTACHED_STEER").await;
    let (st, steer) = s
        .post(
            &format!("/api/v1/sessions/{sid}/followups"),
            json!({"kind":"steer","text":"","profile_id":profile,"attachments":[a["id"]]}),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED, "{steer}");
    let q = upload(&s, pid, "removed.txt", b"not sent").await;
    let (_, queued) = s
        .post(
            &format!("/api/v1/sessions/{sid}/followups"),
            json!({"kind":"queue","text":"remove","profile_id":profile,"attachments":[q["id"]]}),
        )
        .await;
    assert_eq!(
        s.raw(
            Method::DELETE,
            &format!(
                "/api/v1/sessions/{sid}/followups/{}",
                queued["followup"]["id"].as_str().unwrap()
            ),
            None,
            None,
            None
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        s.get(&format!(
            "/api/v1/attachments/{}",
            q["id"].as_str().unwrap()
        ))
        .await
        .1["ref_count"],
        0
    );
    let broken = upload(&s, pid, "missing-steer.txt", b"MISSING_STEER").await;
    let (st, _) = s
        .post(
            &format!("/api/v1/sessions/{sid}/followups"),
            json!({"kind":"steer","text":"","profile_id":profile,"attachments":[broken["id"]]}),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED);
    std::fs::remove_file(blob(&s, &broken)).unwrap();
    let c = &awaiting["tool_calls"][0];
    s.post(
        &format!("/api/v1/tool-calls/{}/decision", c["id"].as_str().unwrap()),
        json!({"decision":"approve","expected_revision":c["revision"]}),
    )
    .await;
    s.wait_status(tid, "completed").await;
    let pending = s.get(&format!("/api/v1/sessions/{sid}/followups")).await.1;
    assert_eq!(pending["items"].as_array().unwrap().len(), 1);
    assert_eq!(pending["items"][0]["kind"], "queue");
    assert_eq!(pending["items"][0]["last_error"]["code"], "gone");
    assert_eq!(
        s.get(&format!(
            "/api/v1/attachments/{}",
            broken["id"].as_str().unwrap()
        ))
        .await
        .1["ref_count"],
        1
    );
    let requests = f.requests();
    assert!(!requests[1].to_string().contains("MISSING_STEER"));
    let messages = requests[1]["messages"].as_array().unwrap();
    let tool = messages.iter().position(|m| m["role"] == "tool").unwrap();
    let steer = messages
        .iter()
        .position(|m| {
            m["content"]
                .as_str()
                .is_some_and(|s| s.contains("ATTACHED_STEER"))
        })
        .unwrap();
    assert!(steer > tool);
    let history = s.get(&format!("/api/v1/sessions/{sid}/messages")).await.1;
    let message = history["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["content"]["source"]["kind"] == "steer")
        .unwrap();
    assert_eq!(message["content"]["attachments"][0]["id"], a["id"]);
    assert_eq!(
        s.get(&format!(
            "/api/v1/attachments/{}",
            a["id"].as_str().unwrap()
        ))
        .await
        .1["ref_count"],
        1
    );
}

#[tokio::test]
async fn compaction_sends_image_to_summary_but_retains_original_reference() {
    let mut s = TestServer::start().await;
    let f = Fixture::start().await;
    let profile = s.fixture_profile(&f.base).await;
    let p = s.create_project("image-context").await;
    let pid = p["id"].as_str().unwrap();
    let sid = s.create_session(pid).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let bytes = png(3, 2);
    let a = upload(&s, pid, "summary.png", &bytes).await;
    f.push(fixture::text("첫 이미지 답"));
    let (_, v) = s
        .post(
            &format!("/api/v1/sessions/{sid}/turns"),
            json!({"text":"이 이미지 설명","profile_id":profile,"attachments":[a["id"]]}),
        )
        .await;
    s.wait_status(v["turn"]["id"].as_str().unwrap(), "completed")
        .await;
    s.post(
        &format!("/api/v1/sessions/{sid}/messages"),
        json!({"text":"최근 글은 유지"}),
    )
    .await;
    f.push(fixture::text("이미지와 첫 응답의 fixture 요약"));
    let (st, summary) = s
        .post(
            &format!("/api/v1/sessions/{sid}/compact"),
            json!({"profile_id":profile}),
        )
        .await;
    assert_eq!(st, StatusCode::CREATED, "{summary}");
    let requests = f.requests();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].to_string().contains("data:image/jpeg;base64,"));
    let (_, input) = s.get(&format!("/api/v1/sessions/{sid}/model-input")).await;
    assert!(input.to_string().contains("fixture 요약"));
    assert!(input.to_string().contains("최근 글은 유지"));
    assert!(
        !input.to_string().contains("summary.png"),
        "압축된 구간의 이미지 입력은 요약으로 대체된다"
    );
    s.server
        .as_ref()
        .unwrap()
        .app
        .db
        .call(|c| {
            c.execute(
                "UPDATE attachments SET created_at='2020-01-01T00:00:00Z'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    gc(&s).await;
    s.restart().await;
    let r = s
        .raw(
            Method::GET,
            &format!("/api/v1/attachments/{}/content", a["id"].as_str().unwrap()),
            None,
            None,
            None,
        )
        .await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.bytes().await.unwrap().as_ref(), bytes);
    assert_eq!(
        s.get(&format!(
            "/api/v1/attachments/{}",
            a["id"].as_str().unwrap()
        ))
        .await
        .1["ref_count"],
        1
    );
}
