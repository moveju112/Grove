// 입력창 slash command(UI-024). 일반 글과 명령을 구분하는 규칙은 이 파일 하나에 둔다.
// - "/이름 인자": 등록된 이름이면 명령. 대소문자 무시.
// - 등록되지 않은 "/xyz": 보내지 않는다(오타가 모델에 가지 않게). 글로 보내려면 "//"로 시작한다.
// - "//글": 앞의 "/" 하나를 떼고 일반 글로 보낸다.
// - 그 밖은 일반 글.

export type SlashCommand = { name: string; args?: string; description: string };
export type Parsed = { kind: "text"; text: string } | { kind: "command"; name: string; arg: string } | { kind: "unknown"; name: string };

export function parseSlash(input: string, names: string[]): Parsed {
    const t = input.trimStart();
    if (t.startsWith("//")) return { kind: "text", text: input.replace("//", "/") };
    const m = t.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
    if (!m) return { kind: "text", text: input };
    const name = m[1]!.toLowerCase();
    if (!names.includes(name)) return { kind: "unknown", name };
    return { kind: "command", name, arg: (m[2] ?? "").trim() };
}

/// "/"로 시작하고 아직 띄어쓰기 전이면, 입력한 앞부분으로 시작하는(없으면 포함하는) 명령 목록.
export function suggest(input: string, cmds: SlashCommand[]): SlashCommand[] {
    const m = input.match(/^\/([^\s/]*)$/);
    if (!m) return [];
    const q = m[1]!.toLowerCase();
    const starts = cmds.filter((c) => c.name.startsWith(q));
    return starts.length > 0 ? starts : cmds.filter((c) => c.name.includes(q) || c.description.includes(q));
}
