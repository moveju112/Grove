import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiCall, login, state } from "./helpers";

async function openGit(page: Page, staged: boolean) {
    const root=mkdtempSync(join(dirname(state().projA),"git-recovery-"));
    const run=(...args:string[])=>execFileSync("git",args,{cwd:root,encoding:"utf8"});
    run("init","-q","-b","main");
    run("config","user.email","e2e@example.invalid");
    run("config","user.name","E2E");
    writeFileSync(join(root,"a.txt"),"before\n");
    run("add","a.txt");
    run("commit","-qm","base");
    writeFileSync(join(root,"a.txt"),"first request\n");
    if (staged) run("add","a.txt");
    const project=await apiCall<{id:string;name:string}>("POST","/projects",{root_path:root});
    await login(page);
    await page.locator(".sidebar .projects").getByRole("button",{name:project.name,exact:true}).click();
    await page.locator(".git-wrap").locator("summary").first().click();
    const panel=page.getByTestId("git-panel");
    await expect(panel).toContainText(staged ? "커밋할 변경 (1)" : "작업 트리 변경 (1)");
    return {root,run,project,panel};
}

test("stage 응답 유실 뒤 상태와 파일이 바뀌어도 같은 요청 확인은 원래 key와 fingerprint로 재생한다",async({page})=>{
    const {root,run,project,panel}=await openGit(page,false);
    const requests:{key:string;body:Record<string,unknown>}[]=[];
    let lose=true;
    await page.route(`**/api/v1/projects/${project.id}/git/stage`,async(route)=>{
        if(route.request().method()!=="POST") return route.fallback();
        requests.push({key:route.request().headers()["idempotency-key"]??"",body:route.request().postDataJSON() as Record<string,unknown>});
        if(lose) { await route.fetch(); return route.abort("connectionreset"); }
        return route.fallback();
    });
    await panel.getByRole("button",{name:"올리기",exact:true}).click();
    await expect(panel.getByTestId("git-unsure")).toBeVisible();
    expect(run("show",":a.txt")).toBe("first request\n");
    writeFileSync(join(root,"a.txt"),"new unaccepted edit\n");
    const refreshed=page.waitForResponse((response)=>response.request().method()==="GET" && response.url().endsWith(`/projects/${project.id}/git/status`));
    await panel.getByRole("button",{name:"새로고침",exact:true}).click();
    const current=await (await refreshed).json() as {fingerprint:string};
    expect(requests).toHaveLength(1);
    expect(current.fingerprint).not.toBe(requests[0]!.body.expected_fingerprint);
    await expect(panel.getByRole("button",{name:"올리기",exact:true})).toBeDisabled();
    lose=false;
    const replay=page.waitForResponse((response)=>response.request().method()==="POST" && response.url().endsWith(`/projects/${project.id}/git/stage`));
    await panel.getByRole("button",{name:"같은 Git 요청 확인",exact:true}).click();
    const confirmed=await replay;
    expect(confirmed.status()).toBe(200);
    expect(confirmed.headers()["idempotent-replayed"]).toBe("true");
    await expect(panel.getByTestId("git-unsure")).toHaveCount(0);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.key).toBeTruthy();
    expect(requests[1]).toEqual(requests[0]);
    expect(run("show",":a.txt")).toBe("first request\n");
    expect(readFileSync(join(root,"a.txt"),"utf8")).toBe("new unaccepted edit\n");
});

test("커밋 이중 submit과 응답 유실은 커밋을 한 번만 만들고 재확인 중 새 메시지 입력을 지우지 않는다",async({page})=>{
    const {run,project,panel}=await openGit(page,true);
    const requests:{key:string;body:Record<string,unknown>}[]=[];
    let lose=true;
    await page.route(`**/api/v1/projects/${project.id}/git/commit`,async(route)=>{
        requests.push({key:route.request().headers()["idempotency-key"]??"",body:route.request().postDataJSON() as Record<string,unknown>});
        if(lose) { await route.fetch(); return route.abort("connectionreset"); }
        return route.fallback();
    });
    await panel.getByLabel("커밋 메시지").fill("원래 커밋");
    await panel.locator("form").evaluate((form)=>{
        form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));
        form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));
    });
    await expect(panel.getByTestId("git-unsure")).toBeVisible();
    await panel.getByLabel("커밋 메시지").fill("다음 커밋 초안");
    await panel.getByTestId("git-unsure").locator("summary").click();
    await expect(panel.getByTestId("git-unsure")).toContainText("원래 커밋");
    expect(requests).toHaveLength(1);
    expect(run("rev-list","--count","HEAD").trim()).toBe("2");
    lose=false;
    const replay=page.waitForResponse((response)=>response.request().method()==="POST" && response.url().endsWith(`/projects/${project.id}/git/commit`));
    await panel.getByRole("button",{name:"같은 Git 요청 확인",exact:true}).click();
    const confirmed=await replay;
    expect(confirmed.status()).toBe(200);
    expect(confirmed.headers()["idempotent-replayed"]).toBe("true");
    await expect(panel.getByTestId("git-unsure")).toHaveCount(0);
    await expect(panel.getByLabel("커밋 메시지")).toHaveValue("다음 커밋 초안");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(run("rev-list","--count","HEAD").trim()).toBe("2");
    expect(run("log","-1","--format=%s").trim()).toBe("원래 커밋");
});

test("응답 유실 뒤 저장소를 조회할 수 없어도 원래 요청을 재확인하고 새 초안을 복원한다",async({page})=>{
    const {root,run,project,panel}=await openGit(page,true);
    const keys:string[]=[];
    let lose=true;
    await page.route(`**/api/v1/projects/${project.id}/git/commit`,async(route)=>{
        keys.push(route.request().headers()["idempotency-key"]??"");
        if(lose) { await route.fetch(); return route.abort("connectionreset"); }
        return route.fallback();
    });
    await panel.getByLabel("커밋 메시지").fill("조회 중단 전 커밋");
    await panel.getByRole("button",{name:"커밋",exact:true}).click();
    await expect(panel.getByTestId("git-unsure")).toBeVisible();
    await panel.getByLabel("커밋 메시지").fill("보존할 다음 초안");
    const gitPath=join(root,".git");
    const hidden=join(root,".git.after-fixture");
    renameSync(gitPath,hidden);
    try {
        const refreshed=page.waitForResponse((response)=>response.request().method()==="GET" && response.url().endsWith(`/projects/${project.id}/git/status`));
        await panel.getByRole("button",{name:"새로고침",exact:true}).click();
        expect((await (await refreshed).json() as {is_repo:boolean}).is_repo).toBe(false);
        await expect(panel).toContainText("Git 저장소가 아닙니다");
        await expect(panel.getByTestId("git-unsure")).toBeVisible();
        lose=false;
        const replay=page.waitForResponse((response)=>response.request().method()==="POST" && response.url().endsWith(`/projects/${project.id}/git/commit`));
        await panel.getByRole("button",{name:"같은 Git 요청 확인",exact:true}).click();
        const confirmed=await replay;
        expect(confirmed.status()).toBe(200);
        expect(confirmed.headers()["idempotent-replayed"]).toBe("true");
        await expect(panel.getByTestId("git-unsure")).toHaveCount(0);
    } finally {
        renameSync(hidden,gitPath);
    }
    await panel.getByRole("button",{name:/^(새로고침|상태 다시 확인)$/}).click();
    await expect(panel.getByLabel("커밋 메시지")).toHaveValue("보존할 다음 초안");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(run("rev-list","--count","HEAD").trim()).toBe("2");
});
