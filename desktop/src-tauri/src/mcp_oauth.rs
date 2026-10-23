//! OAuth 2.1 for remote MCP servers, per the MCP authorization spec:
//! RFC 9728 resource metadata, RFC 8414 / OIDC discovery, RFC 7591 dynamic client
//! registration, PKCE S256, RFC 8707 `resource`, RFC 9207 `iss` check, loopback redirect.
//! Tokens live only in the OS credential store and are never logged.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

pub const KEYRING_SERVICE: &str = "openclaude-desktop-mcp-oauth";
/// Windows credential blobs cap at 2560 bytes; JWTs can exceed that, so we chunk.
const CHUNK: usize = 2000;

/// A request was rejected with 401: the user must sign in (never auto-opened).
#[derive(Debug)]
pub struct AuthRequired;
impl std::fmt::Display for AuthRequired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Sign-in required")
    }
}
impl std::error::Error for AuthRequired {}

// No Debug derive on purpose: this holds secrets.
#[derive(Serialize, Deserialize)]
struct Stored {
    access: String,
    #[serde(default)]
    refresh: Option<String>,
    #[serde(default)]
    expires_at: Option<u64>,
    client_id: String,
    #[serde(default)]
    client_secret: Option<String>,
    token_endpoint: String,
    /// The MCP server URL the token was issued for (RFC 8707 audience).
    resource: String,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn entry(server: &str, i: usize) -> keyring::Result<keyring::Entry> {
    let user = if i == 0 { server.to_string() } else { format!("{server}#{i}") };
    keyring::Entry::new(KEYRING_SERVICE, &user)
}

fn load(server: &str) -> Option<Stored> {
    let mut blob = Vec::new();
    for i in 0.. {
        match entry(server, i).and_then(|e| e.get_secret()) {
            Ok(b) => blob.extend(b),
            Err(_) => break,
        }
    }
    serde_json::from_slice(&blob).ok()
}

fn save(server: &str, s: &Stored) -> anyhow::Result<()> {
    let blob = serde_json::to_vec(s)?;
    let chunks: Vec<&[u8]> = blob.chunks(CHUNK).collect();
    for (i, c) in chunks.iter().enumerate() {
        entry(server, i)
            .and_then(|e| e.set_secret(c))
            .map_err(|e| anyhow::anyhow!("credential store write failed: {e}"))?;
    }
    clear_from(server, chunks.len());
    Ok(())
}

fn clear_from(server: &str, start: usize) {
    for i in start.. {
        if entry(server, i).and_then(|e| e.delete_credential()).is_err() {
            break;
        }
    }
}

/// Drop stored tokens for `server`.
pub fn forget(server: &str) {
    clear_from(server, 0);
}

/// OAuth endpoints must be HTTPS; plain HTTP only for loopback (local dev, tests).
fn safe_url(u: &str) -> anyhow::Result<Url> {
    let url = Url::parse(u)?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" => Ok(url),
        "http" if loopback => Ok(url),
        _ => anyhow::bail!("refusing non-HTTPS OAuth URL on {}", url.origin().ascii_serialization()),
    }
}

/// No redirects: a 307 on the token endpoint would replay the code + verifier elsewhere.
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

async fn get_json(http: &reqwest::Client, url: &Url) -> Option<Value> {
    let r = http
        .get(url.clone())
        .header("Accept", "application/json")
        .header("MCP-Protocol-Version", crate::mcp::PROTOCOL_VERSION)
        .send()
        .await
        .ok()?;
    if !r.status().is_success() {
        return None;
    }
    r.json().await.ok()
}

/// `key="value"` or `key=token` from a WWW-Authenticate header.
fn auth_param(h: &str, key: &str) -> Option<String> {
    let lower = h.to_ascii_lowercase();
    let pat = format!("{key}=");
    let mut from = 0;
    while let Some(i) = lower[from..].find(&pat).map(|i| i + from) {
        if i == 0 || matches!(h.as_bytes()[i - 1], b' ' | b',' | b'\t') {
            let rest = &h[i + pat.len()..];
            let v = match rest.strip_prefix('"') {
                Some(r) => r.split('"').next(),
                None => rest.split([',', ' ']).next(),
            };
            return v.map(str::to_string);
        }
        from = i + pat.len();
    }
    None
}

