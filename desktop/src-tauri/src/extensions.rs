//! Desktop extensions (.mcpb, formerly .dxt): a zip with manifest.json plus server
//! code. Installing extracts the bundle into the app's extensions folder and
//! registers an MCP server entry. Sensitive user_config values go to the OS
//! credential store and reach the server as `keyring:` env references.

use crate::mcp::ServerConfig;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};

pub const KEYRING_SERVICE: &str = "openclaude-desktop-ext";
const MAX_BUNDLE: u64 = 200 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
pub struct UserConfigField {
    pub key: String,
    pub kind: String,
    pub title: String,
    pub description: Option<String>,
    pub required: bool,
    pub sensitive: bool,
    pub default: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Preview {
    pub name: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    pub author: Option<String>,
    pub server_type: String,
    pub tools: Vec<String>,
    pub user_config: Vec<UserConfigField>,
    /// The reference format appends a PKCS#7 block; we detect it but do not verify it yet.
    pub signature: String,
    pub manifest_version: String,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

pub fn read_manifest(bundle: &Path) -> anyhow::Result<(Value, Preview)> {
    let meta = std::fs::metadata(bundle)?;
    if meta.len() > MAX_BUNDLE {
        anyhow::bail!("bundle is larger than 200 MB");
    }
    let bytes = std::fs::read(bundle)?;
    let signature = crate::sigverify::verify(&bytes).label();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    let mut text = String::new();
    zip.by_name("manifest.json").map_err(|_| anyhow::anyhow!("manifest.json not found in bundle"))?.read_to_string(&mut text)?;
    let m: Value = serde_json::from_str(&text)?;
    let name = s(&m, "name").ok_or_else(|| anyhow::anyhow!("manifest has no name"))?;
    if name.is_empty() || name.len() > 64 || !name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
        anyhow::bail!("invalid extension name `{name}`");
    }
    let server = m.get("server").cloned().unwrap_or(Value::Null);
    let user_config = m
        .get("user_config")
        .and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .map(|(k, f)| UserConfigField {
                    key: k.clone(),
                    kind: s(f, "type").unwrap_or_else(|| "string".into()),
                    title: s(f, "title").unwrap_or_else(|| k.clone()),
                    description: s(f, "description"),
                    required: f.get("required").and_then(Value::as_bool).unwrap_or(false),
                    sensitive: f.get("sensitive").and_then(Value::as_bool).unwrap_or(false),
                    default: f.get("default").cloned(),
                })
                .collect()
        })
        .unwrap_or_default();
    let preview = Preview {
        display_name: s(&m, "display_name").unwrap_or_else(|| name.clone()),
        name,
        version: s(&m, "version").unwrap_or_default(),
        description: s(&m, "description").unwrap_or_default(),
        author: m.get("author").and_then(|a| s(a, "name").or_else(|| a.as_str().map(str::to_string))),
        server_type: s(&server, "type").unwrap_or_else(|| "unknown".into()),
        tools: m.get("tools").and_then(Value::as_array).map(|t| t.iter().filter_map(|x| s(x, "name")).collect()).unwrap_or_default(),
        user_config,
        signature,
        manifest_version: s(&m, "manifest_version").or_else(|| s(&m, "dxt_version")).unwrap_or_default(),
    };
    Ok((m, preview))
}

/// Extract with zip-slip protection.
fn extract(bundle: &Path, dest: &Path) -> anyhow::Result<()> {
    if dest.exists() {
        std::fs::remove_dir_all(dest)?;
    }
    std::fs::create_dir_all(dest)?;
    let mut zip = zip::ZipArchive::new(std::fs::File::open(bundle)?)?;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i)?;
        let Some(rel) = f.enclosed_name() else { anyhow::bail!("unsafe path in bundle: {}", f.name()) };
        let out = dest.join(rel);
        if f.is_dir() {
            std::fs::create_dir_all(&out)?;
        } else {
            if let Some(p) = out.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::io::copy(&mut f, &mut std::fs::File::create(&out)?)?;
        }
    }
    Ok(())
}

