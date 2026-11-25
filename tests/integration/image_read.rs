//! 프로젝트 이미지 읽기·영속 metadata·실제 runner/provider 입력 회귀 시험.
use crate::common;
use base64::{Engine, engine::general_purpose::STANDARD};
use grove::{
    attachments::MAX_FILE_BYTES,
    tools::{Planned, image_read},
    util::sha256_hex,
};
use image::GenericImageView;
use serde_json::{Value, json};
use std::{io::Cursor, path::Path};
use tempfile::tempdir;

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Cursor::new(vec![]);
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        width,
        height,
        image::Rgba([0, 0, 0, 0]),
    ))
    .write_to(&mut bytes, image::ImageFormat::Png)
    .unwrap();
    bytes.into_inner()
}

fn read(root: &Path, path: &str) -> image_read::ImageRead {
    let planned = image_read::plan(&json!({"path": path}), root).unwrap();
    image_read::execute(&planned, root).unwrap()
}

#[test]
fn png_metadata_resize_and_model_bytes_are_separate_and_original_is_unchanged() {
    let root = tempdir().unwrap();
    let bytes = png(2048, 1024);
    // 확장자가 아니라 원문 형식을 사용한다.
    let path = root.path().join("transparent.dat");
    std::fs::write(&path, &bytes).unwrap();
    let result = read(root.path(), "transparent.dat");
    assert_eq!(
        result.metadata(),
        &json!({
            "path": "transparent.dat",
            "mime": "image/png",
            "size": bytes.len(),
            "sha256": sha256_hex(&bytes),
            "image": {
                "width": 2048, "height": 1024,
                "model_width": 1024, "model_height": 512,
                "model_mime": "image/jpeg", "frame": 0
            }
        })
    );
    let jpeg = image::load_from_memory(result.model_bytes())
        .unwrap()
        .to_rgb8();
    assert_eq!(jpeg.dimensions(), (1024, 512));
    assert!(jpeg.pixels().all(|pixel| pixel.0.iter().all(|v| *v > 250)));
    let encoded = STANDARD.encode(result.model_bytes());
    assert!(!result.metadata().to_string().contains(&encoded));
    assert!(!format!("{result:?}").contains(&encoded));
    assert!(!format!("{result:?}").contains(&format!("{:?}", result.model_bytes())));
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    let (metadata, model_bytes) = result.into_parts();
    assert_eq!(metadata["image"]["model_mime"], "image/jpeg");
    assert_eq!(
        image::guess_format(&model_bytes).unwrap(),
        image::ImageFormat::Jpeg
    );
}

#[test]
fn supported_formats_are_detected_without_upscaling() {
    let root = tempdir().unwrap();
    for (format, mime) in [
        (image::ImageFormat::Png, "image/png"),
        (image::ImageFormat::Jpeg, "image/jpeg"),
        (image::ImageFormat::Gif, "image/gif"),
        (image::ImageFormat::WebP, "image/webp"),
    ] {
        let mut bytes = Cursor::new(vec![]);
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(7, 3, image::Rgb([255, 0, 0])))
            .write_to(&mut bytes, format)
            .unwrap();
        std::fs::write(root.path().join("image"), bytes.into_inner()).unwrap();
        let result = read(root.path(), "image");
        assert_eq!(result.metadata()["mime"], mime);
        assert_eq!(result.metadata()["image"]["model_width"], 7);
        assert_eq!(result.metadata()["image"]["model_height"], 3);
        assert_eq!(
            image::load_from_memory(result.model_bytes())
                .unwrap()
                .to_rgb8()
                .dimensions(),
            (7, 3)
        );
    }
}

