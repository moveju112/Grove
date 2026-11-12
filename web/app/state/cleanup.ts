// 로그인 종료 시 정리(UI-032).
// - 공통(로그아웃·만료): 메모리의 서버 상태 cache·중간 응답을 지운다. 다음 사용자가 이전 화면 데이터를 보지 않게 한다.
// - 사용자가 직접 로그아웃: 이 기기에 남긴 대화 내용(초안 사본)·배치(프로젝트·대화 ID)·전송 옵션·숨긴 봇도 지운다.
// - 만료: 다시 로그인해 이어 쓰도록 기기 내 사본은 남긴다.
// 기기 ID와 표시 설정(테마·글자 크기)은 민감 정보가 아니고 기기 자체 설정이라 유지한다.

import { lastAuthEnd, onAuthChange } from "../api/client";
import { clearServerCache } from "./store";

/// 로그아웃 때 지우는 localStorage key 접두사.
export const SENSITIVE_PREFIXES = ["grove.draft.", "grove.file.", "grove.layout.", "grove.script.", "grove.composer.options", "grove.bots.hidden"];

export function clearDeviceCopies(storage: Storage) {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && SENSITIVE_PREFIXES.some((p) => k.startsWith(p))) keys.push(k);
    }
    for (const k of keys) storage.removeItem(k);
}

let installed = false;

export function installAuthCleanup() {
    if (installed || typeof window === "undefined") return;
    installed = true;
    let wasIn = false;
    onAuthChange((s) => {
        if (s) {
            wasIn = true;
            return;
        }
        if (!wasIn) return;
        wasIn = false;
        clearServerCache();
        if (lastAuthEnd() === "logout") clearDeviceCopies(localStorage);
        sessionStorage.clear();
    });
}
