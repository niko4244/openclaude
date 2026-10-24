//! Project knowledge: whole files when they fit, otherwise the most relevant
//! chunks for the current question (local lexical retrieval, no network).

use std::collections::HashMap;

pub const FULL_BUDGET: usize = 60_000;
pub const RETRIEVAL_BUDGET: usize = 40_000;
const CHUNK: usize = 1_500;

pub struct Doc {
    pub name: String,
    pub text: String,
}

fn terms(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() > 2)
        .map(|w| w.to_lowercase())
        .collect()
}

/// Split on paragraph boundaries into ~CHUNK-sized pieces.
fn chunks(text: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    for para in text.split("\n\n") {
        if cur.len() + para.len() > CHUNK && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
        if para.len() > CHUNK {
            let mut start = 0;
            while start < para.len() {
                let mut end = (start + CHUNK).min(para.len());
                while !para.is_char_boundary(end) {
                    end -= 1;
                }
                out.push(para[start..end].to_string());
                start = end;
            }
        } else {
            if !cur.is_empty() {
                cur.push_str("\n\n");
            }
            cur.push_str(para);
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

/// Builds the knowledge section of the system prompt for `query`.
pub fn context_for(docs: &[Doc], query: &str) -> Option<String> {
    if docs.is_empty() {
        return None;
    }
    let total: usize = docs.iter().map(|d| d.text.len()).sum();
    if total <= FULL_BUDGET {
        let body = docs.iter().map(|d| format!("<document name=\"{}\">\n{}\n</document>", d.name, d.text)).collect::<Vec<_>>().join("\n");
        return Some(format!("The user attached these project knowledge files. Use them when relevant and cite file names.\n{body}"));
    }
    // BM25-style scoring over chunks.
    let all: Vec<(String, String)> = docs.iter().flat_map(|d| chunks(&d.text).into_iter().map(move |c| (d.name.clone(), c))).collect();
    let n = all.len() as f64;
    let chunk_terms: Vec<HashMap<String, usize>> = all
        .iter()
        .map(|(_, c)| terms(c).into_iter().fold(HashMap::new(), |mut m, t| { *m.entry(t).or_default() += 1; m }))
        .collect();
    let avg_len = chunk_terms.iter().map(|m| m.values().sum::<usize>()).sum::<usize>() as f64 / n.max(1.0);
    let q = terms(query);
    let mut scored: Vec<(f64, usize)> = chunk_terms
        .iter()
        .enumerate()
        .map(|(i, tf)| {
            let len = tf.values().sum::<usize>() as f64;
            let s = q
                .iter()
                .map(|t| {
                    let df = chunk_terms.iter().filter(|m| m.contains_key(t)).count() as f64;
                    let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();
                    let f = *tf.get(t).unwrap_or(&0) as f64;
                    idf * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * len / avg_len.max(1.0)))
                })
                .sum::<f64>();
            (s, i)
        })
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut used = 0;
    let mut picked = vec![];
    for (score, i) in scored {
        if score <= 0.0 && !picked.is_empty() {
            break;
        }
        let (name, text) = &all[i];
        if used + text.len() > RETRIEVAL_BUDGET {
            break;
        }
        used += text.len();
        picked.push(format!("<excerpt file=\"{name}\">\n{text}\n</excerpt>"));
    }
    Some(format!(
        "The project has {} knowledge files ({} KB), too large to include in full. These are the excerpts most relevant to the latest message; say so if they are not enough.\n{}",
        docs.len(),
        total / 1024,
        picked.join("\n")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_projects_get_whole_files() {
        let docs = vec![Doc { name: "a.md".into(), text: "alpha".into() }];
        let c = context_for(&docs, "anything").unwrap();
        assert!(c.contains("<document name=\"a.md\">\nalpha"));
    }

    #[test]
    fn large_projects_retrieve_relevant_chunks() {
        let filler = "lorem ipsum dolor sit amet consectetur ".repeat(60);
        let mut text = String::new();
        for i in 0..80 {
            text.push_str(&format!("Section {i}. {filler}\n\n"));
        }
        text.push_str("The deployment password rotation happens every Tuesday via the vault job.\n\n");
        let docs = vec![Doc { name: "ops.md".into(), text }];
        assert!(docs[0].text.len() > FULL_BUDGET);
        let c = context_for(&docs, "when does password rotation happen?").unwrap();
        assert!(c.contains("rotation happens every Tuesday"), "relevant chunk must be retrieved");
        assert!(c.len() < RETRIEVAL_BUDGET + 2_000);
    }
}