#[test]
fn jpeg_orientation_and_gif_first_frame_use_attachment_conversion() {
    let root = tempdir().unwrap();
    let mut jpeg = vec![];
    image::codecs::jpeg::JpegEncoder::new(&mut jpeg)
        .encode_image(&image::RgbImage::from_pixel(3, 7, image::Rgb([255, 0, 0])))
        .unwrap();
    let exif = b"Exif\0\0II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
    let mut oriented = jpeg[..2].to_vec();
    oriented.extend_from_slice(b"\xff\xe1");
    oriented.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
    oriented.extend_from_slice(exif);
    oriented.extend_from_slice(&jpeg[2..]);
    std::fs::write(root.path().join("oriented"), oriented).unwrap();
    let result = read(root.path(), "oriented");
    assert_eq!(result.metadata()["image"]["width"], 7);
    assert_eq!(result.metadata()["image"]["height"], 3);
    assert_eq!(
        image::load_from_memory(result.model_bytes())
            .unwrap()
            .dimensions(),
        (7, 3)
    );

    let mut gif = vec![];
    image::codecs::gif::GifEncoder::new(&mut gif)
        .encode_frames(
            [image::Rgba([255, 0, 0, 255]), image::Rgba([0, 255, 0, 255])]
                .into_iter()
                .map(|color| image::Frame::new(image::RgbaImage::from_pixel(8, 4, color))),
        )
        .unwrap();
    std::fs::write(root.path().join("animated"), gif).unwrap();
    let result = read(root.path(), "animated");
    assert_eq!(result.metadata()["image"]["frame"], 0);
    let decoded = image::load_from_memory(result.model_bytes())
        .unwrap()
        .to_rgb8();
    let pixel = decoded.get_pixel(0, 0);
    assert!(pixel[0] > 240 && pixel[1] < 20);
}

