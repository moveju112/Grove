/* 격리 Windows/Wine용 실제 Win32 컨트롤. 임의 명령·실사용 창은 조작하지 않는다. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>

static HWND main_window, edit_window;
static WNDPROC edit_original;
static int clicks, wheel, keys, alternate;

static void paint(HWND window, HDC dc) {
    RECT rect;
    GetClientRect(window, &rect);
    HBRUSH brush = CreateSolidBrush(alternate ? RGB(153,51,102) : RGB(51,102,153));
    FillRect(dc, &rect, brush);
    DeleteObject(brush);
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, RGB(255,255,255));
    TextOutW(dc, 20, 20, L"Grove Windows fixture", 21);
}

static void state(void) {
    wchar_t text[1024];
    char utf8[4096];
    RECT rect;
    GetWindowTextW(edit_window, text, 1024);
    WideCharToMultiByte(CP_UTF8, 0, text, -1, utf8, sizeof(utf8), NULL, NULL);
    GetClientRect(main_window, &rect);
    printf("{\"window_id\":\"hwnd:0x%llx\",\"width\":%ld,\"height\":%ld,\"clicks\":%d,\"wheel\":%d,\"keys\":%d,\"text\":\"",
           (unsigned long long)(ULONG_PTR)main_window, rect.right, rect.bottom, clicks, wheel, keys);
    for (unsigned char *p = (unsigned char *)utf8; *p; p++) {
        if (*p == '\\' || *p == '"') putchar('\\');
        if (*p >= 32) putchar(*p);
    }
    printf("\"}\n");
    fflush(stdout);
}

static LRESULT CALLBACK edit_proc(HWND window, UINT message, WPARAM w, LPARAM l) {
    if (message == WM_LBUTTONUP) clicks++;
    if (message == WM_KEYDOWN) keys++;
    return CallWindowProcW(edit_original, window, message, w, l);
}

static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM w, LPARAM l) {
    if (message == WM_PAINT) {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(window, &ps);
        paint(window, dc);
        EndPaint(window, &ps);
        return 0;
    }
    if (message == WM_PRINTCLIENT) { paint(window, (HDC)w); return 0; }
    if (message == WM_LBUTTONUP) clicks++;
    if (message == WM_MOUSEWHEEL) { wheel += (SHORT)HIWORD(w); return 0; }
    if (message == WM_COMMAND && HIWORD(w) == EN_SETFOCUS) HideCaret(edit_window);
    if (message == WM_APP + 1) { state(); return 0; }
    if (message == WM_APP + 2) {
        alternate = !alternate;
        RedrawWindow(window, NULL, NULL, RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN);
        state(); return 0;
    }
    if (message == WM_APP + 3) {
        HWND other = CreateWindowExW(0, L"GroveComputerFixture", L"Grove other fixture",
                                    WS_OVERLAPPEDWINDOW, 550, 80, 200, 160, NULL, NULL, GetModuleHandleW(NULL), NULL);
        ShowWindow(other, SW_SHOW);
        SetForegroundWindow(other);
        SetActiveWindow(other);
        SetFocus(other);
        state(); return 0;
    }
    if (message == WM_CLOSE) { DestroyWindow(window); return 0; }
    if (message == WM_DESTROY && window == main_window) PostQuitMessage(0);
    return DefWindowProcW(window, message, w, l);
}

static DWORD WINAPI control(LPVOID ignored) {
    (void)ignored;
    char line[64];
    while (fgets(line, sizeof(line), stdin)) {
        UINT message = !strncmp(line, "repaint", 7) ? WM_APP + 2 :
                       !strncmp(line, "blur", 4) ? WM_APP + 3 :
                       !strncmp(line, "quit", 4) ? WM_CLOSE : WM_APP + 1;
        PostMessageW(main_window, message, 0, 0);
        if (message == WM_CLOSE) break;
    }
    return 0;
}

int wmain(void) {
    /* fixture 좌표도 worker와 같은 per-monitor 물리 픽셀 단위를 쓴다. */
    typedef HANDLE (WINAPI *SetDpi)(HANDLE);
    SetDpi set_dpi = (SetDpi)GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetThreadDpiAwarenessContext");
    if (!set_dpi((HANDLE)(LONG_PTR)-3)) return 6;
    HINSTANCE instance = GetModuleHandleW(NULL);
    WNDCLASSW cls = {0};
    cls.lpfnWndProc = window_proc;
    cls.hInstance = instance;
    cls.lpszClassName = L"GroveComputerFixture";
    if (!RegisterClassW(&cls)) return 2;
    main_window = CreateWindowExW(0, cls.lpszClassName, L"Grove Windows computer fixture",
                                 WS_OVERLAPPEDWINDOW, 50, 50, 500, 300, NULL, NULL, instance, NULL);
    if (!main_window) return 3;
    edit_window = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL,
                                 20, 70, 300, 40, main_window, (HMENU)1, instance, NULL);
    if (!edit_window) return 4;
    edit_original = (WNDPROC)SetWindowLongPtrW(edit_window, GWLP_WNDPROC, (LONG_PTR)edit_proc);
    ShowWindow(main_window, SW_SHOW);
    UpdateWindow(main_window);
    SetForegroundWindow(main_window);
    SetActiveWindow(main_window);
    SetFocus(main_window);
    state();
    HANDLE reader = CreateThread(NULL, 0, control, NULL, 0, NULL);
    if (!reader) return 5;
    CloseHandle(reader);
    MSG message;
    while (GetMessageW(&message, NULL, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    return 0;
}
