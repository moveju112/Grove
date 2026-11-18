//! Windows 전용 창 캡처·메시지 입력. SendInput·물리 포인터·권한 상승을 사용하지 않는다.
use crate::tools::{ToolError, ToolResult};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{ffi::OsString, mem::{size_of, zeroed}, os::windows::ffi::OsStringExt, ptr, thread, time::{Duration, Instant}};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, HWND, INVALID_HANDLE_VALUE, LPARAM, POINT, RECT},
    Graphics::Gdi::*,
    Storage::Xps::{PrintWindow, PW_CLIENTONLY},
    System::{
        Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS},
        StationsAndDesktops::*,
        RemoteDesktop::ProcessIdToSessionId,
        SystemServices::{MK_LBUTTON,MK_RBUTTON},
        Threading::{GetCurrentProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW},
    },
    UI::{
        HiDpi::{DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE, SetThreadDpiAwarenessContext},
        Input::KeyboardAndMouse::{GetAsyncKeyState, MapVirtualKeyW, MAPVK_VK_TO_VSC, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_HOME, VK_LBUTTON, VK_LEFT, VK_LWIN, VK_MBUTTON, VK_MENU, VK_RBUTTON, VK_RETURN, VK_RIGHT, VK_RWIN, VK_SHIFT, VK_TAB, VK_UP},
        WindowsAndMessaging::*,
    },
};

fn unavailable()->ToolError {
    ToolError::new("display_unavailable","Windows의 로그인된 사용자 화면과 대상 창을 확인하세요. 서비스 Session 0·잠금 화면·다른 권한의 앱은 제어하지 않습니다")
}

struct Handle(HANDLE);
impl Drop for Handle { fn drop(&mut self){unsafe{CloseHandle(self.0);}} }

/// 명령행·자격을 읽지 않고 worker의 부모 실행 파일만 확인한다.
pub(super) fn verify_parent()->ToolResult<()> {
    let denied=||ToolError::new("computer_permission_denied","승인된 Grove 서버의 화면 제어 요청만 실행할 수 있습니다");
    unsafe {
        let snapshot=CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0);
        if snapshot==INVALID_HANDLE_VALUE{return Err(denied());}
        let snapshot=Handle(snapshot);
        let mut entry:PROCESSENTRY32W=zeroed();
        entry.dwSize=size_of::<PROCESSENTRY32W>() as u32;
        let mut found=Process32FirstW(snapshot.0,&mut entry)!=0;
        let own=GetCurrentProcessId();
        let mut parent=0;
        while found {
            if entry.th32ProcessID==own {parent=entry.th32ParentProcessID;break;}
            found=Process32NextW(snapshot.0,&mut entry)!=0;
        }
        if parent==0{return Err(denied());}
        let process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,0,parent);
        if process.is_null(){return Err(denied());}
        let process=Handle(process);
        let mut path=vec![0u16;32768];
        let mut length=path.len() as u32;
        if QueryFullProcessImageNameW(process.0,0,path.as_mut_ptr(),&mut length)==0{return Err(denied());}
        let parent=std::path::PathBuf::from(OsString::from_wide(&path[..length as usize]));
        let own=std::env::current_exe().and_then(std::fs::canonicalize).map_err(|_|denied())?;
        if std::fs::canonicalize(parent).map_err(|_|denied())?!=own{return Err(denied());}
    }
    Ok(())
}

/// 서비스·다른 사용자의 desktop으로 연결하거나 잠금 화면을 열지 않는다.
pub(super) fn desktop_session_present()->bool {
    unsafe {
        let mut session=0;
        if ProcessIdToSessionId(GetCurrentProcessId(),&mut session)==0||session==0{return false;}
        let station=GetProcessWindowStation();
        if station.is_null(){return false;}
        let mut flags:USEROBJECTFLAGS=zeroed();
        let mut needed=0;
        if GetUserObjectInformationW(station,UOI_FLAGS,(&mut flags as *mut USEROBJECTFLAGS).cast(),size_of::<USEROBJECTFLAGS>() as u32,&mut needed)==0
            || flags.dwFlags & WSF_VISIBLE as u32 ==0 {return false;}
        let desktop=OpenInputDesktop(0,0,DESKTOP_READOBJECTS);
        if desktop.is_null(){return false;}
        // Input desktop이 잠금/보안 desktop이면 접근 가능하더라도 사용하지 않는다.
        let mut name=[0u16;256];
        let ok=GetUserObjectInformationW(desktop,UOI_NAME,name.as_mut_ptr().cast(),(name.len()*2) as u32,&mut needed)!=0;
        CloseDesktop(desktop);
        let end=name.iter().position(|v|*v==0).unwrap_or(name.len());
        ok&&String::from_utf16_lossy(&name[..end]).eq_ignore_ascii_case("default")
    }
}

