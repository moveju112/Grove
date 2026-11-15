import { Text as GroveText } from "@astryxdesign/core/Text";
import { Button as GroveButton } from "../design/Button";
import { useState } from "react";
import { api } from "../api/client";
import type { Label, Project } from "../api/generated";
import { UNLABELLED } from "../state/projectLabels";
import { invalidate, useQuery } from "../state/store";
import { ServerActionButton } from "./pwa/ServerActionButton";
import { TextInput } from "../design/Fields";
import { Select } from "../design/Select";

/// 작업공간(프로젝트) 고정·색상 라벨(PROJECT-008). 서버 팔레트(`src/labels.rs::COLORS`)와 같은 순서.
export const LABEL_COLORS: Record<string, [string, string]> = {
    violet: ["#7c3aed", "보라"], sky: ["#0284c7", "하늘"], emerald: ["#059669", "에메랄드"], orange: ["#ea580c", "주황"],
    pink: ["#db2777", "분홍"], indigo: ["#4f46e5", "남색"], teal: ["#0d9488", "청록"], red: ["#dc2626", "빨강"],
    amber: ["#d97706", "호박"], blue: ["#2563eb", "파랑"],
};
const NO_LABELS: Label[] = [];

export function useLabels(): Label[] {
    return useQuery<Label[]>("labels", () => api.get("/labels")).data ?? NO_LABELS;
}

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export function LabelChip({ label }: { label: Label }) {
    const color = LABEL_COLORS[label.color]?.[0] ?? "#666";
    return <GroveText type="inherit" color="inherit" className="label-chip" style={{ borderColor: color, color }} data-testid={`label-chip-${label.name}`}>{label.name}</GroveText>;
}

export function LabelChips({ project, labels }: { project: Project; labels: Label[] }) {
    const own = labels.filter((l) => project.labels.includes(l.id));
    if (own.length === 0) return null;
    return <GroveText type="inherit" color="inherit" className="label-chips">{own.map((l) => <LabelChip key={l.id} label={l} />)}</GroveText>;
}

function ColorPicker({ value, onChange, name }: { value: string; onChange: (c: string) => void; name: string }) {
    return <Select label="라벨 색" hideLabel htmlName={name} value={value} onChange={onChange}
        options={Object.entries(LABEL_COLORS).map(([key, [, title]]) => ({ value: key, label: title }))} />;
}

/// 프로젝트 행 메뉴: 고정 전환과 라벨 할당·새 라벨 만들기. 실패하면 입력·선택을 보존하고 오류를 보인다.
export function ProjectMenu({ project, labels, onClose, onSplit }: { project: Project; labels: Label[]; onClose: () => void; onSplit?: (how: "right" | "down") => void }) {
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [creating, setCreating] = useState<{ name: string; color: string } | null>(null);
    const run = async (fn: () => Promise<unknown>, fallback: string) => {
        setBusy(true);
        setError(null);
        try {
            await fn();
            invalidate("projects");
            invalidate("labels");
            return true;
        } catch (e) {
            setError(message(e, fallback));
            return false;
        } finally {
            setBusy(false);
        }
    };
    return <div className="project-menu" role="dialog" aria-label={`${project.name} 메뉴`}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        {onSplit && <>
            <GroveButton type="button" className="ghost small" onClick={() => { onSplit("right"); onClose(); }}>오른쪽에 열기</GroveButton>
            <GroveButton type="button" className="ghost small" onClick={() => { onSplit("down"); onClose(); }}>아래에 열기</GroveButton>
        </>}
        <ServerActionButton type="button" className="ghost small" disabled={busy}
            onClick={() => void run(() => api.patch(`/projects/${project.id}`, { expected_revision: project.revision, pinned: !project.pinned_at }), "고정 변경 실패")}>
            {project.pinned_at ? "고정 해제" : "맨 위에 고정"}
        </ServerActionButton>
        {!creating && <>
            <div role="group" aria-label="라벨">
                {labels.map((l) => {
                    const on = project.labels.includes(l.id);
                    return <ServerActionButton key={l.id} type="button" role="menuitemcheckbox" aria-checked={on} className="ghost small label-row" disabled={busy}
                        data-testid={`label-assign-${l.name}`}
                        onClick={() => void run(() => api.put(`/projects/${project.id}/labels/${l.id}`, { assigned: !on }), "라벨 변경 실패")}>
                        {on ? "☑" : "☐"} <LabelChip label={l} />
                    </ServerActionButton>;
                })}
            </div>
            <GroveButton type="button" className="ghost small" onClick={() => { setCreating({ name: "", color: "violet" }); setError(null); }}>+ 새 라벨</GroveButton>
        </>}
        {creating && <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => api.post("/labels", { name: creating.name, color: creating.color, project_id: project.id }), "라벨 만들기 실패")) setCreating(null);
        }}>
            <TextInput size="sm" label="새 라벨 이름" isLabelHidden maxLength={40} value={creating.name} hasAutoFocus
                onChange={(value) => setCreating({ ...creating, name: value })} />
            <ColorPicker name={`new-label-${project.id}`} value={creating.color} onChange={(color) => setCreating({ ...creating, color })} />
            <GroveText type="inherit" color="inherit" className="inline">
                <ServerActionButton type="submit" disabled={busy || !creating.name.trim()}>만들고 붙이기</ServerActionButton>
                <GroveButton type="button" className="ghost" onClick={() => setCreating(null)}>취소</GroveButton>
            </GroveText>
        </form>}
        {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error}</GroveText>}
        <ServerActionButton type="button" className="ghost small" disabled={busy} onClick={() => {
            if (!confirm(`${project.name}을(를) 보관할까요? 목록에서만 빠지고 폴더·대화는 그대로이며 "보관됨"에서 복원할 수 있습니다.`)) return;
            void run(() => api.patch(`/projects/${project.id}`, { expected_revision: project.revision, archived: true }), "보관 실패").then((ok) => { if (ok) onClose(); });
        }}>보관</ServerActionButton>
        <GroveButton type="button" className="ghost small" onClick={onClose}>닫기</GroveButton>
    </div>;
}