fn substitute(v: &str, dir: &Path, cfg: &HashMap<String, String>) -> String {
    let mut out = v.replace("${__dirname}", &dir.to_string_lossy());
    if let Some(home) = dirs::home_dir() {
        out = out.replace("${HOME}", &home.to_string_lossy());
    }
    for (k, val) in cfg {
        out = out.replace(&format!("${{user_config.{k}}}"), val);
    }
    out
}

/// Install `bundle` under `ext_root/<name>` and return the MCP server entry to register.
pub fn install(bundle: &Path, ext_root: &Path, values: &BTreeMap<String, String>) -> anyhow::Result<(String, ServerConfig)> {
    let (m, preview) = read_manifest(bundle)?;
    // A signature that doesn't match the content means the bundle was altered after signing.
    if preview.signature.starts_with("INVALID") {
        anyhow::bail!("refusing to install: {}", preview.signature);
    }
    for f in &preview.user_config {
        if f.required && values.get(&f.key).is_none_or(|v| v.trim().is_empty()) && f.default.is_none() {
            anyhow::bail!("`{}` is required", f.title);
        }
    }
    let dir: PathBuf = ext_root.join(&preview.name);
    extract(bundle, &dir)?;
    // Sensitive values: OS credential store, referenced as keyring:<service-user>.
    let mut resolved: HashMap<String, String> = HashMap::new();
    for f in &preview.user_config {
        let val = values
            .get(&f.key)
            .cloned()
            .filter(|v| !v.is_empty())
            .or_else(|| f.default.as_ref().map(|d| d.as_str().map(str::to_string).unwrap_or_else(|| d.to_string())))
            .unwrap_or_default();
        if f.sensitive && !val.is_empty() {
            let user = format!("{}/{}", preview.name, f.key);
            keyring::Entry::new(KEYRING_SERVICE, &user)?.set_password(&val)?;
            resolved.insert(f.key.clone(), format!("keyring:{user}"));
        } else {
            resolved.insert(f.key.clone(), val);
        }
    }
    let mc = m.pointer("/server/mcp_config").cloned().unwrap_or(Value::Null);
    let command = mc.get("command").and_then(Value::as_str).map(|c| substitute(c, &dir, &resolved)).or_else(|| {
        // Fall back to the documented defaults per server type.
        let entry = m.pointer("/server/entry_point").and_then(Value::as_str)?;
        Some(match preview.server_type.as_str() {
            "node" => "node".into(),
            "python" => "python".into(),
            _ => dir.join(entry).to_string_lossy().into(),
        })
    });
    let mut args: Vec<String> = mc.get("args").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(|x| substitute(x, &dir, &resolved)).collect()).unwrap_or_default();
    if mc.get("command").is_none() && matches!(preview.server_type.as_str(), "node" | "python") {
        if let Some(entry) = m.pointer("/server/entry_point").and_then(Value::as_str) {
            args.insert(0, dir.join(entry).to_string_lossy().into());
        }
    }
    let env = mc
        .get("env")
        .and_then(Value::as_object)
        .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|x| (k.clone(), substitute(x, &dir, &resolved)))).collect())
        .unwrap_or_default();
    let cfg = ServerConfig { command: Some(command.ok_or_else(|| anyhow::anyhow!("manifest has no server command"))?), args, env, ..Default::default() };
    Ok((preview.name, cfg))
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::io::Write;

    pub fn make_bundle(dir: &Path, manifest: &Value, extra: &[(&str, &str)]) -> PathBuf {
        let path = dir.join("test.mcpb");
        let mut z = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let opts: zip::write::SimpleFileOptions = Default::default();
        z.start_file("manifest.json", opts).unwrap();
        z.write_all(manifest.to_string().as_bytes()).unwrap();
        for (name, body) in extra {
            z.start_file(*name, opts).unwrap();
            z.write_all(body.as_bytes()).unwrap();
        }
        z.finish().unwrap();
        path
    }

    #[test]
    fn preview_and_install_resolve_placeholders() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = serde_json::json!({
            "manifest_version": "0.2", "name": "hello-ext", "display_name": "Hello", "version": "1.0.0",
            "description": "demo", "author": {"name": "OC"},
            "server": {"type": "python", "entry_point": "server.py",
                "mcp_config": {"command": "python", "args": ["${__dirname}/server.py", "--root", "${user_config.root}"], "env": {"MODE": "${user_config.mode}"}}},
            "tools": [{"name": "greet"}],
            "user_config": {"root": {"type": "directory", "title": "Root", "required": true}, "mode": {"type": "string", "title": "Mode", "default": "fast"}}
        });
        let bundle = make_bundle(dir.path(), &manifest, &[("server.py", "print('hi')")]);
        let (_, p) = read_manifest(&bundle).unwrap();
        assert_eq!(p.display_name, "Hello");
        assert_eq!(p.tools, vec!["greet"]);
        assert_eq!(p.signature, "unsigned");
        let ext_root = dir.path().join("ext");
        assert!(install(&bundle, &ext_root, &BTreeMap::new()).is_err(), "required field enforced");
        let mut vals = BTreeMap::new();
        vals.insert("root".to_string(), "C:/data".to_string());
        let (name, cfg) = install(&bundle, &ext_root, &vals).unwrap();
        assert_eq!(name, "hello-ext");
        assert!(ext_root.join("hello-ext/server.py").is_file());
        assert!(cfg.args[0].ends_with("server.py") && cfg.args[0].contains("hello-ext"));
        assert_eq!(cfg.args[2], "C:/data");
        assert_eq!(cfg.env["MODE"], "fast");
    }

    #[tokio::test]
    async fn installed_bundle_runs_as_connector() {
        if std::process::Command::new("python").arg("--version").output().is_err() {
            return;
        }
        let server = r#"
import sys, json
for line in sys.stdin:
    m = json.loads(line)
    if 'id' not in m: continue
    r = {'protocolVersion': '2025-06-18', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'bundled'}} if m['method'] == 'initialize' else         {'tools': [{'name': 'ping', 'inputSchema': {'type': 'object'}}]} if m['method'] == 'tools/list' else {}
    print(json.dumps({'jsonrpc': '2.0', 'id': m['id'], 'result': r}), flush=True)