/// RFC 9728 §3.3: the metadata's resource must identify the server we asked about.
fn resource_matches(res: &str, mcp: &Url) -> bool {
    Url::parse(res).is_ok_and(|r| r.origin() == mcp.origin() && mcp.path().starts_with(r.path().trim_end_matches('/')))
}

struct AsMeta {
    issuer: String,
    authorization_endpoint: Url,
    token_endpoint: Url,
    registration_endpoint: Option<Url>,
}

/// Returns the authorization server metadata and the scope to request (if any).
async fn discover(http: &reqwest::Client, mcp: &Url) -> anyhow::Result<(AsMeta, Option<String>)> {
    let www = match http.get(mcp.clone()).header("Accept", "text/event-stream").send().await {
        Ok(r) if r.status() == 401 => r.headers().get("www-authenticate").and_then(|v| v.to_str().ok()).map(str::to_string),
        _ => None,
    };
    let mut scope = www.as_deref().and_then(|h| auth_param(h, "scope"));
    let origin = mcp.origin().ascii_serialization();
    let path = mcp.path().trim_end_matches('/');
    let mut candidates = vec![];
    if let Some(u) = www.as_deref().and_then(|h| auth_param(h, "resource_metadata")) {
        candidates.push(safe_url(&u)?);
    }
    if !path.is_empty() {
        candidates.push(Url::parse(&format!("{origin}/.well-known/oauth-protected-resource{path}"))?);
    }
    candidates.push(Url::parse(&format!("{origin}/.well-known/oauth-protected-resource"))?);
    // 2025-03-26 fallback when no resource metadata exists: the AS lives at the server's origin.
    let mut issuer = origin.clone();
    for c in candidates {
        let Some(prm) = get_json(http, &c).await else { continue };
        if let Some(res) = prm.get("resource").and_then(Value::as_str) {
            if !resource_matches(res, mcp) {
                anyhow::bail!("protected resource metadata is for a different resource; refusing");
            }
        }
        issuer = prm
            .pointer("/authorization_servers/0")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("protected resource metadata lists no authorization server"))?
            .to_string();
        if scope.is_none() {
            scope = prm.get("scopes_supported").and_then(Value::as_array).map(|a| {
                a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")
            }).filter(|s| !s.is_empty());
        }
        break;
    }
    Ok((as_metadata(http, &issuer).await?, scope))
}

async fn as_metadata(http: &reqwest::Client, issuer: &str) -> anyhow::Result<AsMeta> {
    let iss = safe_url(issuer)?;
    let origin = iss.origin().ascii_serialization();
    let path = iss.path().trim_end_matches('/');
    let mut urls = vec![
        format!("{origin}/.well-known/oauth-authorization-server{path}"),
        format!("{origin}/.well-known/openid-configuration{path}"),
        format!("{origin}{path}/.well-known/openid-configuration"),
    ];
    urls.dedup();
    for u in urls {
        let Some(m) = get_json(http, &Url::parse(&u)?).await else { continue };
        let got = m.get("issuer").and_then(Value::as_str).unwrap_or("");
        // RFC 8414 §3.3: mix-up defence.
        if got.trim_end_matches('/') != issuer.trim_end_matches('/') {
            anyhow::bail!("authorization server metadata issuer mismatch; refusing");
        }
        let s256 = m
            .get("code_challenge_methods_supported")
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(|v| v == "S256"));
        if !s256 {
            anyhow::bail!("authorization server does not advertise PKCE S256; refusing");
        }
        let ep = |k: &str| m.get(k).and_then(Value::as_str).map(safe_url).transpose();
        let need = |k: &str| ep(k)?.ok_or_else(|| anyhow::anyhow!("authorization server metadata has no {k}"));
        return Ok(AsMeta {
            issuer: got.to_string(),
            authorization_endpoint: need("authorization_endpoint")?,
            token_endpoint: need("token_endpoint")?,
            registration_endpoint: ep("registration_endpoint")?,
        });
    }
    anyhow::bail!("no OAuth authorization server metadata found at {origin}")
}

