export type Permission = PermissionState | "unknown" | "per-use" | "not-required";
export type CapabilityId = "notifications" | "clipboard-read" | "clipboard-write" | "file-select" | "file-drop" | "file-open" | "file-save" | "directory";
export type BrowserCapability = {
    id: CapabilityId;
    label: string;
    supported: boolean;
    secureRequired: boolean;
    permission: Permission;
    alternative: string;
};
export type BrowserCapabilities = { secureContext: boolean; items: BrowserCapability[] };
export type BrowserEnvironment = {
    secureContext: boolean;
    notification?: Pick<typeof Notification, "permission" | "requestPermission">;
    clipboard?: Partial<Pick<Clipboard, "readText" | "writeText">>;
    permissions?: Pick<Permissions, "query">;
    fileSelect: boolean;
    fileDrop: boolean;
    fileOpen: boolean;
    fileSave: boolean;
    directory: boolean;
};

export function browserEnvironment(): BrowserEnvironment {
    if (typeof window === "undefined") return {
        secureContext: false, fileSelect: false, fileDrop: false, fileOpen: false, fileSave: false, directory: false,
    };
    const input = document.createElement("input");
    input.type = "file";
    const readableFile = typeof File !== "undefined" && typeof File.prototype.arrayBuffer === "function";
    const pickers = window as Window & {
        showOpenFilePicker?: unknown; showSaveFilePicker?: unknown; showDirectoryPicker?: unknown;
    };
    return {
        secureContext: window.isSecureContext,
        notification: typeof Notification === "undefined" ? undefined : Notification,
        clipboard: navigator.clipboard,
        permissions: navigator.permissions,
        fileSelect: input.type === "file" && "files" in input && readableFile,
        fileDrop: readableFile && "ondrop" in document.documentElement && typeof DataTransfer !== "undefined" && "files" in DataTransfer.prototype,
        fileOpen: typeof pickers.showOpenFilePicker === "function",
        fileSave: typeof pickers.showSaveFilePicker === "function",
        directory: typeof pickers.showDirectoryPicker === "function",
    };
}

export const MANUAL_COPY = "메시지 원문을 선택한 뒤 Ctrl+C / ⌘C 또는 길게 눌러 복사하세요.";
export const FILE_ALTERNATIVE = "일반 파일 첨부를 사용하세요. 선택도 지원하지 않으면 파일 내용을 메시지에 붙여 넣거나 지원 브라우저에서 첨부하세요.";
export const NOTIFICATION_ALTERNATIVE = "앱의 알림 목록·대화 상태를 확인하세요. 알림 소리는 별도로 켤 수 있습니다.";

export function detectBrowserCapabilities(env: BrowserEnvironment = browserEnvironment()): BrowserCapabilities {
    const notification = env.notification?.permission;
    return { secureContext: env.secureContext, items: [
        { id: "notifications", label: "브라우저 알림", supported: !!env.notification && typeof env.notification.requestPermission === "function", secureRequired: true,
            permission: notification === "default" ? "prompt" : notification ?? "unknown", alternative: NOTIFICATION_ALTERNATIVE },
        { id: "clipboard-read", label: "Clipboard 읽기", supported: typeof env.clipboard?.readText === "function", secureRequired: true,
            permission: "unknown", alternative: "메시지 입력란에서 Ctrl+V / ⌘V 또는 붙여넣기 메뉴를 사용하세요." },
        { id: "clipboard-write", label: "Clipboard 쓰기", supported: typeof env.clipboard?.writeText === "function", secureRequired: true,
            permission: "unknown", alternative: MANUAL_COPY },
        { id: "file-select", label: "파일 선택·첨부", supported: env.fileSelect, secureRequired: false,
            permission: "per-use", alternative: "파일 내용을 메시지에 붙여 넣거나 지원 브라우저에서 첨부하세요." },
        { id: "file-drop", label: "파일 드래그", supported: env.fileDrop, secureRequired: false,
            permission: "not-required", alternative: "드래그 대신 파일 첨부 버튼을 사용하세요. 터치 기기의 실제 드래그 지원은 다를 수 있습니다." },
        { id: "file-open", label: "파일 시스템: 열기", supported: env.fileOpen, secureRequired: true,
            permission: "per-use", alternative: FILE_ALTERNATIVE },
        { id: "file-save", label: "파일 시스템: 저장", supported: env.fileSave, secureRequired: true,
            permission: "per-use", alternative: "앱의 원문 다운로드로 저장하세요. 저장 위치는 브라우저 설정을 따릅니다." },
        { id: "directory", label: "파일 시스템: 폴더 접근", supported: env.directory, secureRequired: true,
            permission: "per-use", alternative: "폴더 접근 대신 필요한 파일을 개별 첨부하세요." },
    ] };
}