"#;
        let dir = tempfile::tempdir().unwrap();
        let manifest = serde_json::json!({"manifest_version": "0.2", "name": "bundled-echo", "version": "0.1.0",
            "server": {"type": "python", "entry_point": "server.py", "mcp_config": {"command": "python", "args": ["${__dirname}/server.py"]}}});
        let bundle = make_bundle(dir.path(), &manifest, &[("server.py", server)]);
        let (name, cfg) = install(&bundle, &dir.path().join("ext"), &BTreeMap::new()).unwrap();
        let mut mc = crate::mcp::McpConfig::default();
        mc.servers.insert(name.clone(), cfg);
        let m = crate::mcp::McpManager::default();
        m.set_config(&mc).await;
        m.start_all().await;
        let st = m.statuses().await;
        assert_eq!(st[0].state, "connected", "{:?} {:?}", st[0].error, st[0].log_tail);
        assert_eq!(st[0].tools[0].name, "ping");
        m.stop_all().await;
    }

    #[test]
    fn rejects_zip_slip_and_bad_names() {
        let dir = tempfile::tempdir().unwrap();
        let ok = serde_json::json!({"name": "evil", "server": {"type": "binary", "mcp_config": {"command": "x"}}});
        let bundle = make_bundle(dir.path(), &ok, &[("../../escape.txt", "x")]);
        assert!(install(&bundle, &dir.path().join("ext"), &BTreeMap::new()).is_err());
        assert!(!dir.path().join("escape.txt").exists());
        let bad = serde_json::json!({"name": "../x", "server": {}});
        let b2 = make_bundle(dir.path(), &bad, &[]);
        assert!(read_manifest(&b2).is_err());
    }
}
