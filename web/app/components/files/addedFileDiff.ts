// Git diff에 포함되지 않는 untracked 파일도 빈 파일과 비교한 unified diff로 표시한다.
export function addedFileDiff(path: string, text: string): string {
    const header = `diff --git a/${path} b/${path}\nnew file mode 100644\n`;
    if (!text) return header;
    const newline = text.endsWith("\n");
    const lines = text.split("\n");
    if (newline) lines.pop();
    return header + `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n`
        + lines.map((line) => `+${line}\n`).join("")
        + (newline ? "" : "\\ No newline at end of file\n");
}