#[test]
fn malformed_unsupported_and_excessive_images_fail_without_modifying_sources() {
    let root = tempdir().unwrap();
    for (bytes, code) in [
        (b"\x89PNG\r\n\x1a\ninvalid".to_vec(), "invalid_request"),
        (b"GIF89ainvalid".to_vec(), "invalid_request"),
        (b"not an image".to_vec(), "unsupported_image"),
        (b"BMunsupported bitmap".to_vec(), "unsupported_image"),
        (png(8193, 1), "invalid_request"),
    ] {
        let path = root.path().join("bad.png");
        std::fs::write(&path, &bytes).unwrap();
        let planned = image_read::plan(&json!({"path": "bad.png"}), root.path()).unwrap();
        let error = image_read::execute(&planned, root.path()).unwrap_err();
        assert_eq!(error.code, code, "{error:?}");
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn pixel_limit_applies_even_when_each_dimension_is_allowed() {
    let root = tempdir().unwrap();
    let mut bytes = Cursor::new(vec![]);
    image::DynamicImage::ImageLuma8(image::GrayImage::new(4001, 4000))
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    assert!(bytes.get_ref().len() <= MAX_FILE_BYTES);
    std::fs::write(root.path().join("pixels.png"), bytes.into_inner()).unwrap();
    let planned = image_read::plan(&json!({"path": "pixels.png"}), root.path()).unwrap();
    assert_eq!(
        image_read::execute(&planned, root.path()).unwrap_err().code,
        "invalid_request"
    );
}

#[test]
fn encoded_input_is_bounded_before_decoding() {
    let root = tempdir().unwrap();
    let path = root.path().join("huge.png");
    let file = std::fs::File::create(&path).unwrap();
    file.set_len(MAX_FILE_BYTES as u64 + 1).unwrap();
    let planned = image_read::plan(&json!({"path": "huge.png"}), root.path()).unwrap();
    // read_project의 기존 I/O 오류 계약을 유지한다.
    assert_eq!(
        image_read::execute(&planned, root.path()).unwrap_err().code,
        "read_failed"
    );
    assert_eq!(
        std::fs::metadata(path).unwrap().len(),
        MAX_FILE_BYTES as u64 + 1
    );
}

#[test]
fn invalid_arguments_and_missing_or_directory_targets_fail() {
    let root = tempdir().unwrap();
    for args in [
        Value::Null,
        json!({}),
        json!({"path": 7}),
        json!({"path": ""}),
        json!({"files": [{"path": "image.png"}]}),
        json!({"path": "image.png", "files": []}),
    ] {
        assert_eq!(
            image_read::plan(&args, root.path()).unwrap_err().code,
            "invalid_arguments"
        );
    }
    for args in [json!({}), json!({"path": "."}), json!({"files": []})] {
        let planned = Planned {
            target: args,
            precondition: None,
        };
        assert_eq!(
            image_read::execute(&planned, root.path()).unwrap_err().code,
            if planned.target["path"] == "." {
                "read_failed"
            } else {
                "invalid_arguments"
            }
        );
    }
    let planned = image_read::plan(&json!({"path": "missing.png"}), root.path()).unwrap();
    assert_eq!(
        image_read::execute(&planned, root.path()).unwrap_err().code,
        "read_failed"
    );
}

#[test]
fn absolute_paths_stay_relative_in_metadata_and_outside_paths_fail() {
    let root = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let path = root.path().join("image.png");
    std::fs::write(&path, png(1, 1)).unwrap();
    let planned = image_read::plan(&json!({"path": path}), root.path()).unwrap();
    assert_eq!(
        image_read::execute(&planned, root.path())
            .unwrap()
            .metadata()["path"],
        "image.png"
    );
    let external = outside.path().join("secret.png");
    std::fs::write(&external, png(1, 1)).unwrap();
    assert_eq!(
        image_read::plan(&json!({"path": external}), root.path())
            .unwrap_err()
            .code,
        "outside_project"
    );
    assert_eq!(
        image_read::plan(&json!({"path": "../escape.png"}), root.path())
            .unwrap_err()
            .code,
        "outside_project"
    );
}

#[test]
fn in_project_replacement_is_read_at_execution_not_from_a_plan_cache() {
    let root = tempdir().unwrap();
    let path = root.path().join("image.png");
    std::fs::write(&path, png(1, 1)).unwrap();
    let planned = image_read::plan(&json!({"path": "image.png"}), root.path()).unwrap();
    let replacement = png(3, 2);
    std::fs::write(&path, &replacement).unwrap();
    let result = image_read::execute(&planned, root.path()).unwrap();
    assert_eq!(result.metadata()["sha256"], sha256_hex(&replacement));
    assert_eq!(result.metadata()["image"]["width"], 3);
    assert_eq!(result.metadata()["image"]["height"], 2);
}

#[cfg(unix)]
#[test]
fn file_and_parent_symlink_replacements_cannot_escape_after_planning() {
    use std::os::unix::fs::symlink;
    let root = tempdir().unwrap();
    let outside = tempdir().unwrap();
    std::fs::write(outside.path().join("image.png"), png(1, 1)).unwrap();
    std::fs::write(root.path().join("image.png"), png(1, 1)).unwrap();
    let file_plan = image_read::plan(&json!({"path": "image.png"}), root.path()).unwrap();
    // 삭제 대신 원래 fixture를 보존하고 계획된 이름만 symlink로 교체한다.
    std::fs::rename(root.path().join("image.png"), root.path().join("old.png")).unwrap();
    symlink(
        outside.path().join("image.png"),
        root.path().join("image.png"),
    )
    .unwrap();
    assert_eq!(
        image_read::execute(&file_plan, root.path())
            .unwrap_err()
            .code,
        "outside_project"
    );
    std::fs::create_dir(root.path().join("nested")).unwrap();
    std::fs::write(root.path().join("nested/image.png"), png(1, 1)).unwrap();
    let parent_plan = image_read::plan(&json!({"path": "nested/image.png"}), root.path()).unwrap();
    std::fs::rename(root.path().join("nested"), root.path().join("old-dir")).unwrap();
    symlink(outside.path(), root.path().join("nested")).unwrap();
    assert_eq!(
        image_read::execute(&parent_plan, root.path())
            .unwrap_err()
            .code,
        "outside_project"
    );
}

#[cfg(unix)]
#[test]
fn special_file_replacement_is_rejected_without_blocking() {
    let root = tempdir().unwrap();
    let path = root.path().join("image.png");
    std::fs::write(&path, png(1, 1)).unwrap();
    let planned = image_read::plan(&json!({"path": "image.png"}), root.path()).unwrap();
    std::fs::rename(&path, root.path().join("old.png")).unwrap();
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert_eq!(
        image_read::execute(&planned, root.path()).unwrap_err().code,
        "read_failed"
    );
}

#[tokio::test]
async fn registry_batch_preserves_order_errors_windows_and_typed_images() {
    use grove::{provider::ChatMsg, tools};
    let root = tempdir().unwrap();
    std::fs::write(root.path().join("image.dat"), png(7, 3)).unwrap();
    std::fs::write(root.path().join("notes"), "one\ntwo\nthree\n").unwrap();
    std::fs::write(root.path().join("bad"), b"GIF89ainvalid").unwrap();
    let args = json!({"files": [
        {"path":"image.dat"}, {"path":"notes","offset":1,"limit":2},
        {"path":"notes","offset":2,"limit":2}, {"path":"missing"}, {"path":"bad"}
    ]});
    let (_, planned) = tools::plan("read", &args, root.path()).unwrap();
    let (_, cancel) = tokio::sync::watch::channel(false);
    let result = tools::execute("read", &args, &planned, root.path(), cancel)
        .await
        .unwrap();
    assert_eq!(result["files"].as_array().unwrap().len(), 4);
    assert_eq!(result["files"][0]["model_input"], "project_image");
    assert!(result["files"][0].get("hex").is_none());
    assert!(
        result["files"][1]["content"]
            .as_str()
            .unwrap()
            .contains("three")
    );
    assert_eq!(result["files"][2]["error"]["code"], "not_found");
    assert_eq!(result["files"][3]["error"]["code"], "invalid_request");
    let mut messages = vec![
        ChatMsg::Tool {
            call_id: "image".into(),
            name: "read".into(),
            content: result.to_string(),
            is_error: false,
        },
        ChatMsg::Tool {
            call_id: "other".into(),
            name: "read".into(),
            content: "{}".into(),
            is_error: false,
        },
        ChatMsg::User {
            text: "next".into(),
            images: vec![],
        },
    ];
    image_read::hydrate(&mut messages, root.path()).unwrap();
    assert!(matches!(&messages[1], ChatMsg::Tool { call_id, .. } if call_id == "other"));
    let ChatMsg::User { images, text } = &messages[2] else {
        panic!("{messages:?}")
    };
    assert_eq!(images.len(), 1);
    assert!(text.contains("image.dat") && text.contains("image"));
    let jpeg = STANDARD.decode(&images[0].data).unwrap();
    assert_eq!(image::load_from_memory(&jpeg).unwrap().dimensions(), (7, 3));
    assert!(!result.to_string().contains(&images[0].data));
    assert!(!format!("{messages:?}").contains(&images[0].data));
}

#[test]
fn replay_rejects_hash_metadata_and_permission_changes_and_combines_context_limits() {
    use grove::provider::{ChatMsg, ImageInput};
    let root = tempdir().unwrap();
    let path = root.path().join("image");
    let bytes = png(7, 3);
    std::fs::write(&path, &bytes).unwrap();
    let args = json!({"path":"image"});
    let planned = image_read::plan(&args, root.path()).unwrap();
    let result = image_read::read(&args, &planned, root.path()).unwrap();
    let message = |v: &Value| ChatMsg::Tool {
        call_id: "read-image".into(),
        name: "read".into(),
        content: v.to_string(),
        is_error: false,
    };
    std::fs::write(&path, b"not even a valid image anymore").unwrap();
    assert_eq!(
        image_read::hydrate(&mut vec![message(&result)], root.path())
            .unwrap_err()
            .code,
        "image_changed"
    );
    std::fs::write(&path, &bytes).unwrap();
    let mut corrupt = result.clone();
    corrupt["image"]["model_width"] = json!(999);
    assert_eq!(
        image_read::hydrate(&mut vec![message(&corrupt)], root.path())
            .unwrap_err()
            .code,
        "invalid_image_reference"
    );
    corrupt["path"] = json!("../escape");
    assert_eq!(
        image_read::hydrate(&mut vec![message(&corrupt)], root.path())
            .unwrap_err()
            .code,
        "outside_project"
    );
    let upload = ImageInput {
        id: "upload".into(),
        sha256: "".into(),
        width: 1,
        height: 1,
        mime: "image/jpeg".into(),
        data: "".into(),
    };
    let mut count = vec![
        ChatMsg::User {
            text: "".into(),
            images: vec![upload.clone(); 32],
        },
        message(&result),
    ];
    assert_eq!(
        image_read::hydrate(&mut count, root.path())
            .unwrap_err()
            .code,
        "image_input_limit"
    );
    let mut large = upload;
    large.data = "a".repeat(8 * 1024 * 1024);
    let mut size = vec![
        ChatMsg::User {
            text: "".into(),
            images: vec![large],
        },
        message(&result),
    ];
    assert_eq!(
        image_read::hydrate(&mut size, root.path())
            .unwrap_err()
            .code,
        "image_input_limit"
    );
    // 원래 파일을 보존한 채 이름을 바꿔 읽기 권한/가용성 철회도 재검사한다.
    std::fs::rename(&path, root.path().join("saved")).unwrap();
    assert!(image_read::hydrate(&mut vec![message(&result)], root.path()).is_err());
}

#[test]
fn mixed_batch_keeps_image_reference_when_json_escaping_exceeds_history_limit() {
    use grove::provider::ChatMsg;
    let root = tempdir().unwrap();
    std::fs::write(root.path().join("image"), png(1, 1)).unwrap();
    std::fs::write(
        root.path().join("text"),
        ("\u{1}".repeat(1900) + "\n").repeat(32),
    )
    .unwrap();
    let args = json!({"files":[{"path":"text"},{"path":"image"}]});
    let planned = grove::tools::fs::plan_read(&args, root.path(), "read").unwrap();
    let result = image_read::read(&args, &planned, root.path()).unwrap();
    assert!(result.to_string().len() < 100 * 1024);
    assert_eq!(result["files"][0]["skipped"], "batch_output_limit");
    let mut messages = vec![ChatMsg::Tool {
        call_id: "batch".into(),
        name: "read".into(),
        content: result.to_string(),
        is_error: false,
    }];
    image_read::hydrate(&mut messages, root.path()).unwrap();
    assert!(matches!(&messages[1], ChatMsg::User { images, .. } if images.len() == 1));
    // 보통 텍스트 read의 잘린 JSON은 이미지 복원 오류로 승격하지 않는다.
    let mut text = vec![ChatMsg::Tool {
        call_id: "text".into(),
        name: "read".into(),
        content: "{\"content\":\"truncated".into(),
        is_error: false,
    }];
    image_read::hydrate(&mut text, root.path()).unwrap();
    assert_eq!(text.len(), 1);
}

struct ImageProvider {
    base: String,
    requests: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
}

impl ImageProvider {
    async fn start(protocol: &str) -> Self {
        use axum::{
            Router,
            body::{Body, Bytes},
            response::Response,
            routing::post,
        };
        let requests = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let shared = requests.clone();
        let protocol = protocol.to_string();
        let app = Router::new().fallback(post(move |bytes: Bytes| {
            let shared = shared.clone();
            let protocol = protocol.clone();
            async move {
                let request: Value = serde_json::from_slice(&bytes).unwrap();
                let index = {
                    let mut requests = shared.lock().unwrap();
                    requests.push(request);
                    requests.len()
                };
                if index == 2 {
                    return Response::builder().status(400).body(Body::from(r#"{"error":{"message":"fixture refusal"}}"#)).unwrap();
                }
                let frames = match (protocol.as_str(), index == 1) {
                    ("anthropic", true) => vec![
                        json!({"type":"message_start","message":{"usage":{}}}),
                        json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"read-image","name":"read","input":{}}}),
                        json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"image.dat\"}"}}),
                        json!({"type":"content_block_stop","index":0}),
                        json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{}}),
                        json!({"type":"message_stop"}),
                    ],
                    ("anthropic", false) => vec![
                        json!({"type":"message_start","message":{"usage":{}}}),
                        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"done"}}),
                        json!({"type":"content_block_stop","index":0}),
                        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}),
                        json!({"type":"message_stop"}),
                    ],
                    ("gemini", true) => vec![json!({"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"read","args":{"path":"image.dat"}}}]},"finishReason":"STOP"}]})],
                    ("gemini", false) => vec![json!({"candidates":[{"content":{"role":"model","parts":[{"text":"done"}]},"finishReason":"STOP"}]})],
                    (_, true) => vec![
                        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"read-image","type":"function","function":{"name":"read","arguments":"{\"path\":\"image.dat\"}"}}]}}]}),
                        json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}),
                    ],
                    (_, false) => vec![json!({"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]})],
                };
                let mut body = String::new();
                for frame in frames {
                    if protocol == "anthropic" {
                        body.push_str(&format!("event: {}\n", frame["type"].as_str().unwrap()));
                    }
                    body.push_str(&format!("data: {frame}\n\n"));
                }
                if protocol == "openai" { body.push_str("data: [DONE]\n\n"); }
                Response::builder().header("content-type","text/event-stream").body(Body::from(body)).unwrap()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            base,
            requests,
            task,
        }
    }
}

