//! Voice dictation: audio bytes -> text.
//!
//! Preferred path is the gateway's OpenAI-compatible `/v1/audio/transcriptions`
//! (when the user configured an `stt_model`). Without one we fall back to a local
//! faster-whisper run through Python, so dictation works with no gateway STT model.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use serde_json::Value;

use crate::gateway::Gateway;

const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;
const LOCAL_TIMEOUT: Duration = Duration::from_secs(180);
const GATEWAY_TIMEOUT: Duration = Duration::from_secs(120);
const MISSING_DEPS: &str = "Local transcription needs Python with faster-whisper: pip install faster-whisper";

/// Prints `{"text": ...}` (ASCII-escaped, so Windows console codepages can't mangle it).
/// Exit 3 = faster_whisper missing.
const WHISPER_PY: &str = r#"import sys, json
try:
    from faster_whisper import WhisperModel
except ImportError:
    sys.stderr.write("faster_whisper not installed")
    sys.exit(3)
audio, size = sys.argv[1], sys.argv[2]
model = WhisperModel(size, device="cpu", compute_type="int8")
segs, _ = model.transcribe(audio, vad_filter=True)
print(json.dumps({"text": "".join(s.text for s in segs).strip()}))
"#;

/// (file extension, normalized mime) from the recorder's mime (may carry `;codecs=...`).
fn audio_kind(mime: &str) -> (&'static str, &'static str) {
    let m = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if m.contains("ogg") {
        ("ogg", "audio/ogg")
    } else if m.contains("wav") {
        ("wav", "audio/wav")
    } else {
        ("webm", "audio/webm")
    }
}

pub async fn transcribe(
    gw: &Gateway,
    stt_model: Option<&str>,
    audio: Vec<u8>,
    mime: &str,
    work_dir: &Path,
) -> anyhow::Result<String> {
    if audio.is_empty() {
        bail!("No audio recorded");
    }
    if audio.len() > MAX_AUDIO_BYTES {
        bail!("Audio too large ({} MB, max 25 MB)", audio.len() / (1024 * 1024));
    }
    match stt_model.map(str::trim).filter(|m| !m.is_empty()) {
        Some(model) => via_gateway(gw, model, audio, mime).await,
        None => via_local(audio, mime, work_dir).await,
    }
}

async fn via_gateway(gw: &Gateway, model: &str, audio: Vec<u8>, mime: &str) -> anyhow::Result<String> {
    let (ext, mime) = audio_kind(mime);
    let part = reqwest::multipart::Part::bytes(audio).file_name(format!("audio.{ext}")).mime_str(mime)?;
    let form = reqwest::multipart::Form::new().text("model", model.to_string()).part("file", part);
    let mut req = reqwest::Client::new()
        .post(format!("{}/v1/audio/transcriptions", gw.base_url.trim_end_matches('/')))
        .timeout(GATEWAY_TIMEOUT)
        .multipart(form);
    if let Some(k) = &gw.api_key {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await.context("transcription request failed")?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        // LiteLLM/OpenAI errors: {"error":{"message":...}}; fall back to the raw body.
        let msg = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().or(v["detail"].as_str()).map(String::from))
            .unwrap_or_else(|| body.chars().take(300).collect());
        bail!("Transcription failed (HTTP {}): {}", status.as_u16(), msg);
    }
    let v: Value = serde_json::from_str(&body).context("transcription response was not JSON")?;
    v["text"].as_str().map(|t| t.trim().to_string()).ok_or_else(|| anyhow!("transcription response had no `text`"))
}

