//! tools::image_read 등록 후 실행할 실제 프로젝트 파일 회귀 시험.
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