impl Drop for ImageProvider {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn request_image<'a>(protocol: &str, request: &'a Value) -> &'a str {
    match protocol {
        "anthropic" => request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|m| m["content"].as_array().into_iter().flatten())
            .find_map(|p| p["source"]["data"].as_str())
            .unwrap(),
        "gemini" => request["contents"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|m| m["parts"].as_array().into_iter().flatten())
            .find_map(|p| p["inlineData"]["data"].as_str())
            .unwrap(),
        _ => request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|m| m["content"].as_array().into_iter().flatten())
            .find_map(|p| p["image_url"]["url"].as_str())
            .unwrap()
            .strip_prefix("data:image/jpeg;base64,")
            .unwrap(),
    }
}

#[tokio::test]
async fn read_runner_provider_images_survive_restart_retry_and_reject_changed_sources() {
    use reqwest::StatusCode;
    for protocol in ["openai", "anthropic", "gemini"] {
        let mut server = common::TestServer::start().await;
        let provider = ImageProvider::start(protocol).await;
        let (status, profile) = server.post("/api/v1/model-profiles", json!({
            "name":"image fixture", "protocol":protocol, "base_url":provider.base, "model":"fixture",
            "options":{"capabilities":{"images":true}}
        })).await;
        assert_eq!(status, StatusCode::CREATED, "{profile}");
        let project = server.create_project("image").await;
        let path = Path::new(project["root_path"].as_str().unwrap()).join("image.dat");
        let bytes = png(2000, 1200);
        std::fs::write(&path, &bytes).unwrap();
        let session = server.create_session(project["id"].as_str().unwrap()).await;
        let sid = session["id"].as_str().unwrap();
        let (status, turn) = server
            .post(
                &format!("/api/v1/sessions/{sid}/turns"),
                json!({"profile_id":profile["id"],"text":"read image.dat","tools":true}),
            )
            .await;
        assert_eq!(status, StatusCode::ACCEPTED, "{turn}");
        let tid = turn["turn"]["id"].as_str().unwrap();
        let failed = server.wait_status(tid, "failed").await;
        assert_eq!(
            failed["error"]["code"], "bad_request",
            "{}",
            failed["error"]
        );
        server.restart().await;
        let (status, retry) = server
            .post(&format!("/api/v1/turns/{tid}/retry"), json!({}))
            .await;
        assert_eq!(status, StatusCode::ACCEPTED, "{retry}");
        server
            .wait_status(retry["turn"]["id"].as_str().unwrap(), "completed")
            .await;
        let requests = provider.requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 3, "{protocol}");
        let data = request_image(protocol, &requests[1]);
        assert_eq!(data, request_image(protocol, &requests[2]));
        let jpeg = STANDARD.decode(data).unwrap();
        assert_ne!(jpeg, bytes);
        let decoded = image::load_from_memory(&jpeg).unwrap().to_rgb8();
        assert_eq!(decoded.dimensions(), (1024, 614));
        assert!(decoded.pixels().all(|p| p.0.iter().all(|v| *v > 250)));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let db = rusqlite::Connection::open(server.data_dir().join("grove.db")).unwrap();
        let attachments: i64 = db
            .query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            attachments, 0,
            "프로젝트 이미지는 업로드 첨부 참조가 아니다"
        );
        for table in ["messages", "events", "tool_calls"] {
            let mut statement = db.prepare(&format!("SELECT * FROM {table}")).unwrap();
            let columns = statement.column_count();
            let mut rows = statement.query([]).unwrap();
            while let Some(row) = rows.next().unwrap() {
                for column in 0..columns {
                    if let Ok(text) = row.get::<_, String>(column) {
                        assert!(!text.contains(data), "{table} leaked model bytes");
                        assert!(
                            !text.contains(&STANDARD.encode(&bytes)),
                            "{table} leaked original bytes"
                        );
                    }
                }
            }
        }
        std::fs::write(&path, b"changed original").unwrap();
        let (_, turn) = server
            .post(
                &format!("/api/v1/sessions/{sid}/turns"),
                json!({"profile_id":profile["id"],"text":"look again","tools":true}),
            )
            .await;
        let failed = server
            .wait_status(turn["turn"]["id"].as_str().unwrap(), "failed")
            .await;
        assert_eq!(failed["error"]["code"], "image_changed", "{failed}");
        assert_eq!(provider.requests.lock().unwrap().len(), 3);
        server.stop().await;
    }
}

