const EVENT = "grove-new-conversation";
export function requestNewConversation(projectId: string) {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: projectId }));
}
export function onNewConversation(projectId: string, focus: () => void) {
    const handler = (event: Event) => { if ((event as CustomEvent<string>).detail === projectId) focus(); };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
}
