//! 데몬 OS에 맞는 창 메시지 backend. 사용자 물리 포인터·전역 키 상태를 바꾸지 않는다.
use crate::tools::ToolResult;
#[cfg(not(windows))]
use crate::tools::ToolError;
use serde_json::Value;

#[cfg(windows)]
#[path = "windows.rs"]
mod windows;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend { X11, Win32 }

impl Backend {
    pub fn name(self)->&'static str {
        match self { Self::X11=>"x11_window_messages",Self::Win32=>"win32_window_messages" }
    }
    pub fn note(self)->&'static str {
        match self {
            Self::X11=>"이 Linux 서버 PC의 X11 활성 창을 제어합니다. libX11이 필요하며 Wayland·화면 없는 환경은 지원하지 않습니다. 일부 앱은 창 메시지를 거부합니다.",
            Self::Win32=>"이 Windows 서버 PC의 활성 창을 제어합니다. 로그인된 사용자 데스크톱이 필요하며 서비스 Session 0·잠금 화면·권한이 다른 앱은 제어하지 않습니다. 일부 앱은 창 메시지를 거부합니다.",
        }
    }
}

pub fn backend_for(os:&str)->Option<Backend>{
    match os {"linux"=>Some(Backend::X11),"windows"=>Some(Backend::Win32),_=>None}
}

pub fn current_backend()->Option<Backend>{backend_for(std::env::consts::OS)}

pub fn desktop_session_present()->bool{
    #[cfg(windows)] {windows::desktop_session_present()}
    #[cfg(target_os="linux")] {std::env::var_os("DISPLAY").is_some()&&std::env::var_os("WAYLAND_DISPLAY").is_none()}
    #[cfg(not(any(windows,target_os="linux")))] {false}
}

#[cfg(windows)]
pub(super) fn verify_parent()->ToolResult<()>{windows::verify_parent()}

pub fn execute(command: &Value) -> ToolResult<Value> {
    #[cfg(target_os = "linux")]
    {
        x11::execute(command)
    }
    #[cfg(windows)]
    { windows::execute(command) }
    #[cfg(not(any(windows,target_os = "linux")))]
    {
        let _ = command;
        Err(ToolError::new(
            "display_unavailable",
            "서버 PC 제어는 Windows와 Linux X11 데몬에서 지원합니다",
        ))
    }
}

#[cfg(target_os = "linux")]
mod x11 {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use libc::{c_char, c_int, c_long, c_uint, c_ulong, c_void};
    use serde_json::json;
    use std::{
        ffi::CString,
        ptr,
        sync::atomic::{AtomicBool, Ordering},
    };
    type Display = c_void;
    type Window = c_ulong;
    static X_ERROR: AtomicBool = AtomicBool::new(false);
    unsafe extern "C" fn on_error(_: *mut Display, _: *mut c_void) -> c_int {
        X_ERROR.store(true, Ordering::SeqCst);
        0
    }

