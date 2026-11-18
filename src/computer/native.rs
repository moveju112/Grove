//! 데몬 OS에 맞는 창 제어 backend.
#[cfg(not(windows))]
use crate::tools::ToolError;
use crate::tools::ToolResult;
use serde_json::Value;

#[cfg(windows)]
#[path = "windows.rs"]
mod windows;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    X11,
    Win32,
}

impl Backend {
    pub fn name(self) -> &'static str {
        match self {
            Self::X11 => "x11_xtest",
            Self::Win32 => "win32_window_messages",
        }
    }
    pub fn note(self) -> &'static str {
        match self {
            Self::X11 => {
                "서버 PC의 X11 앱 창을 전환하고 마우스·키보드로 제어합니다. XTEST가 필요하며 Wayland·화면 없는 환경은 지원하지 않습니다."
            }
            Self::Win32 => {
                "서버 PC의 Windows 앱 창을 전환하고 제어합니다. OS가 전환을 거부하거나 앱이 창 메시지를 받지 않으면 제어할 수 없습니다. 서비스 Session 0·잠금 화면·권한이 다른 앱은 지원하지 않습니다."
            }
        }
    }
}

pub fn backend_for(os: &str) -> Option<Backend> {
    match os {
        "linux" => Some(Backend::X11),
        "windows" => Some(Backend::Win32),
        _ => None,
    }
}

pub fn current_backend() -> Option<Backend> {
    backend_for(std::env::consts::OS)
}

pub fn desktop_session_present() -> bool {
    #[cfg(windows)]
    {
        windows::desktop_session_present()
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("DISPLAY").is_some() && std::env::var_os("WAYLAND_DISPLAY").is_none()
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        false
    }
}

#[cfg(windows)]
pub(super) fn verify_parent() -> ToolResult<()> {
    windows::verify_parent()
}