struct Dpi(DPI_AWARENESS_CONTEXT);
impl Dpi {
    fn enter()->ToolResult<Self>{
        // UI를 만들지 않는 worker에는 물리 픽셀 좌표만 필요하다. v2 전용 메뉴·대화상자 scaling은 요구하지 않는다.
        let previous=unsafe{SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE)};
        if previous.is_null(){return Err(unavailable());}
        Ok(Self(previous))
    }
}
impl Drop for Dpi {fn drop(&mut self){unsafe{SetThreadDpiAwarenessContext(self.0);}}}

fn id(window:HWND)->String {format!("hwnd:0x{:x}",window as usize)}
fn parse_id(value:&Value)->ToolResult<HWND>{
    value.as_str().and_then(|s|s.strip_prefix("hwnd:0x"))
        .and_then(|s|usize::from_str_radix(s,16).ok()).filter(|v|*v!=0)
        .map(|v|v as HWND).ok_or_else(unavailable)
}

unsafe extern "system" fn enumerate(window:HWND,context:LPARAM)->i32 {
    unsafe {
        let items=&mut *(context as *mut Vec<Value>);
        if items.len()>=128{return 0;}
        if IsWindowVisible(window)==0{return 1;}
        let mut pid=0;
        GetWindowThreadProcessId(window,&mut pid);
        if pid==0{return 1;}
        let mut title=[0u16;513];
        let len=GetWindowTextW(window,title.as_mut_ptr(),title.len() as i32).max(0) as usize;
        items.push(json!({"window_id":id(window),"pid":pid,"title":String::from_utf16_lossy(&title[..len]),
            "active":GetForegroundWindow()==window,"minimized":IsIconic(window)!=0}));
        1
    }
}

fn require_idle()->ToolResult<()> {
    if [VK_LBUTTON,VK_RBUTTON,VK_MBUTTON,VK_SHIFT,VK_CONTROL,VK_MENU,VK_LWIN,VK_RWIN].iter()
        .any(|key|unsafe{GetAsyncKeyState(*key as i32)}<0) {
        return Err(ToolError::new("focus_required","사용자가 키·마우스 버튼을 놓은 뒤 다시 관찰하세요"));
    }
    Ok(())
}

fn focus(window:HWND)->ToolResult<Value> {
    unsafe {
        if !desktop_session_present()||IsWindowVisible(window)==0||GetAncestor(window,GA_ROOT)!=window{return Err(unavailable());}
        require_idle()?;
        if GetForegroundWindow()!=window {
            if IsIconic(window)!=0 {ShowWindowAsync(window,SW_RESTORE);}
            // OS의 foreground 제한을 우회하거나 전역 키 입력을 보내지 않는다.
            SetForegroundWindow(window);
            let deadline=Instant::now()+Duration::from_millis(750);
            while GetForegroundWindow()!=window||IsIconic(window)!=0 {
                if Instant::now()>=deadline {
                    return Err(ToolError::new("focus_required","Windows가 창을 활성화하지 않았습니다. 사용자가 대상 창을 활성화해야 합니다"));
                }
                thread::sleep(Duration::from_millis(20));
            }
        }
    }
    Ok(json!({"window_id":id(window),"active":true}))
}

