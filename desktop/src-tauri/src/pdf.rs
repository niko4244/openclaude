//! PDF text extraction for chat attachments and project knowledge files.

use anyhow::{anyhow, Result};

/// Maximum number of characters returned from a PDF.
const MAX_CHARS: usize = 2_000_000;

/// True when the bytes start with the PDF magic (`%PDF-`).
pub fn is_pdf(bytes: &[u8]) -> bool {
    bytes.starts_with(b"%PDF-")
}

/// Extract plain text from PDF bytes. Never panics on malformed input.
pub fn extract_text(bytes: &[u8]) -> Result<String> {
    // pdf-extract can panic on malformed files; contain the panic and return an Err.
    let raw = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(bytes))
        .map_err(|_| anyhow!("PDF is malformed or unsupported (parser panicked)"))?
        .map_err(|e| anyhow!("failed to extract PDF text: {e}"))?;

    let text = normalize(&raw);
    if text.is_empty() {
        return Err(anyhow!("PDF has no extractable text (scanned image?)"));
    }
    Ok(text)
}

/// Trim each line, collapse 3+ newlines to 2, trim ends, cap length.
fn normalize(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(MAX_CHARS + 16));
    let mut newlines = 0usize;
    for line in raw.replace('\r', "").split('\n') {
        let line = line.trim();
        if line.is_empty() {
            newlines += 1;
            continue;
        }
        if !out.is_empty() {
            // First blank-free break = 1 newline; any blank lines => 2 (paragraph).
            out.push_str(if newlines > 0 { "\n\n" } else { "\n" });
        }
        newlines = 0;
        out.push_str(line);
        if out.chars().count() > MAX_CHARS {
            break;
        }
    }
    if out.chars().count() > MAX_CHARS {
        out = out.chars().take(MAX_CHARS).collect();
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal valid single-page PDF with correct xref offsets.
    fn minimal_pdf(text: &str) -> Vec<u8> {
        let stream = format!("BT /F1 24 Tf 72 700 Td ({text}) Tj ET");
        let objs = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
             /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"
                .to_string(),
            format!("<< /Length {} >>\nstream\n{}\nendstream", stream.len(), stream),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, body) in objs.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", i + 1, body).as_bytes());
        }
        let xref_pos = pdf.len();
        pdf.extend_from_slice(format!("xref\n0 {}\n", objs.len() + 1).as_bytes());
        pdf.extend_from_slice(b"0000000000 65535 f \n");
        for off in &offsets {
            pdf.extend_from_slice(format!("{:010} 00000 n \n", off).as_bytes());
        }
        pdf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
                objs.len() + 1,
                xref_pos
            )
            .as_bytes(),
        );
        pdf
    }

    #[test]
    fn pdf_extracts_hello_text() {
        let pdf = minimal_pdf("Hello PDF knowledge");
        assert!(is_pdf(&pdf));
        let text = extract_text(&pdf).expect("extract");
        assert!(text.contains("Hello PDF knowledge"), "got: {text:?}");
    }

    #[test]
    fn pdf_malformed_bytes_error_not_panic() {
        assert!(extract_text(b"%PDF-1.4 garbage garbage").is_err());
        assert!(extract_text(b"").is_err());
        assert!(extract_text(&[0xff, 0x00, 0x13, 0x37]).is_err());
    }

    #[test]
    fn pdf_is_pdf_cases() {
        assert!(is_pdf(b"%PDF-1.7\n..."));
        assert!(!is_pdf(b"PK\x03\x04"));
        assert!(!is_pdf(b"%PD"));
        assert!(!is_pdf(b""));
    }

    #[test]
    fn pdf_empty_text_is_clear_error() {
        let pdf = minimal_pdf("");
        let err = extract_text(&pdf).unwrap_err().to_string();
        assert!(err.contains("no extractable text"), "got: {err}");
    }

    #[test]
    fn pdf_normalize_whitespace_and_cap() {
        assert_eq!(normalize("  a  \r\n\n\n\n  b \nc\n\n"), "a\n\nb\nc");
        let big = "x".repeat(MAX_CHARS + 500);
        assert_eq!(normalize(&big).chars().count(), MAX_CHARS);
    }
}
