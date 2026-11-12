use super::*;

#[test]
fn credential_redaction_does_not_rescan_inserted_markers() {
    let secrets=BTreeMap::from([
        ("1".into(),"a".into()),("2".into(),"redacted".into()),("3".into(),"[".into()),
    ]);
    let mut value=json!({"redacted":"a"});
    scrub(&mut value,&secrets).unwrap();
    assert_eq!(value,json!({"[redacted]":"[redacted]"}));
}

#[test]
fn credential_redaction_masks_bearer_and_basic_tokens_without_the_scheme() {
    let secrets=BTreeMap::from([
        ("1".into(),"Bearer fixture-bearer-credential".into()),
        ("2".into(),"Basic Zml4dHVyZTpleGFtcGxl".into()),
    ]);
    let mut value=json!(["Bearer fixture-bearer-credential","fixture-bearer-credential","Zml4dHVyZTpleGFtcGxl"]);
    scrub(&mut value,&secrets).unwrap();
    assert_eq!(value,json!(["[redacted]","[redacted]","[redacted]"]));
}

#[test]
fn credential_redaction_rejects_an_oversized_sanitized_result() {
    let secrets=BTreeMap::from([("1".into(),"x".into())]);
    let mut value=json!(["x".repeat(512*1024)]);
    assert_eq!(scrub(&mut value,&secrets).unwrap_err().code,"mcp_limit");
}
