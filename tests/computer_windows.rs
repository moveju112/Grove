//! Windows native backend를 실제 Win32 컨트롤로 검사한다.
//! 로그인된 시험 desktop이 필요하다. Linux에서는 고유 Wine/Xvfb desktop에서 실행한다.
#![cfg(windows)]

use grove::{tools, util};
#[path = "../src/computer/windows.rs"]
#[allow(dead_code)]
mod backend;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::ptr;
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, WPARAM},
    Graphics::Gdi::UpdateWindow,
    UI::{
        HiDpi::{DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE, SetThreadDpiAwarenessContext},
        Input::KeyboardAndMouse::SetFocus,
        WindowsAndMessaging::*,
    },
};

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

struct Window(HWND);
impl Drop for Window {
    fn drop(&mut self) {
        unsafe { DestroyWindow(self.0); }
    }
}

struct Dpi(DPI_AWARENESS_CONTEXT);
impl Drop for Dpi {
    fn drop(&mut self) {
        unsafe { SetThreadDpiAwarenessContext(self.0); }
    }
}

unsafe extern "system" fn no_capture(window: HWND, message: u32, w: WPARAM, l: LPARAM) -> isize {
    unsafe {
        if matches!(message, WM_PRINT | WM_PRINTCLIENT) { return 0; }
        let original = GetWindowLongPtrW(window, GWLP_USERDATA);
        let original = std::mem::transmute::<isize, unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> isize>(original);
        CallWindowProcW(Some(original), window, message, w, l)
    }
}

fn observe(window: HWND) -> Value {
    backend::execute(&json!({"action":"capture","window_id":format!("hwnd:0x{:x}",window as usize)})).unwrap()
}

#[test]
fn win32_capture_unicode_input_stale_frame_and_unpainted_capture() {
    unsafe {
        assert!(backend::desktop_session_present(), "로그인된 격리 시험 desktop이 필요합니다");
        let previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE);
        assert!(!previous.is_null());
        let _dpi = Dpi(previous);
        let window = Window(CreateWindowExW(0, wide("EDIT").as_ptr(), wide("initial").as_ptr(),
            WS_POPUP | WS_VISIBLE | WS_BORDER, 80, 80, 400, 200,
            ptr::null_mut(), ptr::null_mut(), ptr::null_mut(), ptr::null()));
        assert!(!window.0.is_null());
        assert_ne!(SetForegroundWindow(window.0), 0);
        SetFocus(window.0);
        HideCaret(window.0);
        UpdateWindow(window.0);
        let initial = observe(window.0);
        let image = image::load_from_memory(&STANDARD.decode(initial["jpeg"].as_str().unwrap()).unwrap()).unwrap().to_rgb8();
        assert!(image.width() > 0 && image.height() > 0);
        assert!(image.pixels().any(|pixel| pixel != image.get_pixel(0, 0)), "시험 텍스트와 배경이 실제로 캡처돼야 합니다");
        let mut expected = initial.clone();
        expected.as_object_mut().unwrap().remove("jpeg");
        let result = backend::execute(&json!({"action":"act","window_id":initial["window_id"],
            "expected":expected,"actions":[{"type":"key","key":"End"},{"type":"type","text":"한글🪟A"},{"type":"key","key":"Backspace"}]})).unwrap();
        assert_eq!(result["effect"], "messages_delivered_goal_unverified");
        assert_eq!(result["pointer"], initial["pointer"]);
        let mut text = [0u16;128];
        let length = GetWindowTextW(window.0, text.as_mut_ptr(), text.len() as i32);
        assert_eq!(String::from_utf16_lossy(&text[..length as usize]), "initial한글🪟");
        assert_ne!(result["pixels_sha256"], initial["pixels_sha256"]);

        let refused = backend::execute(&json!({"action":"act","window_id":initial["window_id"],
            "expected":expected,"actions":[{"type":"type","text":"must not arrive"}]})).unwrap_err();
        assert_eq!(refused.code, "stale_frame");
        let length = GetWindowTextW(window.0, text.as_mut_ptr(), text.len() as i32);
        assert_eq!(String::from_utf16_lossy(&text[..length as usize]), "initial한글🪟");

        // 화면을 그리지 않는 앱은 정상 이미지로 처리하지 않고 입력 전에 멈춘다.
        let original = GetWindowLongPtrW(window.0, GWLP_WNDPROC);
        SetWindowLongPtrW(window.0, GWLP_USERDATA, original);
        SetWindowLongPtrW(window.0, GWLP_WNDPROC, no_capture as *const () as isize);
        let refused = backend::execute(&json!({"action":"capture","window_id":initial["window_id"]})).unwrap_err();
        assert_eq!(refused.code, "computer_unavailable");
    }
}