/// 라벨 필터(기기별) 겸 라벨 관리. 선택한 라벨 중 하나라도 붙은 프로젝트(또는 라벨 없음)를 보인다.
export function LabelFilter({ labels, selected, onChange }: { labels: Label[]; selected: string[]; onChange: (next: string[]) => void }) {
    const [managing, setManaging] = useState(false);
    const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
    return <div className="label-filter" role="group" aria-label="라벨 필터">
        {labels.map((l) => <GroveButton key={l.id} type="button" role="menuitemcheckbox" aria-checked={selected.includes(l.id)} className="ghost small"
            data-testid={`label-filter-${l.name}`} onClick={() => toggle(l.id)}><LabelChip label={l} /></GroveButton>)}
        <GroveButton type="button" role="menuitemcheckbox" aria-checked={selected.includes(UNLABELLED)} className="ghost small"
            data-testid="label-filter-none" onClick={() => toggle(UNLABELLED)}>라벨 없음</GroveButton>
        {selected.length > 0 && <GroveButton type="button" className="ghost small" onClick={() => onChange([])}>필터 해제</GroveButton>}
        <GroveButton type="button" className="ghost small" aria-expanded={managing} onClick={() => setManaging((m) => !m)}>라벨 관리</GroveButton>
        {managing && <div className="stack">
            {labels.length === 0 && <GroveText as="p" display="block" type="supporting" color="secondary">프로젝트 메뉴에서 라벨을 만드세요.</GroveText>}
            {labels.map((l) => <LabelEditor key={`${l.id}:${l.revision}`} label={l} />)}
        </div>}
    </div>;
}

function LabelEditor({ label }: { label: Label }) {
    const [name, setName] = useState(label.name);
    const [color, setColor] = useState(label.color);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState(false);
    const [busy, setBusy] = useState(false);
    const act = async (fn: () => Promise<unknown>, fallback: string) => {
        setBusy(true);
        setError(null);
        try {
            await fn();
            invalidate("labels");
            invalidate("projects");
        } catch (e) {
            setError(message(e, fallback));
        } finally {
            setBusy(false);
        }
    };
    const dirty = name !== label.name || color !== label.color;
    return <form className="label-editor" aria-label={`${label.name} 라벨 편집`} onSubmit={(e) => {
        e.preventDefault();
        void act(() => api.patch(`/labels/${label.id}`, { expected_revision: label.revision, name, color }), "라벨 저장 실패");
    }}>
        <TextInput size="sm" label={`${label.name} 이름`} isLabelHidden maxLength={40} value={name} onChange={setName} />
        <ColorPicker name={`label-color-${label.id}`} value={color} onChange={setColor} />
        <ServerActionButton type="submit" className="small" disabled={busy || !dirty || !name.trim()}>저장</ServerActionButton>
        {!confirm && <GroveButton type="button" className="ghost small" onClick={() => setConfirm(true)}>삭제</GroveButton>}
        {confirm && <GroveText type="supporting" color="warning" role="alert">
            프로젝트 {label.project_count}개에서 빠집니다.{" "}
            <ServerActionButton type="button" className="small" disabled={busy}
                onClick={() => void act(() => api.del(`/labels/${label.id}?expected_revision=${label.revision}`), "라벨 삭제 실패")}>삭제 확인</ServerActionButton>
            <GroveButton type="button" className="ghost small" onClick={() => setConfirm(false)}>취소</GroveButton>
        </GroveText>}
        {error && <GroveText as="p" display="block" type="inherit" color="error" role="alert">{error}</GroveText>}
    </form>;
}
