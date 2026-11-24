use super::*;
use crate::provider::{ChatMsg, ImageInput, cli::CliContext};
use std::time::Duration;

#[tokio::test]
async fn viewed_file_uri_is_captured_before_source_cleanup_and_replay() {
    let root = tempfile::tempdir().unwrap();
    let cwd = crate::util::canonical(root.path()).unwrap();
    let path = cwd.join("한글 preview.png");
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(3, 2).write_to(&mut png, image::ImageFormat::Png).unwrap();
    let bytes = png.into_inner();
    std::fs::write(&path, &bytes).unwrap();
    let item = json!({"type":"imageView","id":"view","path":reqwest::Url::from_file_path(&path).unwrap().as_str()});
    let mut state = State { cwd, thread:"thread".into(), turn:Some("turn".into()), ..State::default() };
    let mut writer = tokio::io::sink();
    notification(&mut writer, &json!({"method":"item/completed","params":{
        "threadId":"thread","turnId":"turn","item":item}}), &mut state, &mut |_| {}).await.unwrap();
    assert_eq!(state.output.generated_images.len(), 1);
    use base64::{Engine, engine::general_purpose::STANDARD};
    assert!(matches!(&state.output.generated_images[0].source,
        crate::provider::GeneratedImageSource::Base64(data) if STANDARD.decode(data).unwrap()==bytes));
    std::fs::remove_file(&path).unwrap();
    notification(&mut writer, &json!({"method":"turn/completed","params":{"threadId":"thread","turn":{
        "id":"turn","status":"completed","items":[item,{"type":"agentMessage","id":"answer","text":"검사 완료"}]}}}),
        &mut state, &mut |_| {}).await.unwrap();
    assert!(state.completed);
    assert_eq!(state.output.text, "검사 완료");
    assert_eq!(state.output.generated_images.len(), 1);
    let (app, _) = live_app(root.path());
    let data = app.cfg.data_dir.clone();
    let images = state.output.generated_images;
    app.db.call(move |c| {
        let result = crate::attachments::import_generated(c, &data, "2026-11-18T00:00:00Z", "live-project", &images)?;
        assert_eq!(result.items.len(), 1);
        Ok(())
    }).await.unwrap();
}

#[tokio::test]
async fn missing_view_preview_keeps_text_completion_but_required_image_stays_strict() {
    let root = tempfile::tempdir().unwrap();
    let cwd = crate::util::canonical(root.path()).unwrap();
    let item = json!({"type":"imageView","id":"missing","path":cwd.join("gone.png")});
    let mut state = State { cwd:cwd.clone(), thread:"thread".into(), turn:Some("turn".into()), ..State::default() };
    let mut writer = tokio::io::sink();
    notification(&mut writer, &json!({"method":"item/completed","params":{
        "threadId":"thread","turnId":"turn","item":item}}), &mut state, &mut |_| {}).await.unwrap();
    notification(&mut writer, &json!({"method":"turn/completed","params":{"threadId":"thread","turn":{
        "id":"turn","status":"completed","items":[item,{"type":"agentMessage","id":"answer","text":"작업 결과"}]}}}),
        &mut state, &mut |_| {}).await.unwrap();
    assert!(state.completed);
    assert_eq!(state.output.text, "작업 결과");
    assert!(state.output.generated_images.is_empty());
    assert_eq!(state.output.activity.iter().filter(|v| v["status"]=="failed").count(), 1);
    assert!(!serde_json::to_string(&state.output.activity).unwrap().contains("gone.png"));

    let data = root.path().join("data");
    let c = rusqlite::Connection::open_in_memory().unwrap();
    let required = crate::provider::GeneratedImage { id:"required".into(), source:crate::provider::GeneratedImageSource::File {
        root:cwd.clone(), path:cwd.join("gone.png"),
    }};
    assert_eq!(crate::attachments::import_generated(&c, &data, "now", "project", &[required]).err().unwrap().code, "gone");
}

#[test]
fn viewed_file_uri_keeps_project_boundary() {
    let root = tempfile::tempdir().unwrap();
    let cwd = crate::util::canonical(root.path()).unwrap();
    let path = cwd.join("한글 preview.png");
    let mut state = State { cwd:cwd.clone(), ..State::default() };
    state.item(&json!({"type":"imageView","id":"local","path":reqwest::Url::from_file_path(&path).unwrap().as_str()})).unwrap();
    assert!(matches!(&state.output.generated_images[0].source,
        crate::provider::GeneratedImageSource::File { root, path:actual } if root==&cwd && actual==&path));
    for path in ["file://remote/share/secret.png".to_string(), "https://example.invalid/image.png".to_string(),
        format!("file:{}/%2e%2e/secret.png",cwd.display()), format!("file:{}/preview.png?token=private",cwd.display())] {
        state.item(&json!({"type":"imageView","id":path,"path":path})).unwrap();
    }
    assert_eq!(state.output.generated_images.len(), 1);
}

#[test]
fn viewed_previews_do_not_exhaust_required_image_slots() {
    let root = tempfile::tempdir().unwrap();
    let mut state = State { cwd:crate::util::canonical(root.path()).unwrap(), ..State::default() };
    for index in 0..=crate::attachments::MAX_ATTACHMENTS {
        state.item(&json!({"type":"imageView","id":format!("view-{index}"),"path":format!("{index}.png")})).unwrap();
    }
    assert_eq!(state.output.generated_images.len(), crate::attachments::MAX_ATTACHMENTS);
    state.item(&json!({"type":"imageGeneration","id":"required","status":"completed","result":"aQ=="})).unwrap();
    assert_eq!(state.output.generated_images.len(), crate::attachments::MAX_ATTACHMENTS);
    assert!(state.output.generated_images.iter().any(|image| image.id=="required"));
}

#[cfg(unix)]
#[tokio::test]
async fn invalid_and_symlink_escape_previews_are_reported_without_importing_contents() {
    let root = tempfile::tempdir().unwrap();
    let cwd = crate::util::canonical(root.path()).unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    let escape = cwd.join("escape.png");
    std::os::unix::fs::symlink(outside.path(), &escape).unwrap();
    let bad = cwd.join("bad.png");
    std::fs::write(&bad, "not an image").unwrap();
    let mut state = State { cwd, thread:"thread".into(), turn:Some("turn".into()), ..State::default() };
    let mut writer = tokio::io::sink();
    for (id,path) in [("escape",escape),("invalid",bad)] {
        notification(&mut writer, &json!({"method":"item/completed","params":{
            "threadId":"thread","turnId":"turn","item":{"type":"imageView","id":id,"path":path}}}),
            &mut state, &mut |_| {}).await.unwrap();
    }
    assert!(state.output.generated_images.is_empty());
    assert_eq!(state.output.activity.len(), 2);
}

