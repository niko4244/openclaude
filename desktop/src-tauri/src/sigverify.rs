//! `.mcpb` signature verification. A signed bundle is the zip followed by
//! `MCPB_SIG_V1 | u32 LE length | detached PKCS#7 (SHA-256) | MCPB_SIG_END`.
//! The reference signer hashes the zip *before* bumping the EOCD comment length
//! to cover the block, so both forms are tried. Signature and certificate chain
//! are checked by Windows CryptoAPI against the OS trust store.

use serde::Serialize;

const HEADER: &[u8] = b"MCPB_SIG_V1";
const FOOTER: &[u8] = b"MCPB_SIG_END";

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Signature {
    Unsigned,
    /// Valid signature from a publisher the OS trusts.
    Verified { publisher: String },
    /// Valid signature, but the certificate does not chain to a trusted root (e.g. self-signed).
    Untrusted { publisher: String },
    /// Signature block present but it does not match the content (tampered or corrupt).
    Invalid { reason: String },
}

impl Signature {
    pub fn label(&self) -> String {
        match self {
            Signature::Unsigned => "unsigned".into(),
            Signature::Verified { publisher } => format!("verified: {publisher}"),
            Signature::Untrusted { publisher } => format!("signed by untrusted publisher: {publisher}"),
            Signature::Invalid { reason } => format!("INVALID signature: {reason}"),
        }
    }
}

/// Split a bundle into (content, Some(pkcs7)) or (whole file, None).
pub fn split(bytes: &[u8]) -> (&[u8], Option<&[u8]>) {
    let Some(f) = rfind(bytes, FOOTER) else { return (bytes, None) };
    let Some(h) = rfind(&bytes[..f], HEADER) else { return (bytes, None) };
    let start = h + HEADER.len();
    if start + 4 > f {
        return (bytes, None);
    }
    let len = u32::from_le_bytes(bytes[start..start + 4].try_into().unwrap()) as usize;
    match bytes.get(start + 4..start + 4 + len) {
        Some(sig) if start + 4 + len <= f => (&bytes[..h], Some(sig)),
        _ => (bytes, None),
    }
}

fn rfind(hay: &[u8], needle: &[u8]) -> Option<usize> {
    (0..=hay.len().checked_sub(needle.len())?).rev().find(|&i| &hay[i..i + needle.len()] == needle)
}

/// The content with the EOCD comment length reduced by `block_len` (undoes the signer's bump).
fn with_original_comment_len(content: &[u8], block_len: usize) -> Option<Vec<u8>> {
    let eocd = (0..content.len().checked_sub(22)? + 1).rev().find(|&i| content[i..i + 4] == [0x50, 0x4b, 0x05, 0x06])?;
    let cur = u16::from_le_bytes([content[eocd + 20], content[eocd + 21]]) as usize;
    let orig = cur.checked_sub(block_len)?;
    let mut v = content.to_vec();
    v[eocd + 20..eocd + 22].copy_from_slice(&(orig as u16).to_le_bytes());
    Some(v)
}

pub fn verify(bytes: &[u8]) -> Signature {
    let (content, Some(sig)) = split(bytes) else { return Signature::Unsigned };
    let block_len = bytes.len() - content.len();
    let mut last_err = String::from("signature does not match the bundle content");
    let mut candidates = vec![content.to_vec()];
    if let Some(alt) = with_original_comment_len(content, block_len) {
        candidates.push(alt);
    }
    for c in candidates {
        match os::verify_detached(sig, &c) {
            Ok((publisher, trusted)) => {
                return if trusted { Signature::Verified { publisher } } else { Signature::Untrusted { publisher } };
            }
            Err(e) => last_err = e,
        }
    }
    Signature::Invalid { reason: last_err }
}

#[cfg(windows)]
mod os {
    use windows::Win32::Foundation::GetLastError;
    use windows::Win32::Security::Cryptography::*;