fn state(window:HWND)->ToolResult<Value>{
    unsafe {
        if !desktop_session_present(){return Err(unavailable());}
        if IsWindow(window)==0||IsWindowVisible(window)==0||IsIconic(window)!=0{return Err(unavailable());}
        if GetForegroundWindow()!=window{return Err(ToolError::new("focus_required","대상 Windows 창에 focus를 실행한 뒤 다시 capture하세요"));}
        require_idle()?;
        let mut pid=0;
        let thread=GetWindowThreadProcessId(window,&mut pid);
        if pid==0||thread==0{return Err(unavailable());}
        let mut rect:RECT=zeroed();
        let mut origin=POINT{x:0,y:0};
        let mut pointer:POINT=zeroed();
        let mut gui:GUITHREADINFO=zeroed();gui.cbSize=size_of::<GUITHREADINFO>() as u32;
        if GetClientRect(window,&mut rect)==0||ClientToScreen(window,&mut origin)==0
            ||GetCursorPos(&mut pointer)==0||GetGUIThreadInfo(thread,&mut gui)==0{return Err(unavailable());}
        if gui.flags & (GUI_INMENUMODE|GUI_POPUPMENUMODE|GUI_SYSTEMMENUMODE)!=0 {
            return Err(ToolError::new("focus_required","메뉴가 열려 있습니다. 사용자가 메뉴를 닫은 뒤 대상 창을 다시 관찰하세요"));
        }
        let w=rect.right-rect.left;let h=rect.bottom-rect.top;
        if !(1..=4096).contains(&w)||!(1..=4096).contains(&h){return Err(ToolError::new("computer_unavailable","창의 가로·세로 크기는 1~4096픽셀이어야 합니다"));}
        Ok(json!({"window_id":id(window),"pid":pid,"native_width":w,"native_height":h,
            "pointer":[pointer.x,pointer.y],"geometry":[origin.x,origin.y,w,h],"focus_window":id(gui.hwndFocus)}))
    }
}

struct Surface {window:HWND,source:HDC,dc:HDC,bitmap:HBITMAP,previous:HGDIOBJ}
impl Surface {
    fn new(window:HWND,w:i32,h:i32)->ToolResult<(Self,*mut u8)>{
        unsafe {
            let mut value=Self{window,source:GetDC(window),dc:ptr::null_mut(),bitmap:ptr::null_mut(),previous:ptr::null_mut()};
            if value.source.is_null(){return Err(unavailable());}
            value.dc=CreateCompatibleDC(value.source);
            if value.dc.is_null(){return Err(unavailable());}
            let mut info:BITMAPINFO=zeroed();
            info.bmiHeader.biSize=size_of::<BITMAPINFOHEADER>() as u32;
            info.bmiHeader.biWidth=w;info.bmiHeader.biHeight=-h;
            info.bmiHeader.biPlanes=1;info.bmiHeader.biBitCount=32;info.bmiHeader.biCompression=BI_RGB;
            let mut pixels=ptr::null_mut();
            value.bitmap=CreateDIBSection(value.source,&info,DIB_RGB_COLORS,&mut pixels,ptr::null_mut(),0);
            if value.bitmap.is_null()||pixels.is_null(){return Err(unavailable());}
            value.previous=SelectObject(value.dc,value.bitmap);
            if value.previous.is_null()||value.previous as isize == -1 {value.previous=ptr::null_mut();return Err(unavailable());}
            // 캡처 API가 성공만 반환하고 아무것도 그리지 않는 경우를 구별한다.
            ptr::write_bytes(pixels,0xa5,w as usize*h as usize*4);
            Ok((value,pixels.cast()))
        }
    }
}
impl Drop for Surface {
    fn drop(&mut self){unsafe{
        if !self.previous.is_null(){SelectObject(self.dc,self.previous);}
        if !self.bitmap.is_null(){DeleteObject(self.bitmap);}
        if !self.dc.is_null(){DeleteDC(self.dc);}
        if !self.source.is_null(){ReleaseDC(self.window,self.source);}
    }}
}