#[test]
fn context_usage_uses_latest_request_instead_of_billing_totals_and_can_shrink() {
    let mut state = State { thread: "thread".into(), turn: Some("turn".into()), usage_baseline: Some(Usage::default()), ..State::default() };
    let event = |thread, turn, tokens, window| json!({"method":"thread/tokenUsage/updated","params":{
        "threadId":thread,"turnId":turn,"tokenUsage":{
            "total":{"inputTokens":900_000,"outputTokens":100_000},
            "last":{"totalTokens":tokens},"modelContextWindow":window,
        }
    }});
    for (thread, turn) in [("foreign", "turn"), ("thread", "previous")] {
        state.notification(&event(thread, turn, 80_000, 100_000)).unwrap();
    }
    assert!(state.output.context_usage.is_none());
    state.notification(&event("thread", "turn", 25_000, 100_000)).unwrap();
    assert_eq!(state.output.context_usage, Some(ContextUsage { tokens:Some(25_000), context_window:Some(100_000) }));
    assert_eq!(state.output.usage.input_tokens, 900_000);
    // native 압축 이후에는 화면 이력이 길어도 점유량이 줄어들어야 한다.
    state.notification(&event("thread", "turn", 5_000, 100_000)).unwrap();
    assert_eq!(state.output.context_usage.as_ref().unwrap().tokens, Some(5_000));
    state.notification(&event("thread", "turn", 0, 0)).unwrap();
    assert_eq!(state.output.context_usage, Some(ContextUsage { tokens:Some(0), context_window:None }));
}

#[test]
fn tool_images_cache_location_follows_hook_configuration() {
    let root = tempfile::tempdir().unwrap();
    let home = crate::util::canonical(root.path()).unwrap();
    let configured = home.join("custom-cache");
    let home_ref = &home;
    let env = |value: std::ffi::OsString| move |key: &str| match key {
        "AGENTS_IMAGE_CACHE" => Some(value.clone()),
        "HOME" | "USERPROFILE" => Some(home_ref.clone().into_os_string()),
        _ => None,
    };
    assert_eq!(image_cache_root(env(configured.clone().into_os_string())), Some(configured));
    for invalid in [PathBuf::new(), PathBuf::from("relative"), home.join("../outside"), home.ancestors().last().unwrap().to_path_buf()] {
        assert_eq!(image_cache_root(env(invalid.into_os_string())), Some(home.join(".cache/agents/image-downscale")));
    }
    assert_eq!(image_cache_root(|_| None), None);
}

#[test]
fn tool_images_accept_all_supported_mime_types() {
    let mut state = State::default();
    for (index, mime) in ["image/png", "image/jpeg", "image/gif", "image/webp"].into_iter().enumerate() {
        for (kind, content) in [
            ("mcpToolCall", json!({"result":{"content":[{"type":"image","mimeType":mime,"data":"aQ=="}]}})),
            ("dynamicToolCall", json!({"contentItems":[{"type":"inputImage","imageUrl":format!("data:{mime};base64,aQ==")}]})),
        ] {
            let mut item = json!({"type":kind,"id":format!("{kind}-{index}"),"status":"completed","success":true});
            item.as_object_mut().unwrap().extend(content.as_object().unwrap().clone());
            state.item(&item).unwrap();
        }
    }
    assert_eq!(state.output.generated_images.len(), 8);
}

#[test]
fn tool_images_view_downscaled_cache_after_completion_and_snapshot() {
    let root = image_cache_root(|key| std::env::var_os(key)).unwrap();
    let path = root.join("preview.7ae25d0909099f54fba42874.png");
    let mut state = State { thread: "thread".into(), turn: Some("turn".into()), ..State::default() };
    let item = json!({"type":"imageView","id":"cache","path":path});
    for (method, thread, turn) in [("item/started", "thread", "turn"), ("item/completed", "foreign", "turn"), ("item/completed", "thread", "foreign")] {
        state.notification(&json!({"method":method,"params":{"threadId":thread,"turnId":turn,"item":item}})).unwrap();
    }
    assert!(state.output.generated_images.is_empty());
    state.notification(&json!({"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":item}})).unwrap();
    state.notification(&json!({"method":"turn/completed","params":{"threadId":"thread","turn":{
        "id":"turn","status":"completed","items":[item]}}})).unwrap();
    assert_eq!(state.output.generated_images.len(), 1, "축소 캐시도 답변 첨부로 수집한다");
    assert!(matches!(&state.output.generated_images[0].source,
        crate::provider::GeneratedImageSource::File { root:actual, path:actual_path } if actual == &root && actual_path == &path));
    for path in [root.join("../secret.png"), root.with_file_name("image-downscale-other").join("preview.png")] {
        state.item(&json!({"type":"imageView","id":"outside","path":path})).unwrap();
    }
    assert_eq!(state.output.generated_images.len(), 1);
    assert!(state.output.text.is_empty());
}

#[test]
fn tool_images_collect_completed_results_without_final_markdown_and_ignore_replay() {
    let mut state = State { thread: "thread".into(), turn: Some("turn".into()), ..State::default() };
    let items = [
        json!({"type":"mcpToolCall","id":"mcp","tool":"render","status":"completed",
            "result":{"content":[{"type":"text","text":"/private.png"},
                {"type":"image","mimeType":"image/jpeg","data":"aW1hZ2U="}]}}),
        json!({"type":"dynamicToolCall","id":"dynamic","tool":"exec","status":"completed","success":true,
            "contentItems":[{"type":"inputImage","imageUrl":"data:image/webp;base64,aW1hZ2U="},
                {"type":"inputImage","imageUrl":"https://example.invalid/private.png"}]}),
    ];
    for item in &items {
        for (thread, turn) in [("foreign", "turn"), ("thread", "foreign")] {
            state.notification(&json!({"method":"item/completed","params":{"threadId":thread,"turnId":turn,"item":item}})).unwrap();
        }
    }
    assert!(state.output.generated_images.is_empty());
    for item in &items {
        let mut pending = item.clone();
        pending["status"] = json!("inProgress");
        state.item(&pending).unwrap();
        let mut failed = item.clone();
        failed["status"] = json!("failed");
        state.item(&failed).unwrap();
    }
    assert!(state.output.generated_images.is_empty());
    for item in &items {
        state.notification(&json!({"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":item}})).unwrap();
    }
    assert_eq!(state.output.generated_images.len(), 2);
    state.notification(&json!({"method":"turn/completed","params":{"threadId":"thread","turn":{
        "id":"turn","status":"completed","items":items}}})).unwrap();
    assert_eq!(state.output.generated_images.len(), 2);
    assert!(state.output.text.is_empty(), "이미지만 있는 결과도 답변 첨부로 전달한다");
    assert!(state.output.generated_images.iter().all(|image| matches!(
        &image.source, crate::provider::GeneratedImageSource::Base64(value) if value == "aW1hZ2U=")));
}

