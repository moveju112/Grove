use ring::{
    aead, agreement, hmac,
    rand::{SecureRandom, SystemRandom},
    signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair},
};
use serde_json::json;

pub(super) type Result<T> = std::result::Result<T, ()>;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
pub(super) fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}
pub(super) fn decode(value: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(value).map_err(|_| ())
}
pub(super) fn key() -> Result<Vec<u8>> {
    EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
        .map(|v| v.as_ref().to_vec())
        .map_err(|_| ())
}
fn pair(pkcs8: &[u8]) -> Result<EcdsaKeyPair> {
    EcdsaKeyPair::from_pkcs8(
        &ECDSA_P256_SHA256_FIXED_SIGNING,
        pkcs8,
        &SystemRandom::new(),
    )
    .map_err(|_| ())
}
pub(super) fn public(pkcs8: &[u8]) -> Result<String> {
    Ok(encode(pair(pkcs8)?.public_key().as_ref()))
}
pub(super) fn authorization(
    pkcs8: &[u8],
    audience: &str,
    subject: &str,
    now: i64,
) -> Result<String> {
    let pair = pair(pkcs8)?;
    let claims = json!({"aud":audience,"exp":now+3600,"sub":subject});
    let token = format!(
        "{}.{}",
        encode(br#"{"typ":"JWT","alg":"ES256"}"#),
        encode(claims.to_string().as_bytes())
    );
    let signature = pair
        .sign(&SystemRandom::new(), token.as_bytes())
        .map_err(|_| ())?;
    Ok(format!(
        "vapid t={token}.{}, k={}",
        encode(signature.as_ref()),
        encode(pair.public_key().as_ref())
    ))
}
pub(super) fn validate_public(public: &[u8]) -> Result<()> {
    let private =
        agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &SystemRandom::new())
            .map_err(|_| ())?;
    agreement::agree_ephemeral(
        private,
        &agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, public),
        |_| (),
    )
    .map_err(|_| ())
}
pub(super) fn encrypt(public: &[u8], auth: &[u8], payload: &[u8]) -> Result<Vec<u8>> {
    let rng = SystemRandom::new();
    let private =
        agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).map_err(|_| ())?;
    let sender = private.compute_public_key().map_err(|_| ())?;
    let mut salt = [0; 16];
    rng.fill(&mut salt).map_err(|_| ())?;
    agreement::agree_ephemeral(
        private,
        &agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, public),
        |shared| seal(shared, public, sender.as_ref(), auth, &salt, payload),
    )
    .map_err(|_| ())?
}
// RFC 8291 section 3.4 / RFC 8188, one final aes128gcm record.
fn seal(
    shared: &[u8],
    receiver: &[u8],
    sender: &[u8],
    auth: &[u8],
    salt: &[u8],
    payload: &[u8],
) -> Result<Vec<u8>> {
    if payload.len() > 3993 {
        return Err(());
    }
    let mac = |key: &[u8], value: &[u8]| {
        hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), value)
            .as_ref()
            .to_vec()
    };
    let info = [b"WebPush: info\0".as_slice(), receiver, sender, &[1]].concat();
    let ikm = mac(&mac(auth, shared), &info);
    let prk = mac(salt, &ikm);
    let cek = mac(&prk, b"Content-Encoding: aes128gcm\0\x01");
    let nonce = mac(&prk, b"Content-Encoding: nonce\0\x01");
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_128_GCM, &cek[..16]).map_err(|_| ())?,
    );
    let mut record = payload.to_vec();
    record.push(2);
    key.seal_in_place_append_tag(
        aead::Nonce::try_assume_unique_for_key(&nonce[..12]).map_err(|_| ())?,
        aead::Aad::empty(),
        &mut record,
    )
    .map_err(|_| ())?;
    Ok([salt, &4096u32.to_be_bytes(), &[65], sender, &record].concat())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rfc8291_published_vector() {
        let bytes = |value| decode(value).unwrap();
        let sealed=seal(&bytes("kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs"),
            &bytes("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
            &bytes("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"),
            &bytes("BTBZMqHH6r4Tts7J_aSIgg"),&bytes("DGv6ra1nlYgDCS1FRnbzlw"),b"When I grow up, I want to be a watermelon").unwrap();
        assert_eq!(
            encode(&sealed),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }
    #[test]
    fn vapid_signature_and_claims_are_verifiable() {
        let key = key().unwrap();
        let public = decode(&public(&key).unwrap()).unwrap();
        let header = authorization(
            &key,
            "https://fcm.googleapis.com",
            "https://grove.example",
            100,
        )
        .unwrap();
        let token = header
            .strip_prefix("vapid t=")
            .unwrap()
            .split(", k=")
            .next()
            .unwrap();
        let (signed, signature) = token.rsplit_once('.').unwrap();
        ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_FIXED, public)
            .verify(signed.as_bytes(), &decode(signature).unwrap())
            .unwrap();
        let claims: serde_json::Value =
            serde_json::from_slice(&decode(signed.split('.').nth(1).unwrap()).unwrap()).unwrap();
        assert_eq!(
            claims,
            json!({"aud":"https://fcm.googleapis.com","sub":"https://grove.example","exp":3700})
        );
        for value in ["a", "a!", "AB", "AA="] {
            assert!(decode(value).is_err());
        }
    }
}