fn capture(window:HWND)->ToolResult<Value>{
    let original=state(window)?;
    let w=original["native_width"].as_u64().unwrap() as u32;
    let h=original["native_height"].as_u64().unwrap() as u32;
    let (surface,pixels)=Surface::new(window,w as i32,h as i32)?;
    // PW_RENDERFULLCONTENT=2. 공유 desktop을 잘라 찍는 방식으로 대체하지 않는다.
    if unsafe{PrintWindow(window,surface.dc,PW_CLIENTONLY|2)}==0{return Err(ToolError::new("computer_unavailable","이 Windows 앱이 창 캡처를 제공하지 않습니다"));}
    // DIB 포인터를 읽기 전에 GDI의 그리기 완료를 동기화한다.
    if unsafe{GdiFlush()}==0{return Err(unavailable());}
    let bytes=unsafe{std::slice::from_raw_parts(pixels,w as usize*h as usize*4)};
    if bytes.iter().all(|byte|*byte==0xa5){return Err(ToolError::new("computer_unavailable","이 Windows 앱 또는 실행 환경이 창 화면을 그리지 않았습니다"));}
    let mut rgb=Vec::with_capacity(w as usize*h as usize*3);
    for pixel in bytes.chunks_exact(4){rgb.extend_from_slice(&[pixel[2],pixel[1],pixel[0]]);}
    let image=image::DynamicImage::ImageRgb8(image::RgbImage::from_raw(w,h,rgb).ok_or_else(unavailable)?);
    let image=if w>1280||h>1280{image.resize(1280,1280,image::imageops::FilterType::Triangle)}else{image};
    let mut jpeg=vec![];
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg,85).encode_image(&image).map_err(|_|unavailable())?;
    if state(window)?!=original{return Err(ToolError::new("stale_frame","캡처 중 Windows 창·포커스·포인터가 변경됐습니다"));}
    let mut result=original;
    result["width"]=json!(image.width());result["height"]=json!(image.height());
    result["pixels_sha256"]=json!(crate::util::sha256_hex(&jpeg));result["jpeg"]=json!(STANDARD.encode(jpeg));
    Ok(result)
}

fn send(window:HWND,message:u32,wparam:usize,lparam:isize)->ToolResult<()> {
    let mut result=0;
    if unsafe{SendMessageTimeoutW(window,message,wparam,lparam,SMTO_ABORTIFHUNG|SMTO_BLOCK,500,&mut result)}==0 {
        return Err(ToolError::new("result_unknown","Windows 메시지 전달을 확인하지 못했습니다. 권한 상승·다른 입력 방식으로 재시도하지 마세요"));
    }
    Ok(())
}

fn coordinate(x:i32,y:i32)->isize {((x as u16 as u32)|((y as u16 as u32)<<16)) as i32 as isize}

fn child_at(window:HWND,x:i32,y:i32)->ToolResult<(HWND,POINT)> {
    let mut target=window;
    let mut point=POINT{x,y};
    unsafe {
        for _ in 0..32 {
            let child=ChildWindowFromPointEx(target,point,CWP_SKIPDISABLED|CWP_SKIPINVISIBLE|CWP_SKIPTRANSPARENT);
            if child.is_null()||child==target{break;}
            if IsChild(window,child)==0{return Err(unavailable());}
            if ClientToScreen(target,&mut point)==0||ScreenToClient(child,&mut point)==0{return Err(unavailable());}
            target=child;
        }
    }
    same_process(window,target)?;
    Ok((target,point))
}

fn same_process(window:HWND,target:HWND)->ToolResult<()> {
    unsafe {
        let(mut owner,mut receiver)=(0,0);
        GetWindowThreadProcessId(window,&mut owner);GetWindowThreadProcessId(target,&mut receiver);
        if owner==0||owner!=receiver||(target!=window&&IsChild(window,target)==0){return Err(unavailable());}
    }
    Ok(())
}

fn keyboard_target(window:HWND)->ToolResult<HWND>{
    unsafe {
        let thread=GetWindowThreadProcessId(window,ptr::null_mut());
        let mut gui:GUITHREADINFO=zeroed();gui.cbSize=size_of::<GUITHREADINFO>() as u32;
        if GetGUIThreadInfo(thread,&mut gui)==0||gui.hwndFocus.is_null(){return Err(unavailable());}
        same_process(window,gui.hwndFocus)?;
        Ok(gui.hwndFocus)
    }
}