#[test]
fn tool_images_view_previous_generated_files_only_after_completion() {
    let home = std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(||
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(|home| PathBuf::from(home).join(".codex"))).unwrap();
    let root = home.join("generated_images");
    let path = root.join("previous-thread").join("preview.png");
    let mut state = State { thread: "thread".into(), turn: Some("turn".into()), ..State::default() };
    let item = json!({"type":"imageView","id":"view","path":path});
    let event = |method, item| json!({"method":method,"params":{"threadId":"thread","turnId":"turn","item":item}});
    state.notification(&event("item/started", item.clone())).unwrap();
    assert!(state.output.generated_images.is_empty());
    state.notification(&event("item/completed", item.clone())).unwrap();
    state.notification(&event("item/completed", item)).unwrap();
    assert_eq!(state.output.generated_images.len(), 1);
    assert!(matches!(&state.output.generated_images[0].source,
        crate::provider::GeneratedImageSource::File { root:actual, path:actual_path } if actual == &root && actual_path == &path));
    for path in [root.join("../secret.png"), root.with_file_name("generated_images-other").join("preview.png")] {
        state.item(&json!({"type":"imageView","id":"outside","path":path})).unwrap();
    }
    assert_eq!(state.output.generated_images.len(), 1);
}

#[test]
fn tool_images_keep_project_file_boundary_and_output_limits() {
    let root = tempfile::tempdir().unwrap();
    let cwd = crate::util::canonical(root.path()).unwrap();
    let mut state = State { cwd: cwd.clone(), ..State::default() };
    state.item(&json!({"type":"imageView","id":"local","path":"preview.png"})).unwrap();
    assert!(matches!(&state.output.generated_images[0].source,
        crate::provider::GeneratedImageSource::File { root, path } if root == &cwd && path == &cwd.join("preview.png")));
    state.item(&json!({"type":"imageView","id":"escape","path":"../outside.png"})).unwrap();
    for extra in [json!({"success":false}), json!({"error":{"message":"failed"}}), json!({"result":{"isError":true,
        "content":[{"type":"image","mimeType":"image/png","data":"aQ=="}]}})] {
        let mut item = json!({"type":"mcpToolCall","id":"failed","status":"completed",
            "result":{"content":[{"type":"image","mimeType":"image/png","data":"aQ=="}]}});
        item.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        state.item(&item).unwrap();
    }
    assert_eq!(state.output.generated_images.len(), 1);
    let content = vec![json!({"type":"image","mimeType":"image/png","data":"aQ=="}); crate::attachments::MAX_ATTACHMENTS + 1];
    assert_eq!(state.item(&json!({"type":"mcpToolCall","id":"many","status":"completed","result":{"content":content}}))
        .unwrap_err().code, "output_too_large");
}

#[test]
fn generated_images_collect_only_completed_current_turn_outputs_once() {
    use crate::provider::GeneratedImageSource;
    let mut state = State { thread: "thread".into(), turn: Some("turn".into()), ..State::default() };
    let event = |thread, turn, item| json!({"method":"item/completed", "params":{"threadId":thread,"turnId":turn,"item":item}});
    let image = json!({"type":"imageGeneration","id":"image","status":"completed","result":"aW1hZ2U="});
    state.notification(&event("foreign", "turn", image.clone())).unwrap();
    state.notification(&event("thread", "foreign", image.clone())).unwrap();
    state.item(&json!({"type":"imageGeneration","id":"pending","status":"in_progress"})).unwrap();
    // 허용된 이미지 위치 밖의 임의 파일은 가져오지 않는다.
    state.item(&json!({"type":"imageView","id":"view","path":"/private.png"})).unwrap();
    assert!(state.output.generated_images.is_empty());
    state.notification(&event("thread", "turn", image.clone())).unwrap();
    state.notification(&json!({"method":"turn/completed","params":{"threadId":"thread", "turn":{
        "id":"turn","status":"completed","items":[image]}}})).unwrap();
    assert_eq!(state.output.generated_images.len(), 1);
    assert!(matches!(&state.output.generated_images[0].source, GeneratedImageSource::Base64(value) if value == "aW1hZ2U="));
    assert!(!format!("{:?}", state.output).contains("aW1hZ2U="));
}

#[test]
fn generated_images_reject_unavailable_or_outside_paths_and_excess_outputs() {
    let mut state = State { thread: "thread".into(), ..State::default() };
    for extra in [json!({"fileId":"opaque"}), json!({"savedPath":"/outside/secret.png"})] {
        let mut item = json!({"type":"imageGeneration","id":"bad","status":"completed"});
        item.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        assert_eq!(state.item(&item).unwrap_err().code, "image_output_unavailable");
    }
    for index in 0..crate::attachments::MAX_ATTACHMENTS {
        state.item(&json!({"type":"imageGeneration","id":index.to_string(),"status":"completed","result":"aQ=="})).unwrap();
    }
    assert_eq!(state.item(&json!({"type":"imageGeneration","id":"overflow","status":"completed","result":"aQ=="})).unwrap_err().code, "output_too_large");
}

#[test]
fn generated_images_file_outputs_are_scoped_to_the_native_thread() {
    let home = std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(||
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(|home| PathBuf::from(home).join(".codex"))).unwrap();
    let root = home.join("generated_images");
    let path = root.join("thread").join("image.png");
    let mut state = State { thread: "thread".into(), ..State::default() };
    state.item(&json!({"type":"imageGeneration","id":"local","status":"completed","result":"","fileId":"image-id","savedPath":reqwest::Url::from_file_path(&path).unwrap().as_str()})).unwrap();
    assert!(matches!(&state.output.generated_images[0].source,
        crate::provider::GeneratedImageSource::File { root:actual, path:actual_path } if actual == &root && actual_path == &path));
    for path in [root.join("other-thread/image.png"), root.join("thread/../secret.png")] {
        assert_eq!(state.item(&json!({"type":"imageGeneration","id":"bad","status":"completed","savedPath":path})).unwrap_err().code,
            "image_output_unavailable");
    }
}