async fn register(http: &reqwest::Client, meta: &AsMeta, redirect: &str) -> anyhow::Result<(String, Option<String>)> {
    let Some(ep) = &meta.registration_endpoint else {
        anyhow::bail!(
            "this server's authorization server does not support dynamic client registration; \
             a pre-registered OAuth client id is required"
        )
    };
    let r = http
        .post(ep.clone())
        .json(&json!({
            "client_name": "OpenClaude Desktop",
            "redirect_uris": [redirect],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        }))
        .send()
        .await?;
    if !r.status().is_success() {
        anyhow::bail!("client registration failed: HTTP {}", r.status());
    }
    let v: Value = r.json().await?;
    let id = v
        .get("client_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("client registration returned no client_id"))?;
    Ok((id.to_string(), v.get("client_secret").and_then(Value::as_str).map(str::to_string)))
}

async fn token_request(
    http: &reqwest::Client,
    ep: &str,
    mut form: Vec<(&str, String)>,
    secret: Option<&str>,
) -> anyhow::Result<Value> {
    if let Some(s) = secret {
        form.push(("client_secret", s.to_string()));
    }
    let r = http.post(ep).header("Accept", "application/json").form(&form).send().await?;
    let status = r.status();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let desc: String = v.get("error_description").and_then(Value::as_str).unwrap_or("").chars().take(200).collect();
        anyhow::bail!("token request failed: HTTP {status} {} {desc}", v.get("error").and_then(Value::as_str).unwrap_or(""));
    }
    if v.get("access_token").and_then(Value::as_str).is_none_or(str::is_empty) {
        anyhow::bail!("token response has no access_token");
    }
    if !v.get("token_type").and_then(Value::as_str).is_some_and(|t| t.eq_ignore_ascii_case("bearer")) {
        anyhow::bail!("unsupported token_type (expected Bearer)");
    }
    Ok(v)
}

fn rand_b64(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::fill(&mut b[..]);
    URL_SAFE_NO_PAD.encode(b)
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()).as_slice())
}

async fn respond(sock: &mut tokio::net::TcpStream, status: &str, body: &str) {
    let msg = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = sock.write_all(msg.as_bytes()).await;
    let _ = sock.shutdown().await;
}

/// Accept loopback callbacks until one carries our `state`; forged or stray hits are refused.
async fn wait_for_code(listener: TcpListener, state: &str, issuer: &str, deadline: Duration) -> anyhow::Result<String> {
    tokio::time::timeout(deadline, accept_code(listener, state, issuer))
        .await
        .map_err(|_| anyhow::anyhow!("timed out waiting for sign-in"))?
}

async fn accept_code(listener: TcpListener, state: &str, issuer: &str) -> anyhow::Result<String> {
    let page = |m: &str| format!("<!doctype html><title>OpenClaude</title><p style=\"font-family:sans-serif\">{m}</p>");
    {
        loop {
            let (mut sock, _) = listener.accept().await?;
            let mut buf = vec![0u8; 8192];
            let mut n = 0;
            while n < buf.len() && !buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                match tokio::time::timeout(Duration::from_secs(5), sock.read(&mut buf[n..])).await {
                    Ok(Ok(k)) if k > 0 => n += k,
                    _ => break,
                }
            }
            let head = String::from_utf8_lossy(&buf[..n]);
            let target = head.lines().next().and_then(|l| l.strip_prefix("GET ")).and_then(|l| l.split(' ').next());
            let Some(u) = target.and_then(|t| Url::parse(&format!("http://127.0.0.1{t}")).ok()) else {
                respond(&mut sock, "400 Bad Request", &page("Bad request.")).await;
                continue;
            };
            if u.path() != "/callback" {
                respond(&mut sock, "404 Not Found", &page("Not found.")).await;
                continue;
            }
            let q: HashMap<String, String> = u.query_pairs().into_owned().collect();
            if q.get("state").map(String::as_str) != Some(state) {
                respond(&mut sock, "400 Bad Request", &page("Invalid sign-in state.")).await;
                continue;
            }
            if q.get("iss").is_some_and(|i| i.trim_end_matches('/') != issuer.trim_end_matches('/')) {
                respond(&mut sock, "400 Bad Request", &page("Sign-in failed.")).await;
                anyhow::bail!("authorization response issuer mismatch; refusing");
            }
            if let Some(err) = q.get("error") {
                respond(&mut sock, "400 Bad Request", &page("Sign-in failed. You can close this window.")).await;
                let desc: String = q.get("error_description").map(String::as_str).unwrap_or("").chars().take(200).collect();
                anyhow::bail!("authorization denied: {err} {desc}");
            }
            let Some(code) = q.get("code").filter(|c| !c.is_empty()) else {
                respond(&mut sock, "400 Bad Request", &page("Missing code.")).await;
                continue;
            };
            respond(&mut sock, "200 OK", &page("Signed in. You can close this window.")).await;
            return Ok(code.clone());
        }
    }
}