pub fn execute(command: &Value) -> ToolResult<Value> {
    #[cfg(target_os = "linux")]
    {
        x11::execute(command)
    }
    #[cfg(windows)]
    {
        windows::execute(command)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
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
        thread,
        time::{Duration, Instant},
    };
    type Display = c_void;
    type Window = c_ulong;
    static X_ERROR: AtomicBool = AtomicBool::new(false);
    unsafe extern "C" fn on_error(_: *mut Display, _: *mut c_void) -> c_int {
        X_ERROR.store(true, Ordering::SeqCst);
        0
    }

    struct XTest {
        lib: *mut c_void,
        query: unsafe extern "C" fn(
            *mut Display,
            *mut c_int,
            *mut c_int,
            *mut c_int,
            *mut c_int,
        ) -> c_int,
        motion: unsafe extern "C" fn(*mut Display, c_int, c_int, c_int, c_ulong) -> c_int,
        button: unsafe extern "C" fn(*mut Display, c_uint, c_int, c_ulong) -> c_int,
        key: unsafe extern "C" fn(*mut Display, c_uint, c_int, c_ulong) -> c_int,
    }

    impl XTest {
        fn unavailable() -> ToolError {
            ToolError::new(
                "computer_unavailable",
                "X11 입력에는 libXtst와 XTEST 확장이 필요합니다",
            )
        }

        fn open() -> ToolResult<Self> {
            unsafe {
                let lib = libc::dlopen(c"libXtst.so.6".as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL);
                if lib.is_null() {
                    return Err(Self::unavailable());
                }
                macro_rules! symbol {
                    ($name:literal, $signature:ty) => {{
                        let ptr = libc::dlsym(lib, $name.as_ptr());
                        if ptr.is_null() {
                            libc::dlclose(lib);
                            return Err(Self::unavailable());
                        }
                        std::mem::transmute::<*mut c_void, $signature>(ptr)
                    }};
                }
                Ok(Self {
                    lib,
                    query: symbol!(
                        c"XTestQueryExtension",
                        unsafe extern "C" fn(
                            *mut Display,
                            *mut c_int,
                            *mut c_int,
                            *mut c_int,
                            *mut c_int,
                        ) -> c_int
                    ),
                    motion: symbol!(
                        c"XTestFakeMotionEvent",
                        unsafe extern "C" fn(*mut Display, c_int, c_int, c_int, c_ulong) -> c_int
                    ),
                    button: symbol!(
                        c"XTestFakeButtonEvent",
                        unsafe extern "C" fn(*mut Display, c_uint, c_int, c_ulong) -> c_int
                    ),
                    key: symbol!(
                        c"XTestFakeKeyEvent",
                        unsafe extern "C" fn(*mut Display, c_uint, c_int, c_ulong) -> c_int
                    ),
                })
            }
        }

        fn require_extension(&self, display: *mut Display) -> ToolResult<()> {
            let (mut event, mut error, mut major, mut minor) = (0, 0, 0, 0);
            if unsafe { (self.query)(display, &mut event, &mut error, &mut major, &mut minor) } == 0
            {
                return Err(Self::unavailable());
            }
            Ok(())
        }
    }

    impl Drop for XTest {
        fn drop(&mut self) {
            unsafe {
                libc::dlclose(self.lib);
            }
        }
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
            XSendEvent(*mut Display,Window,c_int,c_long,*mut Event)->c_int;
            XKeycodeToKeysym(*mut Display,u8,c_int)->c_ulong;
            XGetInputFocus(*mut Display,*mut Window,*mut c_int)->c_int;
            XQueryTree(*mut Display,Window,*mut Window,*mut Window,*mut *mut Window,*mut c_uint)->c_int;
            XQueryKeymap(*mut Display,*mut c_char)->c_int;
            XGrabServer(*mut Display)->c_int;
            XUngrabServer(*mut Display)->c_int;
            XGrabPointer(*mut Display,Window,c_int,c_uint,c_int,c_int,Window,c_ulong,c_ulong)->c_int;
            XUngrabPointer(*mut Display,c_ulong)->c_int;
            XGrabKeyboard(*mut Display,Window,c_int,c_int,c_int,c_ulong)->c_int;
            XUngrabKeyboard(*mut Display,c_ulong)->c_int;
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
            fn input_focus(&self) -> Window {
                let (mut focus, mut revert) = (0, 0);
                unsafe {
                    (self.XGetInputFocus)(self.display, &mut focus, &mut revert);
                }
                focus
            }
            fn parent(&self, window: Window) -> Option<Window> {
                let (mut root, mut parent, mut count, mut children) = (0, 0, 0, ptr::null_mut());
                unsafe {
                    let ok = (self.XQueryTree)(
                        self.display,
                        window,
                        &mut root,
                        &mut parent,
                        &mut children,
                        &mut count,
                    );
                    if !children.is_null() {
                        (self.XFree)(children.cast());
                    }
                    (ok != 0 && parent != 0).then_some(parent)
                }
            }
            fn contains(&self, window: Window, mut child: Window) -> bool {
                for _ in 0..64 {
                    if child == window {
                        return true;
                    }
                    if child <= 1 {
                        break;
                    }
                    let Some(parent) = self.parent(child) else {
                        break;
                    };
                    child = parent;
                }
                false
            }
            fn pointer(&self, window: Window) -> ToolResult<(i32, i32, Window, u32)> {
                let (mut root, mut child, mut rx, mut ry, mut wx, mut wy, mut mask) =
                    (0, 0, 0, 0, 0, 0, 0);
                let same_screen = unsafe {
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
                    )
                };
                if same_screen == 0 {
                    return Err(unavailable());
                }
                Ok((rx, ry, child, mask))
            }
            fn require_idle(&self, mask: u32) -> ToolResult<()> {
                let mut keys = [0; 32];
                unsafe {
                    (self.XQueryKeymap)(self.display, keys.as_mut_ptr());
                }
                if mask & 0x1f4d != 0 || keys.iter().any(|&key| key != 0) {
                    return Err(ToolError::new(
                        "focus_required",
                        "사용자가 키·버튼을 놓은 뒤 다시 관찰하세요",
                    ));
                }
                Ok(())
            }
            fn focus(&self, root: Window, window: Window) -> ToolResult<Value> {
                let clients = self.property(root, "_NET_CLIENT_LIST").0;
                if !clients.contains(&(window as u64))
                    || self
                        .property(window, "_NET_WM_PID")
                        .0
                        .first()
                        .copied()
                        .unwrap_or(0)
                        == 0
                {
                    return Err(unavailable());
                }
                self.require_idle(self.pointer(root)?.3)?;
                if self.active() != window || !self.contains(window, self.input_focus()) {
                    let active_atom = unsafe {
                        (self.XInternAtom)(self.display, c"_NET_ACTIVE_WINDOW".as_ptr(), 1)
                    };
                    if active_atom == 0 {
                        return Err(unavailable());
                    }
                    let mut event = Event { pad: [0; 24] };
                    event.client = ClientEvent {
                        kind: 33,
                        serial: 0,
                        send_event: 1,
                        display: self.display,
                        window,
                        message_type: active_atom,
                        format: 32,
                        // EWMH: source 2는 사용자 동작을 대리하는 창 전환 도구다.
                        data: [2, 0, 0, 0, 0],
                    };
                    let sent = unsafe {
                        let ok = (self.XSendEvent)(
                            self.display,
                            root,
                            0,
                            (1 << 19) | (1 << 20),
                            &mut event,
                        );
                        (self.XSync)(self.display, 0);
                        ok
                    };
                    if sent == 0 || X_ERROR.swap(false, Ordering::SeqCst) {
                        return Err(unavailable());
                    }
                    let deadline = Instant::now() + Duration::from_secs(1);
                    while self.active() != window || !self.contains(window, self.input_focus()) {
                        if Instant::now() >= deadline {
                            return Err(ToolError::new(
                                "focus_required",
                                "창 관리자가 대상 창을 활성화하지 않았습니다",
                            ));
                        }
                        thread::sleep(Duration::from_millis(20));
                    }
                }
                Ok(json!({"window_id":format!("{window}"),"active":true}))
            }
            fn state(&self, window: Window) -> ToolResult<Value> {
                let focus = self.input_focus();
                if self.active() != window || !self.contains(window, focus) {
                    return Err(ToolError::new(
                        "focus_required",
                        "대상 창에 focus를 실행한 뒤 다시 capture하세요",
                    ));
                }
                let mut root = 0;
                let (mut x, mut y, mut w, mut h, mut border, mut depth) = (0, 0, 0, 0, 0, 0);
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
                    let mut child = 0;
                    if (self.XTranslateCoordinates)(
                        self.display,
                        window,
                        root,
                        0,
                        0,
                        &mut x,
                        &mut y,
                        &mut child,
                    ) == 0
                    {
                        return Err(unavailable());
                    }
                }
                let (rx, ry, _, mask) = self.pointer(window)?;
                self.require_idle(mask)?;
                if X_ERROR.swap(false, Ordering::SeqCst) {
                    return Err(unavailable());
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
                    json!({"window_id":format!("{window}"),"pid":pid,"native_width":w,"native_height":h,"pointer":[rx,ry],"geometry":[x,y,w,h],"focus_window":format!("{focus}")}),
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
            fn pointer_target(&self, root: Window) -> ToolResult<Window> {
                let mut parent = root;
                for _ in 0..64 {
                    let (_, _, child, _) = self.pointer(parent)?;
                    if child == 0 {
                        return Ok(parent);
                    }
                    parent = child;
                }
                Err(unavailable())
            }
            fn require_ungrabbed(&self, root: Window, pointer: bool) -> ToolResult<()> {
                // 메뉴·드래그 등이 입력을 선점했다면 화면 좌표나 키 포커스만으로 수신 창을 보장할 수 없다.
                let status = unsafe {
                    if pointer {
                        let status = (self.XGrabPointer)(self.display, root, 0, 0, 1, 1, 0, 0, 0);
                        if status == 0 {
                            (self.XUngrabPointer)(self.display, 0);
                        }
                        status
                    } else {
                        let status = (self.XGrabKeyboard)(self.display, root, 0, 1, 1, 0);
                        if status == 0 {
                            (self.XUngrabKeyboard)(self.display, 0);
                        }
                        status
                    }
                };
                if status != 0 {
                    return Err(ToolError::new(
                        "focus_required",
                        "다른 창이나 메뉴가 입력을 사용 중입니다",
                    ));
                }
                Ok(())
            }
            fn resolve_key(&self, name: &str) -> ToolResult<(u32, Option<u32>)> {
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
                let modifier = if shift {
                    let shift_code = unsafe { (self.XKeysymToKeycode)(self.display, 0xffe1) };
                    if shift_code == 0 {
                        return Err(unavailable());
                    }
                    Some(u32::from(shift_code))
                } else {
                    None
                };
                Ok((u32::from(code), modifier))
            }
            fn send_keys(&self, xtest: &XTest, keys: &[(u32, Option<u32>)]) -> ToolResult<()> {
                for &(code, shift) in keys {
                    let fake = |key, down| unsafe { (xtest.key)(self.display, key, down, 0) != 0 };
                    let modifier = shift.is_none_or(|key| fake(key, 1));
                    let pressed = modifier && fake(code, 1);
                    let released = fake(code, 0);
                    let modifier_released = shift.is_none_or(|key| fake(key, 0));
                    if !(pressed && released && modifier_released) {
                        return Err(unavailable());
                    }
                }
                Ok(())
            }
        }
        struct ServerGrab<'a>(&'a X);
        impl<'a> ServerGrab<'a> {
            fn new(x: &'a X) -> Self {
                unsafe {
                    (x.XGrabServer)(x.display);
                }
                Self(x)
            }
        }
        impl Drop for ServerGrab<'_> {
            fn drop(&mut self) {
                unsafe {
                    (self.0.XUngrabServer)(self.0.display);
                    (self.0.XSync)(self.0.display, 0);
                }
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
            // Xlib가 display 종료 중 호출하는 확장 callback보다 libXtst가 오래 살아야 한다.
            let xtest;
            let x = unsafe { X::open()? };
            let root = unsafe { (x.XDefaultRootWindow)(x.display) };
            if command["action"] == "list" {
                let active = x.active();
                let windows=x.property(root,"_NET_CLIENT_LIST").0.into_iter().take(128).map(|w|{
                    let title=x.property(w as Window,"_NET_WM_NAME").1;
                    json!({"window_id":format!("{w}"),"pid":x.property(w as Window,"_NET_WM_PID").0.first().copied().unwrap_or(0),
                        "title":String::from_utf8_lossy(&title),"active":active==w as Window})
                }).collect::<Vec<_>>();
                return Ok(
                    json!({"target":"server","windows":windows,"delivery":"xtest","limitations":"Linux X11; focus inactive windows before capture; XTEST required for input; ASCII text only"}),
                );
            }
            let window = command["window_id"]
                .as_str()
                .and_then(|s| s.parse::<Window>().ok())
                .filter(|w| *w > 1 && *w <= u32::MAX.into())
                .ok_or_else(unavailable)?;
            if command["action"] == "focus" {
                return x.focus(root, window);
            }
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
                xtest = XTest::open()?;
                xtest.require_extension(x.display)?;
                let mut guard_state = observed.clone();
                for k in ["width", "height", "pixels_sha256"] {
                    guard_state.as_object_mut().unwrap().remove(k);
                }
                let mut delivered = false;
                let delivery = (|| -> ToolResult<()> {
                    for step in command["actions"].as_array().ok_or_else(unavailable)? {
                        // 확인부터 입력 쌍까지 다른 X11 클라이언트가 창을 바꾸지 못하게 한다.
                        // 앱이 입력을 처리할 수 있도록 각 동작 뒤 즉시 해제한다.
                        let grab = ServerGrab::new(&x);
                        let current = x.state(window)?;
                        if current != guard_state {
                            return Err(ToolError::new(
                                "stale_frame",
                                "사용자 개입이나 창 전환으로 입력을 멈췄습니다",
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
                                        "invalid_arguments",
                                        "이미지 밖 좌표로 입력하지 않았습니다",
                                    ));
                                }
                                let button = if step["type"] == "scroll" {
                                    if step["direction"] == "up" { 4 } else { 5 }
                                } else if step["button"] == "right" {
                                    3
                                } else {
                                    1
                                };
                                let rx = observed["geometry"][0].as_i64().unwrap() as i32 + px;
                                let ry = observed["geometry"][1].as_i64().unwrap() as i32 + py;
                                x.require_ungrabbed(root, true)?;
                                unsafe {
                                    if (xtest.motion)(x.display, -1, rx, ry, 0) == 0 {
                                        return Err(unavailable());
                                    }
                                }
                                let (mx, my, _, mask) = x.pointer(root)?;
                                x.require_idle(mask)?;
                                if (mx, my) != (rx, ry)
                                    || !x.contains(window, x.pointer_target(root)?)
                                {
                                    return Err(ToolError::new(
                                        "focus_required",
                                        "다른 창이 좌표를 가리고 있어 클릭하지 않았습니다",
                                    ));
                                }
                                guard_state["pointer"] = json!([rx, ry]);
                                delivered = true;
                                for _ in 0..step["amount"].as_u64().unwrap_or(1) {
                                    let down = unsafe { (xtest.button)(x.display, button, 1, 0) };
                                    let up = unsafe { (xtest.button)(x.display, button, 0, 0) };
                                    if down == 0 || up == 0 {
                                        return Err(unavailable());
                                    }
                                }
                            }
                            "key" => {
                                let key = x.resolve_key(match step["key"].as_str().unwrap() {
                                    "Enter" => "Return",
                                    "Backspace" => "BackSpace",
                                    s => s,
                                })?;
                                x.require_ungrabbed(root, false)?;
                                delivered = true;
                                x.send_keys(&xtest, &[key])?;
                            }
                            "type" => {
                                let mut keys = Vec::new();
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
                                    keys.push(x.resolve_key(name)?);
                                }
                                x.require_ungrabbed(root, false)?;
                                delivered = true;
                                x.send_keys(&xtest, &keys)?;
                            }
                            _ => return Err(unavailable()),
                        }
                        drop(grab);
                        if X_ERROR.swap(false, Ordering::SeqCst) {
                            return Err(ToolError::new(
                                "result_unknown",
                                "X11 입력 전달 결과를 확인하지 못했습니다",
                            ));
                        }
                    }
                    Ok(())
                })();
                delivery.map_err(|e| if delivered { ToolError::new("result_unknown","창 입력이 일부 전달됐을 수 있습니다. 새 상태를 확인하고 입력은 반복하지 마세요") } else { e })?;
                // 고정 지연으로 성공을 추정하지 않는다. 현재 관찰을 반환하고 목표 확인은 별개로 표시한다.
                capture = x.capture(window).unwrap_or_else(
                    |_| json!({"window_id":format!("{window}"),"observe_again":true}),
                );
                capture["effect"] = json!("input_delivered_goal_unverified");
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
    struct ClientEvent {
        kind: c_int,
        serial: c_ulong,
        send_event: c_int,
        display: *mut Display,
        window: Window,
        message_type: c_ulong,
        format: c_int,
        data: [c_long; 5],
    }
    #[repr(C)]
    union Event {
        pad: [c_long; 24],
        client: ClientEvent,
    }
    fn unavailable() -> ToolError {
        ToolError::new(
            "display_unavailable",
            "X11 화면·창·권한을 확인하세요. 화면 없는 서버에서는 사용할 수 없습니다",
        )
    }
    pub(super) use bindings::execute;
}