// query는 권한을 요청하지 않는다. 조회 미지원은 거부가 아니라 미확인이다.
export function observeBrowserCapabilities(env: BrowserEnvironment, publish: (value: BrowserCapabilities) => void): () => void {
    let snapshot = detectBrowserCapabilities(env);
    let disposed = false;
    const cleanups: (() => void)[] = [];
    publish(snapshot);
    if (env.secureContext && env.permissions) {
        for (const id of ["notifications", "clipboard-read", "clipboard-write"] as const) {
            if (!snapshot.items.find((item) => item.id === id)!.supported) continue;
            void env.permissions.query({ name: id as PermissionName }).then((status) => {
                if (disposed) return;
                const update = () => {
                    if (disposed) return;
                    snapshot = { ...snapshot, items: snapshot.items.map((item) => item.id === id ? { ...item, permission: status.state } : item) };
                    publish(snapshot);
                };
                update();
                status.addEventListener("change", update);
                cleanups.push(() => status.removeEventListener("change", update));
            }).catch(() => { /* 이 permission descriptor를 조회하지 못하는 브라우저도 있다. */ });
        }
    }
    return () => { disposed = true; cleanups.forEach((cleanup) => cleanup()); };
}

export const PERMISSION_LABEL: Record<Permission, string> = {
    granted: "허용", denied: "거부", prompt: "미결정", unknown: "조회 불가·미확인",
    "per-use": "선택한 파일·폴더마다 확인", "not-required": "별도 사이트 권한 없음",
};

export function capabilityIssue(snapshot: BrowserCapabilities, item: BrowserCapability): string | null {
    if (item.secureRequired && !snapshot.secureContext) return `보안 컨텍스트가 아닙니다. HTTPS 또는 localhost로 접속하세요. ${item.alternative}`;
    if (!item.supported) return `이 브라우저는 이 API를 지원하지 않습니다. ${item.alternative}`;
    if (item.permission === "denied") return `권한이 거부됐습니다. 브라우저 사이트 설정에서 권한을 변경할 수 있습니다. ${item.alternative}`;
    return null;
}

// 두 함수는 사용자 클릭 핸들러에서만 호출한다. await 전에 실제 API를 호출해 사용자 활성화를 보존한다.
export async function requestNotificationAccess(env: BrowserEnvironment = browserEnvironment()): Promise<{ permission?: NotificationPermission; message?: string }> {
    const snapshot = detectBrowserCapabilities(env);
    const item = snapshot.items.find((item) => item.id === "notifications")!;
    const issue = capabilityIssue(snapshot, item);
    if (issue) return { message: issue };
    if (env.notification!.permission === "granted") return { permission: "granted" };
    try {
        const permission = await env.notification!.requestPermission();
        return { permission, message: permission === "granted" ? undefined : NOTIFICATION_ALTERNATIVE };
    } catch {
        return { message: `브라우저 알림 권한을 요청하지 못했습니다. ${NOTIFICATION_ALTERNATIVE}` };
    }
}

export async function copyMessageText(text: string, env: BrowserEnvironment = browserEnvironment()): Promise<{ copied: boolean; message?: string }> {
    const snapshot = detectBrowserCapabilities(env);
    const item = snapshot.items.find((item) => item.id === "clipboard-write")!;
    const issue = capabilityIssue(snapshot, item);
    if (issue) return { copied: false, message: issue };
    try {
        await env.clipboard!.writeText!(text);
        return { copied: true };
    } catch {
        return { copied: false, message: `복사가 차단됐거나 실패했습니다. 권한·브라우저 정책을 확인하세요. ${MANUAL_COPY}` };
    }
}

export function attachmentIssue(env: BrowserEnvironment = browserEnvironment()): string | null {
    const snapshot = detectBrowserCapabilities(env);
    return capabilityIssue(snapshot, snapshot.items.find((item) => item.id === "file-select")!);
}