#[tokio::test]
async fn generated_images_receive_events_larger_than_text_line_limit() {
    let root = tempfile::tempdir().unwrap();
    let event = json!({"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{
        "id":"image","type":"imageGeneration","status":"completed","result":"x".repeat(super::super::MAX_LINE_BYTES + 1)}}});
    let mut bytes = serde_json::to_vec(&event).unwrap();
    bytes.push(b'\n');
    let mut reader = BufReader::new(bytes.as_slice());
    let received = receive(&mut reader, &profile(), &request(root.path(), None, "image"), Default::default()).await.unwrap();
    let mut state = State { thread: "thread".into(), turn: Some("turn".into()), ..State::default() };
    state.notification(&received).unwrap();
    assert_eq!(state.output.generated_images.len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn generated_images_import_bind_preserve_originals_and_reject_symlink_escape() {
    use crate::provider::{GeneratedImage, GeneratedImageSource};
    use base64::{Engine, engine::general_purpose::STANDARD};
    let root = tempfile::tempdir().unwrap();
    let (app, _) = live_app(root.path());
    let mut encoded = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(3, 2).write_to(&mut encoded, image::ImageFormat::Png).unwrap();
    let bytes = encoded.into_inner();
    let originals = root.path().join("generated_images");
    std::fs::create_dir(&originals).unwrap();
    let path = originals.join("image.png");
    std::fs::write(&path, &bytes).unwrap();
    let images = vec![
        GeneratedImage { id:"inline".into(), source:GeneratedImageSource::Base64(STANDARD.encode(&bytes)) },
        GeneratedImage { id:"file".into(), source:GeneratedImageSource::File { root:originals.clone(), path:path.clone() } },
    ];
    let data = app.cfg.data_dir.clone();
    let now = app.now();
    let (id, sha) = app.db.call(move |c| {
        let tx = c.transaction()?;
        let prepared = crate::attachments::import_generated(&tx, &data, &now, "live-project", &images)?;
        assert_eq!(prepared.items.len(), 1, "같은 이미지 원문은 중복 첨부하지 않는다");
        let content = json!({"text":"시안", "attachments":prepared.items});
        assert!(!content.to_string().contains("generated_images"));
        let message = crate::sessions::append_message(&tx, &now, "live-session", "assistant", &content, None, None)?;
        crate::attachments::bind(&tx, &now, &message.id, &prepared)?;
        let id = prepared.items[0]["id"].as_str().unwrap().to_string();
        let sha = prepared.items[0]["sha256"].as_str().unwrap().to_string();
        assert_eq!(tx.query_row("SELECT COUNT(*) FROM attachment_refs WHERE attachment_id=?1", [&id], |r| r.get::<_,i64>(0))?, 1);
        tx.commit()?;
        Ok((id, sha))
    }).await.unwrap();
    assert!(!id.is_empty());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(std::fs::read(crate::attachments::blob_path(&app.cfg.data_dir, &sha)).unwrap(), bytes);
    let outside = root.path().join("outside.png");
    std::fs::write(&outside, &bytes).unwrap();
    let escape = originals.join("escape.png");
    std::os::unix::fs::symlink(&outside, &escape).unwrap();
    let data = app.cfg.data_dir.clone();
    let now = app.now();
    app.db.call(move |c| {
        for source in [GeneratedImageSource::File { root:originals, path:escape }, GeneratedImageSource::Base64(STANDARD.encode("not an image"))] {
            let tx = c.transaction()?;
            let result = crate::attachments::import_generated(&tx, &data, &now, "live-project", &[GeneratedImage { id:"bad".into(), source }]);
            assert!(result.is_err());
        }
        Ok(())
    }).await.unwrap();
}

#[tokio::test]
async fn generated_images_import_preserves_static_and_animated_formats() {
    use crate::provider::{GeneratedImage, GeneratedImageSource};
    use base64::{Engine, engine::general_purpose::STANDARD};
    use image::AnimationDecoder;
    let root = tempfile::tempdir().unwrap();
    let (app, _) = live_app(root.path());
    let cache = root.path().join("image-downscale");
    std::fs::create_dir(&cache).unwrap();
    let mut formats = Vec::new();
    for (ext, mime, format) in [("png", "image/png", image::ImageFormat::Png), ("jpg", "image/jpeg", image::ImageFormat::Jpeg)] {
        let mut encoded = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(8, 4).write_to(&mut encoded, format).unwrap();
        formats.push((ext, mime, encoded.into_inner()));
    }
    let gif = include_bytes!("../../../tests/fixtures/images/animated.gif");
    let webp = include_bytes!("../../../tests/fixtures/images/animated.webp");
    assert_eq!(image::codecs::gif::GifDecoder::new(std::io::Cursor::new(gif)).unwrap().into_frames().count(), 2);
    assert_eq!(image::codecs::webp::WebPDecoder::new(std::io::Cursor::new(webp)).unwrap().into_frames().count(), 2);
    formats.extend([("gif", "image/gif", gif.to_vec()), ("webp", "image/webp", webp.to_vec())]);
    for (ext, mime, bytes) in formats {
        let path = cache.join(format!("preview.{ext}"));
        std::fs::write(&path, &bytes).unwrap();
        let encoded = STANDARD.encode(&bytes);
        let images = vec![
            GeneratedImage { id:"inline".into(), source:GeneratedImageSource::Base64(encoded.clone()) },
            GeneratedImage { id:"data-url".into(), source:GeneratedImageSource::Base64(format!("data:{mime};base64,{encoded}")) },
            GeneratedImage { id:"cache".into(), source:GeneratedImageSource::File { root:cache.clone(), path:path.clone() } },
        ];
        let data = app.cfg.data_dir.clone();
        let now = app.now();
        let expected = bytes.clone();
        app.db.call(move |c| {
            let tx = c.transaction()?;
            let prepared = crate::attachments::import_generated(&tx, &data, &now, "live-project", &images)?;
            assert_eq!(prepared.items.len(), 1, "파일·base64·data URL의 같은 원문은 한 번만 첨부한다");
            let item = &prepared.items[0];
            assert_eq!(item["mime"], mime);
            assert_eq!(item["name"], format!("generated-1.{ext}"));
            assert_eq!(std::fs::read(crate::attachments::blob_path(&data, item["sha256"].as_str().unwrap())).unwrap(), expected,
                "움짤을 첫 프레임으로 바꾸지 않고 원문을 저장한다");
            Ok(())
        }).await.unwrap();
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn resumed_thread_usage_counts_only_this_turn_and_ignores_duplicate_updates() {
    let mut state = State { thread: "thread".into(), ..State::default() };
    let usage = |turn: &str, input, output, cache| json!({"method":"thread/tokenUsage/updated", "params": {
        "threadId":"thread", "turnId":turn, "tokenUsage":{"total":{"inputTokens":input,"outputTokens":output,"cachedInputTokens":cache}}
    }});
    state.notification(&usage("previous-turn", 1000, 100, 600)).unwrap();
    state.notification(&json!({"method":"turn/started","params":{"threadId":"thread","turn":{"id":"new-turn"}}})).unwrap();
    state.notification(&usage("new-turn", 1100, 110, 660)).unwrap();
    state.notification(&usage("new-turn", 1250, 130, 800)).unwrap();
    state.notification(&usage("new-turn", 1250, 130, 800)).unwrap();
    state.notification(&usage("foreign-turn", 9000, 900, 900)).unwrap();
    assert_eq!((state.output.usage.input_tokens, state.output.usage.output_tokens, state.output.usage.cache_read_tokens), (250, 30, 200));
    assert_eq!(state.output.usage.cache_write_tokens, None);
}

fn profile() -> Profile {
    Profile {
        protocol: "codex_cli".into(),
        model: "fixture-model".into(),
        base_url: String::new(),
        api_key: None,
        timeout: Duration::from_secs(3),
        extra_headers: vec![],
        sensitive_headers: vec![],
    }
}

fn request(root: &std::path::Path, resume: Option<&str>, text: &str) -> ModelRequest {
    ModelRequest {
        system: "system fixture".into(),
        messages: vec![
            ChatMsg::User {
                text: "previous user".into(),
                images: vec![],
            },
            ChatMsg::Assistant {
                text: "previous assistant".into(),
                tool_calls: vec![],
                native: None,
            },
            ChatMsg::User {
                text: text.into(),
                images: vec![],
            },
        ],
        tools: vec![],
        max_tokens: None,
        temperature: None,
        effort: Some("xhigh".into()),
        cli: Some(CliContext {
            cwd: root.into(),
            resume: resume.map(String::from),
            service_tier: Some("priority".into()),
            ..Default::default()
        }),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn native_skill_selection_is_revalidated_and_sent_as_structured_input() {
    let root = tempfile::tempdir().unwrap();
    let skills = json!([{"name":"review","description":"Review","path":root.path().join("SKILL.md"),"scope":"repo","enabled":true}]);
    std::fs::write(root.path().join("native-skills.json"), skills.to_string()).unwrap();
    let response = json!({"data":[{"cwd":root.path(),"skills":skills,"errors":[]}]});
    let selected = super::super::commands::decode("codex_cli", root.path(), &response).unwrap().commands.remove(0);
    let mut req = request(root.path(), None, "/review file.rs");
    req.cli.as_mut().unwrap().native_command = Some(selected.info.id);
    super::super::stream_with(&profile(), &req, &mut |_| {}, Some(&fixture(root.path()))).await.unwrap();
    let messages = wire(root.path());
    let turn = messages.iter().find(|message| message["method"] == "turn/start").unwrap();
    let input = turn["params"]["input"].as_array().unwrap();
    assert!(input[0]["text"].as_str().unwrap().ends_with("$review file.rs"));
    assert_eq!(input[1], json!({"type":"skill","name":"review","path":root.path().join("SKILL.md")}));
    assert!(input[0]["text"].as_str().unwrap().contains("previous user"));
    std::fs::write(root.path().join("native-skills.json"), "[]").unwrap();
    std::fs::write(root.path().join("wire.jsonl"), "").unwrap();
    let error = super::super::stream_with(&profile(), &req, &mut |_| {}, Some(&fixture(root.path()))).await.unwrap_err();
    assert_eq!(error.code, "native_command_changed");
    assert!(wire(root.path()).iter().all(|message| message["method"] != "thread/start" && message["method"] != "turn/start"));
}

#[cfg(unix)]
fn fixture(root: &std::path::Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let file = root.join("fake-codex");
    std::fs::write(
        &file,
        include_str!("../../../tests/fixtures/codex_app_server.py"),
    )
    .unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
    file
}

#[cfg(unix)]
fn wire(root: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(root.join("wire.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[cfg(unix)]
pub(crate) fn live_app(root: &std::path::Path) -> (crate::App, String) {
    let cfg = crate::config::Config {
        data_dir: root.join("data"), listen: "127.0.0.1:0".parse().unwrap(),
        allowed_origins: vec![], allowed_hosts: vec![], tls_terminated: false, web_dir: None, web_base: "/".into(),
        approval_ttl_secs: 1800, scheduler_tick_ms: 100,
        remote_watch_insecure_loopback: false, gh_command: "gh".into(), release_mirror: None, internal_exe: None,
    };
    std::fs::create_dir_all(&cfg.data_dir).unwrap();
    let app = crate::App::new(cfg, std::sync::Arc::new(crate::util::SystemClock)).unwrap();
    let (now, epoch, cwd) = (app.now(), app.epoch.clone(), root.to_string_lossy().to_string());
    let tid = app.db.call_sync(move |c| {
        c.execute("INSERT INTO projects(id,name,root_path,created_at,updated_at) VALUES('live-project','fixture',?1,?2,?2)", rusqlite::params![cwd, now])?;
        c.execute("INSERT INTO sessions(id,project_id,title,created_at,updated_at) VALUES('live-session','live-project','fixture',?1,?1)", [&now])?;
        c.execute("INSERT INTO model_profiles(id,name,protocol,base_url,model,created_at,updated_at) VALUES('live-profile','fixture','codex_cli','','fixture-model',?1,?1)", [&now])?;
        let (t, _) = crate::runner::enqueue_with_attachments(c, &now, &epoch, "token:fixture-owner", "live-session", "fixture", "live-profile", None, Some(false), None, None)?;
        c.execute("UPDATE turns SET status='running' WHERE id=?1", [&t.id])?;
        Ok(t.id)
    }).unwrap();
    (app, tid)
}

#[cfg(unix)]
pub(crate) async fn live_followup(app: &crate::App, id: &str, text: &str) {
    let (id, text, now) = (id.to_string(), text.to_string(), app.now());
    app.db.call(move |c| {
        c.execute("INSERT INTO followups(id,session_id,kind,text,profile_id,owner_key,created_at) VALUES(?1,'live-session','steer',?2,'live-profile','token:fixture-owner',?3)",
            rusqlite::params![id, text, now])?;
        crate::events::append(c, &now, "followups.changed", Some("live-project"), Some("live-session"), &json!({"items":crate::followups::list(c,"live-session")?}))?;
        Ok(())
    }).await.unwrap();
    app.notify_events().await;
}

#[cfg(unix)]
#[tokio::test]
async fn live_steers_reach_active_native_turn_once_in_order_without_losing_partial_json() {
    let dir = tempfile::tempdir().unwrap();
    let (app, tid) = live_app(dir.path());
    let mut req = request(dir.path(), None, "LIVE_STEER_TWO");
    req.cli.as_mut().unwrap().steers = Some(crate::followups::live::LiveSteers::new(&app, &tid));
    let (ready, running) = tokio::sync::oneshot::channel();
    let mut ready = Some(ready);
    let executable = fixture(dir.path());
    let task = tokio::spawn(async move {
        super::super::stream_with(&profile(), &req, &mut |out| {
            if !out.text.is_empty() && let Some(ready) = ready.take() { let _ = ready.send(()); }
        }, Some(&executable)).await
    });
    running.await.unwrap();
    live_followup(&app, "live-first", "first addition").await;
    live_followup(&app, "live-second", "second addition").await;
    let out = task.await.unwrap().unwrap();
    assert_eq!(out.text, "첫 조각");
    assert_eq!(out.response_steers, [("live-first".into(), 1), ("live-second".into(), 1)]);
    let requests = wire(dir.path());
    let delivered: Vec<_> = requests.iter().filter(|v| v["method"]=="turn/steer").collect();
    assert_eq!(delivered.len(), 2);
    assert_eq!(delivered[0]["params"]["input"][0]["text"], "first addition");
    assert_eq!(delivered[1]["params"]["input"][0]["text"], "second addition");
    assert_eq!(requests.iter().filter(|v| v["method"]=="turn/start").count(), 1);
    app.db.call(move |c| {
        assert!(crate::followups::list(c,"live-session")?.is_empty());
        let count: i64 = c.query_row("SELECT COUNT(*) FROM messages WHERE turn_id=?1 AND json_extract(content,'$.source.kind')='steer'", [&tid], |r| r.get(0))?;
        assert_eq!(count, 2);
        Ok(())
    }).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn native_steer_refusal_stays_visible_and_is_not_replayed_at_the_next_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let (app, tid) = live_app(dir.path());
    let mut req = request(dir.path(), None, "LIVE_STEER_REJECT");
    req.cli.as_mut().unwrap().steers = Some(crate::followups::live::LiveSteers::new(&app, &tid));
    live_followup(&app, "live-rejected", "rejected addition").await;
    super::super::stream_with(&profile(), &req, &mut |_| {}, Some(&fixture(dir.path()))).await.unwrap();
    let data = app.cfg.data_dir.clone();
    app.db.call(move |c| {
        let items = crate::followups::list(c,"live-session")?;
        assert_eq!(items[0].delivery_state, "rejected");
        assert_eq!(items[0].last_error.as_ref().unwrap()["code"], "steer_rejected");
        assert!(!items[0].last_error.as_ref().unwrap().to_string().contains("private fixture refusal"));
        assert_eq!(crate::followups::apply_steers(c, "2026-01-01T00:00:00Z", &tid, &data)?, 0);
        Ok(())
    }).await.unwrap();
    assert_eq!(wire(dir.path()).iter().filter(|v| v["method"]=="turn/steer").count(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn lost_native_steer_ack_is_unknown_after_restart_and_never_automatically_sent_again() {
    let dir = tempfile::tempdir().unwrap();
    let (app, tid) = live_app(dir.path());
    let mut req = request(dir.path(), None, "LIVE_STEER_LOST");
    req.cli.as_mut().unwrap().steers = Some(crate::followups::live::LiveSteers::new(&app, &tid));
    live_followup(&app, "live-unknown", "uncertain addition").await;
    let error = super::super::stream_with(&profile(), &req, &mut |_| {}, Some(&fixture(dir.path()))).await.unwrap_err();
    assert_eq!(error.code, "cli_exited");
    let tid2 = tid.clone();
    app.db.call(move |c| {
        assert_eq!(crate::followups::list(c,"live-session")?[0].delivery_state, "sending");
        c.execute("UPDATE turns SET owner_epoch='previous-process' WHERE id=?1", [tid2])?;
        Ok(())
    }).await.unwrap();
    crate::runner::recover_on_start(&app).await.unwrap();
    crate::followups::after_turn(&app, &tid).await;
    app.db.call(|c| {
        let items = crate::followups::list(c,"live-session")?;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].delivery_state, "unknown");
        assert_eq!(items[0].last_error.as_ref().unwrap()["code"], "steer_delivery_unknown");
        assert_eq!(c.query_row("SELECT COUNT(*) FROM turns", [], |r| r.get::<_, i64>(0))?, 1);
        Ok(())
    }).await.unwrap();
    assert_eq!(wire(dir.path()).iter().filter(|v| v["method"]=="turn/steer").count(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn real_process_streams_deltas_before_completion_and_preserves_resume_settings_and_images() {
    use base64::Engine;
    for resume in [None, Some("existing-exec-thread"), Some("no-usage-replay")] {
        let dir = tempfile::tempdir().unwrap();
        let mut req = request(dir.path(), resume, "current user");
        let mut image = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut image, image::ImageFormat::Png)
            .unwrap();
        let data = image.into_inner();
        let image = ImageInput {
            id: "image".into(),
            sha256: crate::util::sha256_hex(&data),
            width: 2,
            height: 2,
            mime: "image/png".into(),
            data: base64::engine::general_purpose::STANDARD.encode(data),
        };
        if let ChatMsg::User { images, .. } = &mut req.messages[0] {
            images.push(image.clone());
        }
        if let ChatMsg::User { images, .. } = req.messages.last_mut().unwrap() {
            images.push(image);
        }
        let mut snapshots = Vec::new();
        let output = super::super::stream_with(
            &profile(),
            &req,
            &mut |out| snapshots.push(out.clone()),
            Some(&fixture(dir.path())),
        )
        .await
        .unwrap();
        assert!(
            snapshots
                .iter()
                .any(|out| out.text == "첫" && out.finish_reason.is_empty())
        );
        assert!(
            snapshots
                .iter()
                .any(|out| out.text == "첫 답\n\n최종" && out.finish_reason.is_empty())
        );
        assert_eq!(output.text, "첫 답\n\n최종 답");
        assert_eq!(output.response_parts, ["첫 답", "최종 답"]);
        assert_eq!(output.reasoning, "요약");
        assert_eq!(
            output.native_session.as_deref(),
            Some(resume.unwrap_or("thread-new"))
        );
        assert!(
            output.tool_calls.is_empty(),
            "native 도구를 Grove가 다시 실행하지 않는다"
        );
        assert_eq!(output.activity.len(), 1);
        assert_eq!(output.activity[0]["status"], "completed");
        assert!(snapshots.iter().any(|out| {
            out.activity
                .first()
                .is_some_and(|item| item["status"] == "in_progress")
        }));
        assert_eq!(
            (
                output.usage.input_tokens,
                output.usage.output_tokens,
                output.usage.cache_read_tokens
            ),
            (100, 5, 60)
        );
        assert_eq!(output.usage.reasoning_tokens, Some(3));
        assert_eq!(json!(output.usage)["message_generation"], json!({"output_tokens":2,"duration_ms":750}));
        assert_eq!(output.usage.cache_write_tokens, Some(2));
        assert_eq!(output.finish_reason, "stop");
        let wire = wire(dir.path());
        assert_eq!(
            wire.iter()
                .filter_map(|row| row["method"].as_str())
                .collect::<Vec<_>>(),
            [
                "initialize",
                "initialized",
                if resume.is_some() {
                    "thread/resume"
                } else {
                    "thread/start"
                },
                "turn/start"
            ]
        );
        let thread = &wire[2]["params"];
        assert_eq!(thread["approvalPolicy"], "never");
        assert_eq!(thread["sandbox"], "danger-full-access");
        assert_eq!(thread["model"], "fixture-model");
        assert_eq!(thread["serviceTier"], "priority");
        if let Some(id) = resume {
            assert_eq!(thread["threadId"], id);
        }
        let turn = &wire[3]["params"];
        assert_eq!(turn["effort"], "xhigh");
        assert_eq!(turn["serviceTier"], "priority");
        assert_eq!(turn["sandboxPolicy"]["type"], "dangerFullAccess");
        let text = turn["input"][0]["text"].as_str().unwrap();
        if resume.is_some() {
            assert_eq!(text, "current user");
        } else {
            assert!(text.contains("system fixture") && text.contains("previous assistant"));
        }
        let images = turn["input"].as_array().unwrap();
        assert_eq!(images.len(), if resume.is_some() { 2 } else { 3 });
        for image in &images[1..] {
            assert_eq!(image["type"], "localImage");
            assert!(
                !std::path::Path::new(image["path"].as_str().unwrap()).exists(),
                "호출별 이미지 temp 정리"
            );
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn rejected_requests_and_terminal_failures_never_succeed_or_replay() {
    for (text, resume, code) in [
        ("RPC_FAIL", None, "cli_failed"),
        ("TURN_FAIL", None, "cli_failed"),
        ("INTERRUPTED", None, "cli_exited"),
        ("NO_FINAL", None, "cli_exited"),
        ("EXIT_FAIL", None, "cli_exited"),
        ("INTERACTION", None, "cli_interaction_required"),
        ("current", Some("missing-thread"), "cli_failed"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let req = request(dir.path(), resume, text);
        let result =
            super::super::stream_with(&profile(), &req, &mut |_| {}, Some(&fixture(dir.path())))
                .await;
        let error = result.unwrap_err();
        assert_eq!(error.code, code, "{text}: {error:?}");
        assert!(!error.retryable);
        assert_eq!(
            wire(dir.path())
                .iter()
                .filter(|row| row["method"] == "turn/start")
                .count(),
            usize::from(resume.is_none())
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn idle_and_output_limits_are_enforced_for_live_processes() {
    for (text, code) in [
        ("HANG".to_string(), "idle_timeout"),
        (format!("HANG OVERSIZE:{}", MAX_IMAGE_EVENT_BYTES + 1), "output_too_large"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let req = request(dir.path(), None, &text);
        let mut profile = profile();
        // 큰 이미지 프레임의 전송 한도 검사가 짧은 idle 검사와 경쟁하지 않게 한다.
        if code == "idle_timeout" { profile.timeout = Duration::from_millis(500); }
        let result =
            super::super::stream_with(&profile, &req, &mut |_| {}, Some(&fixture(dir.path())))
                .await;
        assert_eq!(result.unwrap_err().code, code);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn cancellation_drops_the_owned_process_while_it_is_still_streaming() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(dir.path(), None, "HANG");
    let executable = fixture(dir.path());
    let (sent, received) = tokio::sync::oneshot::channel();
    let mut sent = Some(sent);
    let task = tokio::spawn(async move {
        super::super::stream_with(
            &profile(),
            &req,
            &mut |out| {
                if out.text == "첫"
                    && let Some(sent) = sent.take()
                {
                    let _ = sent.send(());
                }
            },
            Some(&executable),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(3), received)
        .await
        .unwrap()
        .unwrap();
    assert!(
        !task.is_finished(),
        "완료를 기다리지 않고 실제 부분 응답이 전달된다"
    );
    let pid: i32 = std::fs::read_to_string(dir.path().join("native-pid"))
        .unwrap()
        .parse()
        .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(3), async {
        // Child의 비동기 reaper가 종료한 leader를 회수할 때까지 기다린다.
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("취소 후 native 프로세스가 남으면 안 된다");
}

#[test]
fn final_snapshots_replace_deltas_and_summary_parts_keep_their_order() {
    let mut state = State {
        thread: "thread".into(),
        turn: Some("turn".into()),
        ..Default::default()
    };
    let notification = |method: &str, params: Value| {
        let mut params = params;
        params["threadId"] = json!("thread");
        params["turnId"] = json!("turn");
        json!({"method":method,"params":params})
    };
    for (method, params) in [
        (
            "item/agentMessage/delta",
            json!({"itemId":"m","delta":"일부"}),
        ),
        (
            "item/completed",
            json!({"item":{"id":"m","type":"agentMessage","text":"확정"}}),
        ),
        (
            "item/reasoning/summaryTextDelta",
            json!({"itemId":"r","summaryIndex":0,"delta":"첫 요약"}),
        ),
        (
            "item/reasoning/summaryTextDelta",
            json!({"itemId":"r","summaryIndex":1,"delta":"둘째 요약"}),
        ),
    ] {
        state.notification(&notification(method, params)).unwrap();
    }
    assert_eq!(state.output.text, "확정");
    assert_eq!(state.output.reasoning, "첫 요약\n\n둘째 요약");
    let error = state
        .notification(&notification(
            "item/reasoning/summaryTextDelta",
            json!({"itemId":"r","summaryIndex":MAX_ACTIVITY,"delta":"invalid"}),
        ))
        .unwrap_err();
    assert_eq!(error.code, "cli_protocol_error");
}

#[test]
fn model_default_and_auto_options_are_not_forced() {
    let dir = tempfile::tempdir().unwrap();
    let mut req = request(dir.path(), None, "current");
    req.effort = None;
    req.cli.as_mut().unwrap().service_tier = None;
    let mut profile = profile();
    profile.model = "default".into();
    let thread = thread_params(&profile, &req);
    let turn = turn_params(&profile, &req, "thread", &[]);
    assert!(thread.get("model").is_none() && thread.get("serviceTier").is_none());
    assert!(
        turn.get("model").is_none()
            && turn.get("effort").is_none()
            && turn.get("serviceTier").is_none()
    );
}

/// 설치된 CLI와 로컬 Responses fixture로 확인한다. 로그인·외부 모델 호출·사용자 설정은 쓰지 않는다.
#[cfg(unix)]
#[tokio::test]
#[ignore = "requires installed codex; only a test-owned loopback Responses server is used"]
async fn installed_cli_streams_local_responses_before_completion_and_resumes() {
    use axum::{
        Json, Router,
        response::sse::{Event, Sse},
        routing::post,
    };
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::sync::{Notify, mpsc};

    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("codex-home");
    std::fs::create_dir(&home).unwrap();
    let skill = dir.path().join(".agents/skills/grove-native-check/SKILL.md");
    std::fs::create_dir_all(skill.parent().unwrap()).unwrap();
    std::fs::write(&skill, "---\nname: grove-native-check\ndescription: Check native skill dispatch against a local fixture.\n---\nGROVE_NATIVE_SKILL_BODY_CANARY\n").unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let gates = Arc::new([Notify::new(), Notify::new()]);
    let route = {
        let (count, requests, gates) = (count.clone(), requests.clone(), gates.clone());
        post(
            move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                let (count, requests, gates) = (count.clone(), requests.clone(), gates.clone());
                async move {
                    assert!(
                        !headers.contains_key("authorization"),
                        "실제 자격증명을 fixture에 보내지 않는다"
                    );
                    requests.lock().unwrap().push(body);
                    let index = count.fetch_add(1, Ordering::SeqCst);
                    let (tx, rx) = mpsc::channel::<Result<Event, std::convert::Infallible>>(16);
                    tokio::spawn(async move {
                        let emit = |name: &'static str, value: Value| {
                            let tx = tx.clone();
                            async move {
                                tx.send(Ok(Event::default().event(name).data(value.to_string())))
                                    .await
                                    .unwrap();
                            }
                        };
                        let id = format!("response_{index}");
                        let item = format!("message_{index}");
                        let (first, last) = if index < gates.len() {
                            ("STREAM", "_DONE")
                        } else {
                            ("{\"answer\":\"restricted answer\",\"tool\":\"\",\"arguments_json\":\"\"}", "")
                        };
                        let text = format!("{first}{last}");
                        let message = json!({"id":item,"type":"message","role":"assistant","status":"completed",
                        "internal_chat_message_metadata_passthrough":{"content_token_count":1},
                        "content":[{"type":"output_text","text":text,"annotations":[]}]});
                        emit("response.created", json!({"type":"response.created","response":{"id":id,"status":"in_progress","output":[]}})).await;
                        emit("response.output_item.added", json!({"type":"response.output_item.added","output_index":0,
                        "item":{"id":item,"type":"message","role":"assistant","status":"in_progress","content":[]}})).await;
                        emit("response.content_part.added", json!({"type":"response.content_part.added","item_id":item,
                        "output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}})).await;
                        emit(
                            "response.output_text.delta",
                            json!({"type":"response.output_text.delta","item_id":item,
                        "output_index":0,"content_index":0,"delta":first}),
                        )
                        .await;
                        // Grove가 실제 부분 출력을 받은 뒤에만 공급자가 나머지 결과를 보낸다.
                        if let Some(gate) = gates.get(index) {
                            gate.notified().await;
                            // CLI가 만드는 밀리초 단위 시작·완료 시각을 구분한다.
                            tokio::time::sleep(Duration::from_millis(20)).await;
                            emit("response.output_text.delta", json!({"type":"response.output_text.delta","item_id":item,
                                "output_index":0,"content_index":0,"delta":last})).await;
                        }
                        emit(
                            "response.output_text.done",
                            json!({"type":"response.output_text.done","item_id":item,
                        "output_index":0,"content_index":0,"text":text}),
                        )
                        .await;
                        emit("response.output_item.done", json!({"type":"response.output_item.done","output_index":0,"item":message})).await;
                        emit("response.completed", json!({"type":"response.completed","response":{"id":id,
                        "status":"completed","output":[message],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12,
                        "input_tokens_details":{"cached_tokens":0},"output_tokens_details":{"reasoning_tokens":0}}}})).await;
                    });
                    Sse::new(futures_util::stream::unfold(rx, |mut rx| async {
                        rx.recv().await.map(|event| (event, rx))
                    }))
                }
            },
        )
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, Router::new().route("/v1/responses", route))
            .await
            .unwrap();
    });
    let executable = dir.path().join("isolated-codex");
    let quoted_home = home.to_string_lossy().replace('\'', "'\\''");
    let launches = dir.path().join("app-server-launches");
    let quoted_launches = launches.to_string_lossy().replace('\'', "'\\''");
    std::fs::write(&executable, format!(
        "#!/bin/sh\nexport CODEX_HOME='{quoted_home}'\nunset OPENAI_API_KEY CODEX_API_KEY\n\
         if [ \"$1\" = app-server ]; then printf '%s\\n' \"$$\" >> '{quoted_launches}'; fi\n\
         exec codex \"$@\" -c 'model_provider=\"grove_fixture\"' -c 'model_providers.grove_fixture={{name=\"Grove fixture\",base_url=\"{base}\",wire_api=\"responses\",requires_openai_auth=false,supports_websockets=false}}' -c 'web_search=\"disabled\"'\n"
    )).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let catalog = super::super::commands::list_with("codex_cli", dir.path(), Some(&executable)).await.unwrap();
    let selected = catalog.commands.iter().find(|command| command.native_name == "grove-native-check")
        .expect("설치된 Codex가 프로젝트 스킬을 발견해야 한다");
    let initial_launches = std::fs::read_to_string(&launches).unwrap_or_default().lines().count();
    let handle = super::super::codex_session::Handle {
        sessions: Arc::default(), session: "fixture-session".into(), profile: "fixture-profile".into(),
    };
    let mut native = None;
    for index in 0..2 {
        let mut req = request(dir.path(), native.as_deref(), "/grove-native-check local fixture only");
        req.cli.as_mut().unwrap().native_command = Some(selected.info.id.clone());
        req.cli.as_mut().unwrap().codex_session = Some(handle.clone());
        let mut profile = profile();
        profile.timeout = Duration::from_secs(15);
        let mut observed = false;
        let output = super::super::stream_with(
            &profile,
            &req,
            &mut |out| {
                if out.text == "STREAM" && out.finish_reason.is_empty() {
                    observed = true;
                    gates[index].notify_one();
                }
            },
            Some(&executable),
        )
        .await
        .unwrap();
        assert!(
            observed,
            "실제 CLI가 공급자 완료 전에 delta를 전달해야 한다"
        );
        assert_eq!(output.text, "STREAM_DONE");
        assert_eq!(output.finish_reason, "stop");
        assert_eq!((output.usage.input_tokens, output.usage.output_tokens), (10, 2), "resume도 이전 턴 누적 사용량을 중복 집계하지 않는다");
        let generation = output.usage.message_generation.expect("설치된 CLI의 본문 생성 측정");
        assert_eq!(generation.output_tokens, 1);
        assert!(generation.duration_ms > 0);
        if index == 0 {
            native = output.native_session;
        } else {
            assert_eq!(output.native_session, native);
        }
    }
    assert_eq!(std::fs::read_to_string(launches).unwrap().lines().count(), initial_launches + 1);
    handle.discard();
    let mut managed = request(dir.path(), None, "restricted fixture");
    managed.cli.as_mut().unwrap().managed = true;
    managed.tools.push(super::super::super::ToolDef {
        name: "read".into(), description: "Read fixture data".into(), schema: json!({"type":"object"}),
    });
    let output = super::super::stream_with(&profile(), &managed, &mut |_| {}, Some(&executable)).await.unwrap();
    assert_eq!(output.text, "restricted answer");
    assert!(output.native_session.is_none());
    server.abort();
    let requests = requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        3,
        "실패·완료한 모델 호출을 재접수하지 않는다"
    );
    assert!(
        requests[0]["input"].to_string().contains("GROVE_NATIVE_SKILL_BODY_CANARY"),
        "Grove가 아닌 실제 Codex가 선택한 스킬 본문을 모델 입력에 넣어야 한다"
    );
    assert!(
        requests[1]["input"].to_string().contains("STREAM_DONE"),
        "재개한 thread에 이전 응답이 보존된다"
    );
    let request = &requests[2];
    assert_eq!(request["text"]["format"]["type"], "json_schema");
    assert!(!request["input"].to_string().contains("GROVE_NATIVE_SKILL_BODY_CANARY"));
    let tools = request["tools"].as_array().unwrap().iter().filter_map(|tool| tool["name"].as_str()).collect::<Vec<_>>();
    assert!(tools.iter().all(|name| matches!(*name, "update_plan" | "request_user_input")), "unexpected native execution tools: {tools:?}");
}
