// 이 파일은 tests/external_editor.rs에서 Rust 계약과 대조한다.
export type ExternalEditorInfo = { id: string, name: string, };
export type ExternalEditorListing = { available: boolean, reason: string | null, editors: Array<ExternalEditorInfo>, };