/// Run the interactive sign-in for `server` and store its tokens. `open_browser` gets the
/// authorization URL; only call this from an explicit user action.
pub async fn authorize(server: &str, mcp_url: &str, open_browser: impl Fn(String) + Send) -> anyhow::Result<()> {
    authorize_with(server, mcp_url, open_browser, Duration::from_secs(300)).await
}

async fn authorize_with(
    server: &str,
    mcp_url: &str,
    open_browser: impl Fn(String) + Send,
    deadline: Duration,
) -> anyhow::Result<()> {
    let mcp = safe_url(mcp_url)?;
    let http = client();
    let (meta, scope) = discover(&http, &mcp).await?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let redirect = format!("http://127.0.0.1:{}/callback", listener.local_addr()?.port());
    let (client_id, client_secret) = register(&http, &meta, &redirect).await?;
    let verifier = rand_b64(32);
    let state = rand_b64(32);
    let mut auth = meta.authorization_endpoint.clone();
    {
        let mut q = auth.query_pairs_mut();
        q.append_pair("response_type", "code")
            .append_pair("client_id", &client_id)
            .append_pair("redirect_uri", &redirect)
            .append_pair("code_challenge", &challenge(&verifier))
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("resource", mcp_url);
        if let Some(s) = &scope {
            q.append_pair("scope", s);
        }
    }
    open_browser(auth.to_string());
    let code = wait_for_code(listener, &state, &meta.issuer, deadline).await?;
    let form = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", code),
        ("redirect_uri", redirect),
        ("client_id", client_id.clone()),
        ("code_verifier", verifier),
        ("resource", mcp_url.to_string()),
    ];
    let v = token_request(&http, meta.token_endpoint.as_str(), form, client_secret.as_deref()).await?;
    save(
        server,
        &Stored {
            access: v["access_token"].as_str().unwrap_or_default().to_string(),
            refresh: v.get("refresh_token").and_then(Value::as_str).map(str::to_string),
            expires_at: v.get("expires_in").and_then(Value::as_u64).map(|s| now() + s),
            client_id,
            client_secret,
            token_endpoint: meta.token_endpoint.to_string(),
            resource: mcp_url.to_string(),
        },
    )
}

static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Current access token for `server`, refreshed when (nearly) expired.
pub async fn bearer_for(server: &str) -> Option<String> {
    bearer(server, None).await
}

/// Like `bearer_for`, but only if the token was issued for `resource` — a config edit that
/// points the server at a different URL must not leak the old token there.
pub async fn bearer_for_resource(server: &str, resource: &str) -> Option<String> {
    bearer(server, Some(resource)).await
}

