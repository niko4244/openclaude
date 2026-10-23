//! Connector directory backed by the official MCP Registry (read-only, fixed host).

use serde::Serialize;
use serde_json::Value;

pub const BASE: &str = "https://registry.modelcontextprotocol.io/v0/servers";

#[derive(Serialize, Debug, Default, Clone)]
pub struct Remote {
    pub kind: String,
    pub url: String,
}

#[derive(Serialize, Debug, Default, Clone)]
pub struct Package {
    pub registry: String,
    pub identifier: String,
    pub version: Option<String>,
    pub required_env: Vec<String>,
}

#[derive(Serialize, Debug, Default, Clone)]
pub struct Entry {
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    pub version: Option<String>,
    pub website: Option<String>,
    pub remotes: Vec<Remote>,
    pub packages: Vec<Package>,
}

#[derive(Serialize, Debug, Default)]
pub struct Page {
    pub entries: Vec<Entry>,
    pub next_cursor: Option<String>,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

/// Parse one registry response page. Only https remotes and npm/pypi packages are kept:
/// those are the forms OpenClaude can install (HTTP connector or npx/uvx stdio).
pub fn parse(v: &Value) -> Page {
    let entries = v
        .get("servers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|it| it.get("server").unwrap_or(it))
        .filter_map(|srv| {
            let remotes: Vec<Remote> = srv
                .get("remotes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|r| {
                    let url = s(r, "url")?;
                    url.starts_with("https://").then(|| Remote { kind: s(r, "type").unwrap_or_else(|| "streamable-http".into()), url })
                })
                .collect();
            let packages: Vec<Package> = srv
                .get("packages")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|p| {
                    let registry = s(p, "registryType")?;
                    if !matches!(registry.as_str(), "npm" | "pypi") {
                        return None;
                    }
                    Some(Package {
                        registry,
                        identifier: s(p, "identifier")?,
                        version: s(p, "version"),
                        required_env: p
                            .get("environmentVariables")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter(|e| e.get("isRequired").and_then(Value::as_bool).unwrap_or(false))
                            .filter_map(|e| s(e, "name"))
                            .collect(),
                    })
                })
                .collect();
            if remotes.is_empty() && packages.is_empty() {
                return None;
            }
            Some(Entry {
                name: s(srv, "name")?,
                title: s(srv, "title").filter(|t| !t.is_empty()),
                description: s(srv, "description").unwrap_or_default(),
                version: s(srv, "version"),
                website: s(srv, "websiteUrl").or_else(|| srv.pointer("/repository/url").and_then(Value::as_str).map(str::to_string)),
                remotes,
                packages,
            })
        })
        .collect();
    Page { entries, next_cursor: v.pointer("/metadata/nextCursor").and_then(Value::as_str).map(str::to_string) }
}

pub async fn search(query: Option<&str>, cursor: Option<&str>) -> anyhow::Result<Page> {
    let mut url = url::Url::parse(BASE)?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("limit", "30");
        if let Some(t) = query.filter(|t| !t.trim().is_empty()) {
            q.append_pair("search", t.trim());
        }
        if let Some(c) = cursor {
            q.append_pair("cursor", c);
        }
    }
    let r = reqwest::Client::new().get(url).timeout(std::time::Duration::from_secs(20)).send().await?.error_for_status()?;
    Ok(parse(&r.json().await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_installable_forms_only() {
        let v = json!({"servers": [
            {"server": {"name": "a/remote", "description": "r", "remotes": [{"type": "streamable-http", "url": "https://x/mcp"}, {"type": "sse", "url": "http://insecure/sse"}]}},
            {"server": {"name": "b/npm", "description": "n", "packages": [{"registryType": "npm", "identifier": "@x/y", "version": "1.2.3",
                "environmentVariables": [{"name": "API_KEY", "isRequired": true}, {"name": "OPT"}]}]}},
            {"server": {"name": "c/oci-only", "packages": [{"registryType": "oci", "identifier": "img"}]}}
        ], "metadata": {"nextCursor": "c1"}});
        let p = parse(&v);
        assert_eq!(p.entries.len(), 2, "oci-only entry dropped");
        assert_eq!(p.entries[0].remotes.len(), 1, "plain-http remote dropped");
        assert_eq!(p.entries[1].packages[0].required_env, vec!["API_KEY"]);
        assert_eq!(p.next_cursor.as_deref(), Some("c1"));
    }

    #[tokio::test]
    #[ignore = "network: registry.modelcontextprotocol.io"]
    async fn live_registry_search() {
        let p = search(Some("github"), None).await.unwrap();
        println!("{} entries, next={:?}", p.entries.len(), p.next_cursor);
        assert!(!p.entries.is_empty());
    }
}