    // Xlib의 공개 ABI. 정적 link/개발 패키지는 요구하지 않고 데스크톱의 런타임 library를 사용한다.
    macro_rules! api {
        ($($name:ident($($arg:ty),*) -> $out:ty;)*) => {
            struct X {lib:*mut c_void,display:*mut Display,$($name:unsafe extern "C" fn($($arg),*)->$out,)*}
            impl X {
                unsafe fn open() -> ToolResult<Self> {
                    unsafe {
                        let lib=libc::dlopen(c"libX11.so.6".as_ptr(),libc::RTLD_NOW|libc::RTLD_LOCAL);
                        if lib.is_null(){return Err(unavailable());}
                        $(
                            let symbol=libc::dlsym(lib,concat!(stringify!($name),"\0").as_ptr().cast());
                            if symbol.is_null(){libc::dlclose(lib);return Err(unavailable());}
                            let $name=std::mem::transmute::<*mut c_void,unsafe extern "C" fn($($arg),*)->$out>(symbol);
                        )*
                        let mut api=Self{lib,display:ptr::null_mut(),$($name,)*};
                        let display=(api.XOpenDisplay)(ptr::null());
                        if display.is_null(){std::mem::forget(api);libc::dlclose(lib);return Err(unavailable());}
                        api.display=display;
                        (api.XSetErrorHandler)(Some(on_error));
                        Ok(api)
                    }
                }
            }
        }
    }
    #[allow(non_snake_case)]
    mod bindings {
        use super::*;
        api! {
            XOpenDisplay(*const c_char)->*mut Display;
            XCloseDisplay(*mut Display)->c_int;
            XDefaultRootWindow(*mut Display)->Window;
            XInternAtom(*mut Display,*const c_char,c_int)->c_ulong;
            XGetWindowProperty(*mut Display,Window,c_ulong,c_long,c_long,c_int,c_ulong,*mut c_ulong,*mut c_int,*mut c_ulong,*mut c_ulong,*mut *mut u8)->c_int;
            XFree(*mut c_void)->c_int;
            XGetGeometry(*mut Display,Window,*mut Window,*mut c_int,*mut c_int,*mut c_uint,*mut c_uint,*mut c_uint,*mut c_uint)->c_int;
            XGetImage(*mut Display,Window,c_int,c_int,c_uint,c_uint,c_ulong,c_int)->*mut XImage;
            XGetPixel(*mut XImage,c_int,c_int)->c_ulong;
            XDestroyImage(*mut XImage)->c_int;
            XSync(*mut Display,c_int)->c_int;
            XSetErrorHandler(Option<unsafe extern "C" fn(*mut Display,*mut c_void)->c_int>)->*mut c_void;
            XQueryPointer(*mut Display,Window,*mut Window,*mut Window,*mut c_int,*mut c_int,*mut c_int,*mut c_int,*mut c_uint)->c_int;
            XTranslateCoordinates(*mut Display,Window,Window,c_int,c_int,*mut c_int,*mut c_int,*mut Window)->c_int;
            XStringToKeysym(*const c_char)->c_ulong;
            XKeysymToKeycode(*mut Display,c_ulong)->u8;
            XKeycodeToKeysym(*mut Display,u8,c_int)->c_ulong;
            XSendEvent(*mut Display,Window,c_int,c_long,*mut Event)->c_int;
        }
        impl Drop for X {
            fn drop(&mut self) {
                unsafe {
                    (self.XCloseDisplay)(self.display);
                    libc::dlclose(self.lib);
                }
            }
        }
        impl X {
            fn property(&self, window: Window, name: &str) -> (Vec<u64>, Vec<u8>) {
                let name = CString::new(name).unwrap();
                let mut kind = 0;
                let mut format = 0;
                let mut len = 0;
                let mut remaining = 0;
                let mut data = ptr::null_mut();
                unsafe {
                    let atom = (self.XInternAtom)(self.display, name.as_ptr(), 1);
                    if atom == 0 {
                        return (vec![], vec![]);
                    }
                    (self.XGetWindowProperty)(
                        self.display,
                        window,
                        atom,
                        0,
                        4096,
                        0,
                        0,
                        &mut kind,
                        &mut format,
                        &mut len,
                        &mut remaining,
                        &mut data,
                    );
                    if data.is_null() {
                        return (vec![], vec![]);
                    }
                    let result = if format == 32 {
                        (
                            std::slice::from_raw_parts(
                                data.cast::<c_ulong>(),
                                len.min(4096) as usize,
                            )
                            .iter()
                            .map(|n| *n as u64)
                            .collect(),
                            vec![],
                        )
                    } else if format == 8 {
                        (
                            vec![],
                            std::slice::from_raw_parts(data, len.min(16384) as usize).to_vec(),
                        )
                    } else {
                        (vec![], vec![])
                    };
                    (self.XFree)(data.cast());
                    result
                }
            }
            fn active(&self) -> Window {
                self.property(
                    unsafe { (self.XDefaultRootWindow)(self.display) },
                    "_NET_ACTIVE_WINDOW",
                )
                .0
                .first()
                .copied()
                .unwrap_or(0) as Window
            }
            fn state(&self, window: Window) -> ToolResult<Value> {
                if self.active() != window {
                    return Err(ToolError::new(
                        "focus_required",
                        "사용자가 대상 창을 활성화한 뒤 다시 capture해야 합니다",
                    ));
                }
                let mut root = 0;
                let (mut x, mut y, mut w, mut h, mut border, mut depth) = (0, 0, 0, 0, 0, 0);
                let (mut child, mut rx, mut ry, mut wx, mut wy, mut mask) = (0, 0, 0, 0, 0, 0);
                unsafe {
                    if (self.XGetGeometry)(
                        self.display,
                        window,
                        &mut root,
                        &mut x,
                        &mut y,
                        &mut w,
                        &mut h,
                        &mut border,
                        &mut depth,
                    ) == 0
                        || w == 0
                        || h == 0
                        || w > 4096
                        || h > 4096
                    {
                        return Err(unavailable());
                    }
                    (self.XQueryPointer)(
                        self.display,
                        window,
                        &mut root,
                        &mut child,
                        &mut rx,
                        &mut ry,
                        &mut wx,
                        &mut wy,
                        &mut mask,
                    );
                    (self.XSync)(self.display, 0);
                }
                if X_ERROR.swap(false, Ordering::SeqCst) {
                    return Err(unavailable());
                }
                // 누른 실제 키/버튼이 있으면 사용자의 조작 중으로 간주한다.
                if mask & 0x1f4d != 0 {
                    return Err(ToolError::new(
                        "focus_required",
                        "사용자가 키·버튼을 놓은 뒤 다시 관찰하세요",
                    ));
                }
                let pid = self
                    .property(window, "_NET_WM_PID")
                    .0
                    .first()
                    .copied()
                    .unwrap_or(0);
                if pid == 0 {
                    return Err(unavailable());
                }
                Ok(
                    json!({"window_id":format!("{window}"),"pid":pid,"native_width":w,"native_height":h,"pointer":[rx,ry],"geometry":[x,y,w,h]}),
                )
            }
            fn capture(&self, window: Window) -> ToolResult<Value> {
                let mut state = self.state(window)?;
                let w = state["native_width"].as_u64().unwrap() as u32;
                let h = state["native_height"].as_u64().unwrap() as u32;
                unsafe {
                    let raw = (self.XGetImage)(self.display, window, 0, 0, w, h, c_ulong::MAX, 2);
                    if raw.is_null() {
                        return Err(unavailable());
                    }
                    let mut pixels = image::RgbImage::new(w, h);
                    let channel = |v: c_ulong, mask: c_ulong| -> u8 {
                        if mask == 0 {
                            return 0;
                        }
                        let shift = mask.trailing_zeros();
                        (((v & mask) >> shift) * 255 / (mask >> shift)) as u8
                    };
                    for (y, row) in pixels.rows_mut().enumerate() {
                        for (x, pixel) in row.enumerate() {
                            let v = (self.XGetPixel)(raw, x as i32, y as i32);
                            *pixel = image::Rgb([
                                channel(v, (*raw).red_mask),
                                channel(v, (*raw).green_mask),
                                channel(v, (*raw).blue_mask),
                            ]);
                        }
                    }
                    (self.XDestroyImage)(raw);
                    let image = image::DynamicImage::ImageRgb8(pixels);
                    let image = if w > 1280 || h > 1280 {
                        image.resize(1280, 1280, image::imageops::FilterType::Triangle)
                    } else {
                        image
                    };
                    let mut bytes = vec![];
                    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 85)
                        .encode_image(&image)
                        .map_err(|_| unavailable())?;
                    state["width"] = json!(image.width());
                    state["height"] = json!(image.height());
                    state["pixels_sha256"] = json!(crate::util::sha256_hex(&bytes));
                    state["jpeg"] = json!(STANDARD.encode(bytes));
                }
                if self.state(window)? != {
                    let mut original = state.clone();
                    for k in ["width", "height", "pixels_sha256", "jpeg"] {
                        original.as_object_mut().unwrap().remove(k);
                    }
                    original
                } {
                    return Err(ToolError::new(
                        "stale_frame",
                        "관찰 중 창이나 포인터가 변경됐습니다",
                    ));
                }
                Ok(state)
            }
            fn send(
                &self,
                window: Window,
                kind: i32,
                code: u32,
                x: i32,
                y: i32,
                state: u32,
            ) -> ToolResult<()> {
                let root = unsafe { (self.XDefaultRootWindow)(self.display) };
                let (mut root_x, mut root_y, mut child) = (0, 0, 0);
                unsafe {
                    (self.XTranslateCoordinates)(
                        self.display,
                        window,
                        root,
                        x,
                        y,
                        &mut root_x,
                        &mut root_y,
                        &mut child,
                    );
                }
                let mut event = Event { pad: [0; 24] };
                event.input = InputEvent {
                    kind,
                    serial: 0,
                    send_event: 1,
                    display: self.display,
                    window,
                    root,
                    subwindow: 0,
                    time: 0,
                    x,
                    y,
                    x_root: root_x,
                    y_root: root_y,
                    state,
                    code,
                    same_screen: 1,
                };
                let mask = match kind {
                    2 => 1,
                    3 => 2,
                    4 => 4,
                    _ => 8,
                };
                unsafe {
                    if (self.XSendEvent)(self.display, window, 1, mask, &mut event) == 0 {
                        return Err(unavailable());
                    }
                }
                Ok(())
            }
            fn key(&self, window: Window, name: &str) -> ToolResult<()> {
                let name = CString::new(name).map_err(|_| unavailable())?;
                let symbol = unsafe { (self.XStringToKeysym)(name.as_ptr()) };
                let code = unsafe { (self.XKeysymToKeycode)(self.display, symbol) };
                if code == 0 {
                    return Err(ToolError::new(
                        "computer_unavailable",
                        "현재 키보드에서 이 문자를 입력할 수 없습니다",
                    ));
                }
                let shift = unsafe {
                    if (self.XKeycodeToKeysym)(self.display, code, 0) == symbol {
                        false
                    } else if (self.XKeycodeToKeysym)(self.display, code, 1) == symbol {
                        true
                    } else {
                        return Err(ToolError::new(
                            "computer_unavailable",
                            "현재 키보드 배열에서는 입력할 수 없습니다",
                        ));
                    }
                };
                self.send(window, 2, code as u32, 0, 0, shift as u32)?;
                self.send(window, 3, code as u32, 0, 0, shift as u32)
            }
        }
        pub(crate) fn execute(command: &Value) -> ToolResult<Value> {
            // Wayland의 XWayland 창만 제어하는 것으로 조용히 대체하지 않는다.
            if std::env::var_os("WAYLAND_DISPLAY").is_some() {
                return Err(ToolError::new(
                    "display_unavailable",
                    "Wayland는 이 버전에서 지원하지 않습니다. X11 로그인 세션이 필요합니다",
                ));
            }
            let x = unsafe { X::open()? };
            let root = unsafe { (x.XDefaultRootWindow)(x.display) };
            if command["action"] == "list" {
                let windows=x.property(root,"_NET_CLIENT_LIST").0.into_iter().take(128).map(|w|{
                    let title=x.property(w as Window,"_NET_WM_NAME").1;
                    json!({"window_id":format!("{w}"),"pid":x.property(w as Window,"_NET_WM_PID").0.first().copied().unwrap_or(0),
                        "title":String::from_utf8_lossy(&title),"active":x.active()==w as Window})
                }).collect::<Vec<_>>();
                return Ok(
                    json!({"target":"server","windows":windows,"delivery":"window_messages","limitations":"Linux X11; target must already be active; some apps reject synthetic messages; ASCII text only"}),
                );
            }
            let window = command["window_id"]
                .as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|w| *w > 0)
                .ok_or_else(unavailable)? as Window;
            let mut capture = x.capture(window)?;
            if command["action"] == "act" {
                let mut observed = capture.clone();
                observed.as_object_mut().unwrap().remove("jpeg");
                let mut expected = command["expected"].clone();
                for key in ["image_sha256", "effect"] {
                    expected
                        .as_object_mut()
                        .ok_or_else(unavailable)?
                        .remove(key);
                }
                if observed != expected {
                    return Err(ToolError::new(
                        "stale_frame",
                        "창·화면·사용자 포인터가 관찰 뒤 변경돼 입력하지 않았습니다",
                    ));
                }
                let delivery = (|| -> ToolResult<()> {
                    for step in command["actions"].as_array().ok_or_else(unavailable)? {
                        if x.state(window)? != {
                            let mut s = observed.clone();
                            for k in ["width", "height", "pixels_sha256"] {
                                s.as_object_mut().unwrap().remove(k);
                            }
                            s
                        } {
                            return Err(ToolError::new(
                                "result_unknown",
                                "사용자 개입이나 창 전환으로 멈췄습니다. 앞 동작은 전달됐을 수 있습니다",
                            ));
                        }
                        let px = (step["x"].as_u64().unwrap_or(0)
                            * observed["native_width"].as_u64().unwrap()
                            / observed["width"].as_u64().unwrap())
                            as i32;
                        let py = (step["y"].as_u64().unwrap_or(0)
                            * observed["native_height"].as_u64().unwrap()
                            / observed["height"].as_u64().unwrap())
                            as i32;
                        match step["type"].as_str().unwrap_or("") {
                            "click" | "scroll" => {
                                if step["x"].as_u64().unwrap()
                                    >= observed["width"].as_u64().unwrap()
                                    || step["y"].as_u64().unwrap()
                                        >= observed["height"].as_u64().unwrap()
                                {
                                    return Err(ToolError::new(
                                        "result_unknown",
                                        "이미지 밖 좌표로 입력하지 않았습니다. 앞 동작이 있다면 확인하세요",
                                    ));
                                }
                                let button = if step["type"] == "scroll" {
                                    if step["direction"] == "up" { 4 } else { 5 }
                                } else if step["button"] == "right" {
                                    3
                                } else {
                                    1
                                };
                                for _ in 0..step["amount"].as_u64().unwrap_or(1) {
                                    x.send(window, 4, button, px, py, 0)?;
                                    x.send(window, 5, button, px, py, 0)?;
                                }
                            }
                            "key" => x.key(
                                window,
                                match step["key"].as_str().unwrap() {
                                    "Enter" => "Return",
                                    "Backspace" => "BackSpace",
                                    s => s,
                                },
                            )?,
                            "type" => {
                                for c in step["text"].as_str().unwrap().chars() {
                                    let names = [
                                        (' ', "space"),
                                        ('!', "exclam"),
                                        ('"', "quotedbl"),
                                        ('#', "numbersign"),
                                        ('$', "dollar"),
                                        ('%', "percent"),
                                        ('&', "ampersand"),
                                        ('\'', "apostrophe"),
                                        ('(', "parenleft"),
                                        (')', "parenright"),
                                        ('*', "asterisk"),
                                        ('+', "plus"),
                                        (',', "comma"),
                                        ('-', "minus"),
                                        ('.', "period"),
                                        ('/', "slash"),
                                        (':', "colon"),
                                        (';', "semicolon"),
                                        ('<', "less"),
                                        ('=', "equal"),
                                        ('>', "greater"),
                                        ('?', "question"),
                                        ('@', "at"),
                                        ('[', "bracketleft"),
                                        ('\\', "backslash"),
                                        (']', "bracketright"),
                                        ('^', "asciicircum"),
                                        ('_', "underscore"),
                                        ('`', "grave"),
                                        ('{', "braceleft"),
                                        ('|', "bar"),
                                        ('}', "braceright"),
                                        ('~', "asciitilde"),
                                    ];
                                    let text = c.to_string();
                                    let name = names
                                        .iter()
                                        .find(|(ch, _)| *ch == c)
                                        .map(|(_, s)| *s)
                                        .unwrap_or(&text);
                                    x.key(window, name)?;
                                }
                            }
                            _ => return Err(unavailable()),
                        }
                        unsafe {
                            (x.XSync)(x.display, 0);
                        }
                        if X_ERROR.swap(false, Ordering::SeqCst) {
                            return Err(ToolError::new(
                                "result_unknown",
                                "창 메시지 전달 결과를 확인하지 못했습니다",
                            ));
                        }
                    }
                    Ok(())
                })();
                delivery.map_err(|_|ToolError::new("result_unknown","창 입력이 일부 전달됐을 수 있습니다. 새 상태를 확인하고 입력은 반복하지 마세요"))?;
                // 고정 지연으로 성공을 추정하지 않는다. 현재 관찰을 반환하고 목표 확인은 별개로 표시한다.
                capture = x.capture(window).map_err(|_| {
                    ToolError::new(
                        "result_unknown",
                        "입력 후 창을 관찰하지 못했습니다. 입력을 반복하지 마세요",
                    )
                })?;
                capture["effect"] = json!("messages_delivered_goal_unverified");
            }
            Ok(capture)
        }
    }
    #[repr(C)]
    struct XImage {
        width: c_int,
        height: c_int,
        xoffset: c_int,
        format: c_int,
        data: *mut c_char,
        byte_order: c_int,
        bitmap_unit: c_int,
        bitmap_bit_order: c_int,
        bitmap_pad: c_int,
        depth: c_int,
        bytes_per_line: c_int,
        bits_per_pixel: c_int,
        red_mask: c_ulong,
        green_mask: c_ulong,
        blue_mask: c_ulong,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct InputEvent {
        kind: c_int,
        serial: c_ulong,
        send_event: c_int,
        display: *mut Display,
        window: Window,
        root: Window,
        subwindow: Window,
        time: c_ulong,
        x: c_int,
        y: c_int,
        x_root: c_int,
        y_root: c_int,
        state: c_uint,
        code: c_uint,
        same_screen: c_int,
    }
    #[repr(C)]
    union Event {
        pad: [c_long; 24],
        input: InputEvent,
    }
    fn unavailable() -> ToolError {
        ToolError::new(
            "display_unavailable",
            "X11 화면·창·권한을 확인하세요. 화면 없는 서버에서는 사용할 수 없습니다",
        )
    }
    pub(super) use bindings::execute;
}