async fn bearer(server: &str, resource: Option<&str>) -> Option<String> {
    let fresh = |s: &Stored| s.expires_at.is_none_or(|e| now() + 60 < e);
    let s = load(server)?;
    if resource.is_some_and(|r| r != s.resource) {
        return None;
    }
    if fresh(&s) {
        return Some(s.access);
    }
    // Serialize refreshes: rotating refresh tokens break if two requests race.
    let _g = REFRESH.lock().await;
    let s = load(server)?;
    if fresh(&s) {
        return Some(s.access);
    }
    let form = vec![
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", s.refresh.clone()?),
        ("client_id", s.client_id.clone()),
        ("resource", s.resource.clone()),
    ];
    let v = token_request(&client(), &s.token_endpoint, form, s.client_secret.as_deref()).await.ok()?;
    let n = Stored {
        access: v["access_token"].as_str().unwrap_or_default().to_string(),
        refresh: v.get("refresh_token").and_then(Value::as_str).map(str::to_string).or(s.refresh),
        expires_at: v.get("expires_in").and_then(Value::as_u64).map(|x| now() + x),
        ..s
    };
    save(server, &n).ok()?;
    Some(n.access)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::sync::mpsc;

    pub struct Req {
        pub method: String,
        pub path: String,
        pub query: HashMap<String, String>,
        pub headers: HashMap<String, String>,
        pub body: String,
    }
    pub enum Resp {
        Full(u16, Vec<(String, String)>, String),
        Stream(mpsc::UnboundedReceiver<String>),
    }
    pub fn resp(status: u16, ctype: &str, body: impl Into<String>) -> Resp {
        Resp::Full(status, vec![("Content-Type".into(), ctype.into())], body.into())
    }

    /// Minimal raw-HTTP mock server; returns its port.
    pub async fn mock(handler: Arc<dyn Fn(Req) -> Resp + Send + Sync>) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                let h = handler.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let end = loop {
                        let Ok(k) = s.read(&mut tmp).await else { return };
                        if k == 0 {
                            return;
                        }
                        buf.extend_from_slice(&tmp[..k]);
                        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break i + 4;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..end]).to_string();
                    let mut lines = head.lines();
                    let mut first = lines.next().unwrap_or("").split(' ');
                    let method = first.next().unwrap_or("").to_string();
                    let u = Url::parse(&format!("http://x{}", first.next().unwrap_or("/"))).unwrap();
                    let headers: HashMap<String, String> = lines
                        .filter_map(|l| l.split_once(':'))
                        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
                        .collect();
                    let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
                    while buf.len() < end + len {
                        let Ok(k) = s.read(&mut tmp).await else { return };
                        if k == 0 {
                            break;
                        }
                        buf.extend_from_slice(&tmp[..k]);
                    }
                    let body = String::from_utf8_lossy(&buf[end..]).to_string();
                    let req = Req {
                        method,
                        path: u.path().to_string(),
                        query: u.query_pairs().into_owned().collect(),
                        headers,
                        body,
                    };
                    match h(req) {
                        Resp::Full(st, hs, b) => {
                            let mut m = format!("HTTP/1.1 {st} X\r\nContent-Length: {}\r\nConnection: close\r\n", b.len());
                            for (k, v) in hs {
                                m.push_str(&format!("{k}: {v}\r\n"));
                            }
                            m.push_str("\r\n");
                            m.push_str(&b);
                            let _ = s.write_all(m.as_bytes()).await;
                        }
                        Resp::Stream(mut rx) => {
                            let _ = s
                                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n")
                                .await;
                            while let Some(chunk) = rx.recv().await {
                                if s.write_all(chunk.as_bytes()).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    let _ = s.shutdown().await;
                });
            }
        });
        port
    }

    /// Tauri async commands need Send futures.
    #[allow(dead_code)]
    fn futures_are_send() {
        fn send<T: Send>(_: T) {}
        send(authorize("a", "https://a.b/mcp", |_| {}));
        send(bearer_for("a"));
    }

    #[test]
    fn parses_www_authenticate() {
        let h = r#"Bearer error="invalid_token", resource_metadata="https://a.b/.well-known/oauth-protected-resource", scope=files"#;
        assert_eq!(auth_param(h, "resource_metadata").unwrap(), "https://a.b/.well-known/oauth-protected-resource");
        assert_eq!(auth_param(h, "scope").unwrap(), "files");
        assert!(auth_param(h, "metadata").is_none());
    }

    #[test]
    fn refuses_plain_http_off_loopback() {
        assert!(safe_url("http://evil.example/token").is_err());
        assert!(safe_url("http://127.0.0.1:9/token").is_ok());
        assert!(safe_url("https://as.example/token").is_ok());
        assert!(resource_matches("https://a.b/mcp", &Url::parse("https://a.b/mcp").unwrap()));
        assert!(!resource_matches("https://evil.b/mcp", &Url::parse("https://a.b/mcp").unwrap()));
    }

    #[derive(Default)]
    struct As {
        redirect: Option<String>,
        challenge: Option<String>,
        refreshes: usize,
        bad_state: bool,
    }

    /// Mock MCP resource server + authorization server on one origin. Validates PKCE,
    /// redirect_uri, resource and client_id exactly as a real AS must.
    async fn oauth_mock(bad_state: bool) -> (u16, Arc<Mutex<As>>) {
        let st = Arc::new(Mutex::new(As { bad_state, ..Default::default() }));
        let port_cell = Arc::new(std::sync::OnceLock::<u16>::new());
        let (s2, p2) = (st.clone(), port_cell.clone());
        let port = mock(Arc::new(move |r: Req| {
            let base = format!("http://127.0.0.1:{}", p2.get().unwrap());
            let mcp = format!("{base}/mcp");
            let mut a = s2.lock().unwrap();
            match (r.method.as_str(), r.path.as_str()) {
                (_, "/mcp") => {
                    let auth = r.headers.get("authorization").cloned().unwrap_or_default();
                    if auth != "Bearer AT2" {
                        return Resp::Full(
                            401,
                            vec![(
                                "WWW-Authenticate".into(),
                                format!(r#"Bearer resource_metadata="{base}/.well-known/oauth-protected-resource/mcp""#),
                            )],
                            String::new(),
                        );
                    }
                    let m: Value = serde_json::from_str(&r.body).unwrap_or(Value::Null);
                    let Some(id) = m.get("id").cloned() else { return resp(202, "text/plain", "") };
                    let result = match m["method"].as_str() {
                        Some("initialize") => json!({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "secure"}}),
                        Some("tools/list") => json!({"tools": [{"name": "whoami", "inputSchema": {"type": "object"}}]}),
                        _ => json!({}),
                    };
                    resp(200, "application/json", json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string())
                }
                ("GET", "/.well-known/oauth-protected-resource/mcp") => resp(
                    200,
                    "application/json",
                    json!({"resource": mcp, "authorization_servers": [base], "scopes_supported": ["mcp"]}).to_string(),
                ),
                ("GET", "/.well-known/oauth-authorization-server") => resp(
                    200,
                    "application/json",
                    json!({
                        "issuer": base,
                        "authorization_endpoint": format!("{base}/authorize"),
                        "token_endpoint": format!("{base}/token"),
                        "registration_endpoint": format!("{base}/register"),
                        "code_challenge_methods_supported": ["S256"],
                    })
                    .to_string(),
                ),
                ("POST", "/register") => {
                    let v: Value = serde_json::from_str(&r.body).unwrap();
                    assert_eq!(v["client_name"], "OpenClaude Desktop");
                    a.redirect = v["redirect_uris"][0].as_str().map(str::to_string);
                    resp(201, "application/json", json!({"client_id": "cid"}).to_string())
                }
                ("GET", "/authorize") => {
                    let q = &r.query;
                    let ok = q.get("client_id").map(String::as_str) == Some("cid")
                        && q.get("response_type").map(String::as_str) == Some("code")
                        && q.get("code_challenge_method").map(String::as_str) == Some("S256")
                        && q.get("resource") == Some(&mcp)
                        && q.get("scope").map(String::as_str) == Some("mcp")
                        && q.get("redirect_uri") == a.redirect.as_ref();
                    if !ok {
                        return resp(400, "text/plain", "bad authorize request");
                    }
                    a.challenge = q.get("code_challenge").cloned();
                    let state = if a.bad_state { "forged".to_string() } else { q["state"].clone() };
                    let mut loc = Url::parse(&q["redirect_uri"]).unwrap();
                    loc.query_pairs_mut().append_pair("code", "CODE").append_pair("state", &state).append_pair("iss", &base);
                    Resp::Full(302, vec![("Location".into(), loc.to_string())], String::new())
                }
                ("POST", "/token") => {
                    let f: HashMap<String, String> = url::form_urlencoded::parse(r.body.as_bytes()).into_owned().collect();
                    if f.get("resource") != Some(&mcp) || f.get("client_id").map(String::as_str) != Some("cid") {
                        return resp(400, "application/json", r#"{"error":"invalid_target"}"#);
                    }
                    match f["grant_type"].as_str() {
                        "authorization_code" => {
                            let pkce_ok = a.challenge.as_deref() == Some(challenge(&f["code_verifier"]).as_str());
                            if f["code"] != "CODE" || !pkce_ok || f.get("redirect_uri") != a.redirect.as_ref() {
                                return resp(400, "application/json", r#"{"error":"invalid_grant"}"#);
                            }
                            // Already inside the refresh skew: forces bearer_for to refresh.
                            resp(200, "application/json", json!({"access_token": "AT1", "token_type": "Bearer", "expires_in": 30, "refresh_token": "RT1"}).to_string())
                        }
                        "refresh_token" if f["refresh_token"] == "RT1" => {
                            a.refreshes += 1;
                            resp(200, "application/json", json!({"access_token": "AT2", "token_type": "bearer", "expires_in": 3600, "refresh_token": "RT2"}).to_string())
                        }
                        _ => resp(400, "application/json", r#"{"error":"invalid_grant"}"#),
                    }
                }
                _ => resp(404, "text/plain", ""),
            }
        }))
        .await;
        port_cell.set(port).unwrap();
        (port, st)
    }

    /// Plays the browser: follows the authorize redirect to the loopback callback.
    fn browser(url: String) {
        tokio::spawn(async move {
            let _ = reqwest::get(url).await;
        });
    }

    #[tokio::test]
    async fn oauth_full_flow_with_pkce_refresh_and_auth_required() {
        let name = format!("oc-test-{}", uuid::Uuid::new_v4());
        let (port, st) = oauth_mock(false).await;
        let mcp_url = format!("http://127.0.0.1:{port}/mcp");
        let mut cfg = crate::mcp::McpConfig::default();
        cfg.servers.insert(name.clone(), crate::mcp::ServerConfig { url: Some(mcp_url.clone()), ..Default::default() });
        let m = crate::mcp::McpManager::default();
        m.set_config(&cfg).await;

        // Unauthenticated connect → auth_required, no browser.
        m.start(&name).await;
        let s = &m.statuses().await[0];
        assert_eq!((s.state.as_str(), s.error.as_deref()), ("auth_required", Some("Sign-in required")));

        let r = authorize(&name, &mcp_url, browser).await;
        assert!(r.is_ok(), "{r:?}");
        assert_eq!(bearer_for(&name).await.as_deref(), Some("AT2"), "expired token should refresh");
        assert_eq!(bearer_for(&name).await.as_deref(), Some("AT2"));
        assert_eq!(st.lock().unwrap().refreshes, 1);
        assert!(bearer_for_resource(&name, "https://other.example/mcp").await.is_none());

        m.start(&name).await;
        let s = &m.statuses().await[0];
        assert_eq!(s.state, "connected", "{:?}", s.error);
        assert_eq!(s.tools.len(), 1);
        m.stop_all().await;

        forget(&name);
        assert!(bearer_for(&name).await.is_none());
    }

    #[tokio::test]
    async fn oauth_rejects_forged_state() {
        let name = format!("oc-test-{}", uuid::Uuid::new_v4());
        let (port, _) = oauth_mock(true).await;
        let r = authorize_with(&name, &format!("http://127.0.0.1:{port}/mcp"), browser, Duration::from_secs(3)).await;
        assert!(r.unwrap_err().to_string().contains("timed out"));
        assert!(bearer_for(&name).await.is_none());
        forget(&name);
    }
}
