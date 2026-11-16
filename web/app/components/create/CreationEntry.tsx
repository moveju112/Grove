import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Button } from "../../design/Button";
import { Icon } from "../icons";

// 전역 추가 메뉴에서는 프로젝트·정리용 폴더만 만든다. 대화는 프로젝트 안의 +에서 시작한다.
export function CreationEntry({ foldersSupported, onTrigger, onAddProject, onAddFolder }: {
    foldersSupported: boolean;
    onTrigger: (button: HTMLButtonElement) => void;
    onAddProject: () => void;
    onAddFolder: () => void;
}) {
    return <DropdownMenu placement="below" alignment="start" renderTrigger={(props) =>
        <Button {...props} type="button" appearance="icon" aria-label="프로젝트·폴더 추가" title="프로젝트·폴더 추가"
            ref={(button) => { props.ref(button); if (button) onTrigger(button); }}>
            <Icon name="plus" />
        </Button>}>
        <DropdownMenuItem label="프로젝트 추가" onClick={onAddProject} />
        {foldersSupported && <DropdownMenuItem label="폴더 추가" onClick={onAddFolder} />}
    </DropdownMenu>;
}