async fn via_local(audio: Vec<u8>, mime: &str, work_dir: &Path) -> anyhow::Result<String> {
    let (ext, _) = audio_kind(mime);
    tokio::fs::create_dir_all(work_dir).await?;
    let audio_path = work_dir.join(format!("dictation-{}.{ext}", uuid::Uuid::new_v4()));
    let script_path = work_dir.join("whisper_local.py");
    tokio::fs::write(&audio_path, &audio).await?;
    tokio::fs::write(&script_path, WHISPER_PY).await?;
    let size = std::env::var("OPENCLAUDE_WHISPER_MODEL").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "base".into());

    let mut cmd = tokio::process::Command::new("python");
    cmd.arg(&script_path).arg(&audio_path).arg(size.trim()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let out = tokio::time::timeout(LOCAL_TIMEOUT, cmd.output()).await;
    let _ = tokio::fs::remove_file(&audio_path).await; // never leave recordings behind

    let out = match out {
        Err(_) => bail!("Local transcription timed out after {}s", LOCAL_TIMEOUT.as_secs()),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => bail!("{MISSING_DEPS}"),
        Ok(Err(e)) => return Err(e).context("failed to start python"),
        Ok(Ok(o)) => o,
    };
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if out.status.code() == Some(3) || err.contains("faster_whisper") {
            bail!("{MISSING_DEPS}");
        }
        bail!("Local transcription failed: {}", err.lines().last().unwrap_or("unknown error"));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("");
    let v: Value = serde_json::from_str(line).context("local transcription gave no JSON")?;
    Ok(v["text"].as_str().unwrap_or("").trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// One-shot HTTP server: returns (base_url, join handle yielding the raw request bytes).
    async fn mock(status: &str, body: &str) -> (String, tokio::task::JoinHandle<Vec<u8>>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        let reply = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let h = tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                let n = s.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..p]).to_ascii_lowercase();
                    let len: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                    if buf.len() >= p + 4 + len {
                        break;
                    }
                }
            }
            s.write_all(reply.as_bytes()).await.unwrap();
            buf
        });
        (url, h)
    }

    #[tokio::test]
    async fn gateway_path_posts_multipart_and_returns_text() {
        let (url, h) = mock("200 OK", r#"{"text":" hello "}"#).await;
        let gw = Gateway::new(&url, Some("sk-test".into()));
        let dir = tempfile::tempdir().unwrap();
        let t = transcribe(&gw, Some("whisper-1"), vec![1, 2, 3, 4], "audio/webm;codecs=opus", dir.path()).await.unwrap();
        assert_eq!(t, "hello");
        let req = String::from_utf8_lossy(&h.await.unwrap()).to_string();
        assert!(req.starts_with("POST /v1/audio/transcriptions"), "{req}");
        assert!(req.to_ascii_lowercase().contains("authorization: bearer sk-test"));
        assert!(req.to_ascii_lowercase().contains("multipart/form-data"));
        assert!(req.contains("name=\"model\"") && req.contains("whisper-1"));
        assert!(req.contains("filename=\"audio.webm\""));
    }

    #[tokio::test]
    async fn gateway_error_message_is_propagated() {
        let (url, _h) = mock("400 Bad Request", r#"{"error":{"message":"no such model"}}"#).await;
        let gw = Gateway::new(&url, None);
        let dir = tempfile::tempdir().unwrap();
        let e = transcribe(&gw, Some("nope"), vec![1; 8], "audio/wav", dir.path()).await.unwrap_err().to_string();
        assert!(e.contains("400") && e.contains("no such model"), "{e}");
    }

    #[tokio::test]
    async fn rejects_oversized_and_empty_audio() {
        let gw = Gateway::new("http://127.0.0.1:1", None);
        let dir = tempfile::tempdir().unwrap();
        let e = transcribe(&gw, Some("m"), vec![0; MAX_AUDIO_BYTES + 1], "audio/webm", dir.path()).await.unwrap_err().to_string();
        assert!(e.contains("too large"), "{e}");
        assert!(transcribe(&gw, None, vec![], "audio/webm", dir.path()).await.is_err());
    }

    #[test]
    fn mime_maps_to_extension() {
        assert_eq!(audio_kind("audio/webm;codecs=opus").0, "webm");
        assert_eq!(audio_kind("audio/ogg").0, "ogg");
        assert_eq!(audio_kind("audio/x-wav").0, "wav");
    }

    #[tokio::test]
    #[ignore = "downloads a whisper model; needs python + faster-whisper"]
    async fn local_path_runs_faster_whisper() {
        let gw = Gateway::new("http://127.0.0.1:1", None);
        let dir = tempfile::tempdir().unwrap();
        // 1s of 16 kHz silence as WAV: should transcribe to (near) empty without erroring.
        let mut wav = Vec::new();
        let data = vec![0u8; 32000];
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&[1, 0, 1, 0]);
        wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend_from_slice(&32000u32.to_le_bytes());
        wav.extend_from_slice(&[2, 0, 16, 0]);
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
        wav.extend_from_slice(&data);
        let t = transcribe(&gw, None, wav, "audio/wav", dir.path()).await.unwrap();
        assert!(t.len() < 50, "{t}");
    }
}