#[tokio::test]
async fn unsupported_model_fails_before_sending_read_image() {
    use common::{
        TestServer,
        fixture::{self, Fixture},
    };
    let server = TestServer::start().await;
    let fixture = Fixture::start().await;
    let (_, profile) = server
        .post(
            "/api/v1/model-profiles",
            json!({
                "name":"text only", "protocol":"openai", "base_url":fixture.base, "model":"fixture",
                "options":{"capabilities":{"images":false}}
            }),
        )
        .await;
    let project = server.create_project("text-only").await;
    std::fs::write(
        Path::new(project["root_path"].as_str().unwrap()).join("image.dat"),
        png(1, 1),
    )
    .unwrap();
    let session = server.create_session(project["id"].as_str().unwrap()).await;
    fixture.push(fixture::tool_calls(&[(
        "read-image",
        "read",
        json!({"path":"image.dat"}),
    )]));
    let (_, turn) = server
        .post(
            &format!("/api/v1/sessions/{}/turns", session["id"].as_str().unwrap()),
            json!({"profile_id":profile["id"],"text":"read image","tools":true}),
        )
        .await;
    let failed = server
        .wait_status(turn["turn"]["id"].as_str().unwrap(), "failed")
        .await;
    assert_eq!(failed["error"]["code"], "unsupported", "{failed}");
    assert_eq!(fixture.requests().len(), 1);
}