    /// Returns (publisher display name, chains to a trusted root).
    pub fn verify_detached(sig: &[u8], content: &[u8]) -> Result<(String, bool), String> {
        unsafe {
            let para = CRYPT_VERIFY_MESSAGE_PARA {
                cbSize: std::mem::size_of::<CRYPT_VERIFY_MESSAGE_PARA>() as u32,
                dwMsgAndCertEncodingType: (X509_ASN_ENCODING.0 | PKCS_7_ASN_ENCODING.0),
                ..Default::default()
            };
            let parts = [content.as_ptr()];
            let lens = [content.len() as u32];
            let mut cert: *mut CERT_CONTEXT = std::ptr::null_mut();
            CryptVerifyDetachedMessageSignature(&para, 0, sig, 1, parts.as_ptr(), lens.as_ptr(), Some(&mut cert))
                .map_err(|e| format!("signature check failed ({e})"))?;
            if cert.is_null() {
                return Err(format!("no signer certificate ({:?})", GetLastError()));
            }
            let mut buf = [0u16; 256];
            let n = CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, None, Some(&mut buf));
            let publisher = String::from_utf16_lossy(&buf[..n.saturating_sub(1) as usize]);
            let chain_para = CERT_CHAIN_PARA { cbSize: std::mem::size_of::<CERT_CHAIN_PARA>() as u32, ..Default::default() };
            let mut chain: *mut CERT_CHAIN_CONTEXT = std::ptr::null_mut();
            let mut trusted = false;
            if CertGetCertificateChain(None, cert, None, None, &chain_para, 0, None, &mut chain).is_ok() && !chain.is_null() {
                let policy = CERT_CHAIN_POLICY_PARA { cbSize: std::mem::size_of::<CERT_CHAIN_POLICY_PARA>() as u32, ..Default::default() };
                let mut status = CERT_CHAIN_POLICY_STATUS { cbSize: std::mem::size_of::<CERT_CHAIN_POLICY_STATUS>() as u32, ..Default::default() };
                trusted = CertVerifyCertificateChainPolicy(CERT_CHAIN_POLICY_BASE, chain, &policy, &mut status).as_bool() && status.dwError == 0;
                CertFreeCertificateChain(chain);
            }
            let _ = CertFreeCertificateContext(Some(cert));
            Ok((publisher, trusted))
        }
    }
}

#[cfg(not(windows))]
mod os {
    pub fn verify_detached(_sig: &[u8], _content: &[u8]) -> Result<(String, bool), String> {
        Err("signature verification is only implemented on Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(sig: &[u8]) -> Vec<u8> {
        let mut b = HEADER.to_vec();
        b.extend((sig.len() as u32).to_le_bytes());
        b.extend(sig);
        b.extend(FOOTER);
        b
    }

    #[test]
    fn split_finds_block_and_unsigned_passes_through() {
        let mut f = b"zipbytes".to_vec();
        f.extend(block(b"SIG"));
        let (c, s) = split(&f);
        assert_eq!(c, b"zipbytes");
        assert_eq!(s, Some(&b"SIG"[..]));
        assert_eq!(verify(b"plain zip"), Signature::Unsigned);
        // truncated length must not panic or over-read
        let mut bad = b"z".to_vec();
        bad.extend(HEADER);
        bad.extend(999u32.to_le_bytes());
        bad.extend(FOOTER);
        assert_eq!(split(&bad).1, None);
    }

    /// Signs with an in-memory self-signed cert via .NET SignedCms (PowerShell 7), the same
    /// detached PKCS#7/SHA-256 shape the reference signer produces.
    fn dotnet_sign(content: &[u8]) -> Option<Vec<u8>> {
        let dir = tempfile::tempdir().ok()?;
        let input = dir.path().join("in.bin");
        let out = dir.path().join("sig.der");
        std::fs::write(&input, content).ok()?;
        let script = format!(
            "$rsa=[Security.Cryptography.RSA]::Create(2048);\
             $req=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=OpenClaude Test Publisher',$rsa,'SHA256',[Security.Cryptography.RSASignaturePadding]::Pkcs1);\
             $cert=$req.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1),[DateTimeOffset]::Now.AddDays(1));\
             $ci=[Security.Cryptography.Pkcs.ContentInfo]::new([IO.File]::ReadAllBytes('{}'));\
             $cms=[Security.Cryptography.Pkcs.SignedCms]::new($ci,$true);\
             $s=[Security.Cryptography.Pkcs.CmsSigner]::new($cert);$s.DigestAlgorithm=[Security.Cryptography.Oid]::new('2.16.840.1.101.3.4.2.1');\
             $cms.ComputeSignature($s);[IO.File]::WriteAllBytes('{}',$cms.Encode())",
            input.display(),
            out.display()
        );
        let ok = std::process::Command::new("pwsh").args(["-NoProfile", "-Command", &script]).status().ok()?.success();
        if !ok {
            return None;
        }
        std::fs::read(out).ok()
    }

    #[cfg(windows)]
    #[test]
    fn self_signed_is_untrusted_and_tampering_is_invalid() {
        let content = b"PK fake zip content for signing".to_vec();
        let Some(sig) = dotnet_sign(&content) else {
            eprintln!("pwsh/.NET signing unavailable; skipping");
            return;
        };
        let mut signed = content.clone();
        signed.extend(block(&sig));
        match verify(&signed) {
            Signature::Untrusted { publisher } => assert_eq!(publisher, "OpenClaude Test Publisher"),
            other => panic!("expected untrusted, got {other:?}"),
        }
        let mut tampered = signed.clone();
        tampered[3] ^= 0xff;
        assert!(matches!(verify(&tampered), Signature::Invalid { .. }));
    }
}