fn deliver(window:HWND,observation:&Value,steps:&[Value])->ToolResult<()>{
    let mut expected=observation.clone();
    for key in ["width","height","pixels_sha256","focus_window"] {expected.as_object_mut().unwrap().remove(key);}
    for step in steps {
        let mut current=state(window)?;
        current.as_object_mut().unwrap().remove("focus_window");
        if current!=expected{return Err(ToolError::new("result_unknown","사용자 입력이나 Windows 창 전환으로 멈췄습니다"));}
        match step["type"].as_str().unwrap_or("") {
            "click"|"scroll"=>{
                let x=step["x"].as_u64().ok_or_else(unavailable)?;
                let y=step["y"].as_u64().ok_or_else(unavailable)?;
                let w=observation["width"].as_u64().unwrap();let h=observation["height"].as_u64().unwrap();
                if x>=w||y>=h{return Err(unavailable());}
                let x=(x*observation["native_width"].as_u64().unwrap()/w) as i32;
                let y=(y*observation["native_height"].as_u64().unwrap()/h) as i32;
                let (target,point)=child_at(window,x,y)?;
                if step["type"]=="scroll" {
                    let mut screen=point;
                    if unsafe{ClientToScreen(target,&mut screen)}==0{return Err(unavailable());}
                    let delta=if step["direction"]=="up"{120i32}else{-120};
                    for _ in 0..step["amount"].as_u64().unwrap_or(1) {
                        send(target,WM_MOUSEWHEEL,(delta as u16 as usize)<<16,coordinate(screen.x,screen.y))?;
                    }
                } else {
                    let right=step["button"]=="right";
                    send(target,if right{WM_RBUTTONDOWN}else{WM_LBUTTONDOWN},if right{MK_RBUTTON as usize}else{MK_LBUTTON as usize},coordinate(point.x,point.y))?;
                    send(target,if right{WM_RBUTTONUP}else{WM_LBUTTONUP},0,coordinate(point.x,point.y))?;
                }
            },
            "type"=>{
                let target=keyboard_target(window)?;
                for unit in step["text"].as_str().ok_or_else(unavailable)?.encode_utf16(){send(target,WM_CHAR,unit as usize,1)?;}
            },
            "key"=>{
                let target=keyboard_target(window)?;
                let key=match step["key"].as_str().unwrap_or("") {
                    "Enter"=>VK_RETURN,"Tab"=>VK_TAB,"Escape"=>VK_ESCAPE,"Backspace"=>VK_BACK,"Delete"=>VK_DELETE,
                    "Left"=>VK_LEFT,"Right"=>VK_RIGHT,"Up"=>VK_UP,"Down"=>VK_DOWN,"Home"=>VK_HOME,"End"=>VK_END,_=>return Err(unavailable()),
                };
                let scan=unsafe{MapVirtualKeyW(key as u32,MAPVK_VK_TO_VSC)};
                let extended=matches!(key,VK_DELETE|VK_LEFT|VK_RIGHT|VK_UP|VK_DOWN|VK_HOME|VK_END);
                let param=1|((scan as isize)<<16)|if extended{1<<24}else{0};
                send(target,WM_KEYDOWN,key as usize,param)?;
                if matches!(key,VK_RETURN|VK_TAB|VK_BACK|VK_ESCAPE){send(target,WM_CHAR,key as usize,param)?;}
                send(target,WM_KEYUP,key as usize,param|(1<<30)|(1usize<<31) as isize)?;
            },
            _=>return Err(unavailable()),
        }
    }
    Ok(())
}

pub(super) fn execute(command:&Value)->ToolResult<Value>{
    let _dpi=Dpi::enter()?;
    if !desktop_session_present(){return Err(unavailable());}
    if command["action"]=="list" {
        let mut windows:Vec<Value>=vec![];
        unsafe{EnumWindows(Some(enumerate),(&mut windows as *mut Vec<Value>) as isize);}
        return Ok(json!({"target":"server","platform":"windows","windows":windows,"delivery":"window_messages",
            "limitations":"Windows interactive desktop; focus inactive windows before capture; OS may deny focus; some apps reject window messages; no elevation or physical input fallback"}));
    }
    let window=parse_id(&command["window_id"])?;
    if command["action"]=="focus" {return focus(window);}
    let mut result=capture(window)?;
    if command["action"]=="act" {
        let mut observed=result.clone();observed.as_object_mut().unwrap().remove("jpeg");
        let mut expected=command["expected"].clone();
        for key in ["image_sha256","effect"]{expected.as_object_mut().ok_or_else(unavailable)?.remove(key);}
        if observed!=expected{return Err(ToolError::new("stale_frame","Windows 창·픽셀·포커스·포인터가 관찰 뒤 변경돼 입력하지 않았습니다"));}
        deliver(window,&observed,command["actions"].as_array().ok_or_else(unavailable)?)
            .map_err(|_|ToolError::new("result_unknown","Windows 입력이 일부 전달됐을 수 있습니다. 새 상태를 확인하고 입력은 반복하지 마세요"))?;
        result=capture(window).map_err(|_|ToolError::new("result_unknown","Windows 입력 후 화면을 확인하지 못했습니다. 입력을 반복하지 마세요"))?;
        result["effect"]=json!("messages_delivered_goal_unverified");
    }
    Ok(result)
}
