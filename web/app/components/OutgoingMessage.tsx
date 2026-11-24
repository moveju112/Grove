import { ChatMessage, ChatMessageBubble } from "@astryxdesign/core/Chat";
import { Text as GroveText } from "@astryxdesign/core/Text";
import { contentStyles } from "../design/content.stylex";
import type { Outgoing } from "../state/outgoing";
import { OutgoingAttachments } from "./Attachments";

/// 보내기를 누른 직후의 사용자 메시지. 서버가 접수하면 같은 자리의 실제 메시지로 바뀐다.
export function OutgoingMessage({ message }: { message: Outgoing }) {
    return <ChatMessage sender="user" density="compact" data-testid="msg-outgoing">
        <ChatMessageBubble>
            {message.text && <GroveText as="div" display="block" type="inherit" color="inherit" xstyle={contentStyles.plainText}>{message.text}</GroveText>}
            {message.files.length > 0 && <OutgoingAttachments files={message.files} />}
        </ChatMessageBubble>
    </ChatMessage>;
}
