"""Secret scan for a git repo: working tree + full history. Never prints secret values.

usage: python -I desktop/scripts/secret_scan.py <repo> [env-file] [signing-key-file]

Pattern checks cover common key formats. The optional files enable exact-value checks of your real
secrets (compared in memory, never printed); keep those files outside the repo.
"""
import base64, os, re, subprocess, sys

repo = sys.argv[1]
env_file = sys.argv[2] if len(sys.argv) > 2 else ""
key_file = sys.argv[3] if len(sys.argv) > 3 else ""

PATTERNS = {
    "openai": re.compile(r"\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}"),
    "anthropic": re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
    "github": re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|\bgithub_pat_[A-Za-z0-9_]{60,}"),
    "aws-access-key": re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    "google-api": re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
    "slack": re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{10,}"),
    "huggingface": re.compile(r"\bhf_[A-Za-z0-9]{30,}"),
    "private-key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----"),
    "minisign-secret": re.compile(r"untrusted comment: (?:rsign|minisign) encrypted secret key"),
    "generic-assignment": re.compile(r"""(?i)\b(?:api[_-]?key|secret|token|passw(?:or)?d|master[_-]?key)\b\s*[:=]\s*["']([A-Za-z0-9_\-./+=]{24,})["']"""),
}
# Obvious placeholders and test fixtures.
ALLOW = re.compile(r"(?i)example|placeholder|dummy|fake|test|issued-for|xxxx|your[-_]|<[^>]+>|\$\{|sk-\.\.\.|changeme|redacted|0000000000|abcdef|sk-1234")


def real_secrets():
    out = {}
    for line in (open(env_file, encoding="utf-8", errors="replace") if env_file and os.path.exists(env_file) else []):
        m = re.match(r"\s*([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*(.+)", line)
        if m:
            v = m.group(2).strip().strip('"').strip("'")
            if len(v) >= 12:
                out[f"env:{m.group(1)}"] = v
    if key_file and os.path.exists(key_file):
        raw = open(key_file, encoding="utf-8", errors="replace").read().strip()
        out["tauri-signing-key(file)"] = raw
        try:
            for i, line in enumerate(base64.b64decode(raw).decode(errors="replace").splitlines()):
                if len(line) > 40 and "comment" not in line:
                    out[f"tauri-signing-key(line{i})"] = line.strip()
        except Exception:
            pass
    return out


secrets = real_secrets()
findings = []


def scan_text(where, text):
    for name, rx in PATTERNS.items():
        for m in rx.finditer(text):
            snippet = text[max(0, m.start() - 40): m.end() + 10]
            if ALLOW.search(snippet):
                continue
            findings.append((name, where, m.group(0)[:6] + "…" + f"(len {len(m.group(0))})"))
    for label, value in secrets.items():
        if value and value in text:
            findings.append(("EXACT " + label, where, "value present"))


# 1. working tree (tracked files)
files = subprocess.run(["git", "-C", repo, "ls-files", "-z"], capture_output=True).stdout.decode(errors="replace").split("\0")
for f in filter(None, files):
    p = os.path.join(repo, f)
    try:
        if os.path.getsize(p) > 3_000_000:
            continue
        scan_text(f"tree:{f}", open(p, encoding="utf-8", errors="replace").read())
    except OSError:
        pass
tree_hits = len(findings)

# 2. history: every added line of every commit on every ref
proc = subprocess.Popen(["git", "-C", repo, "log", "--all", "-p", "-U0", "--no-color", "--format=commit %H"], stdout=subprocess.PIPE)
commit, path, buf = "", "", []
def flush():
    if buf:
        scan_text(f"hist:{commit[:8]}:{path}", "\n".join(buf))
for raw in proc.stdout:
    line = raw.decode("utf-8", errors="replace").rstrip("\n")
    if line.startswith("commit "):
        flush(); buf = []; commit = line[7:]
    elif line.startswith("+++ "):
        flush(); buf = []; path = line[6:] if line.startswith("+++ b/") else line[4:]
    elif line.startswith("+") and not line.startswith("+++"):
        buf.append(line[1:])
flush()

print(f"real secrets checked by exact value: {len(secrets)} ({', '.join(sorted({k.split('(')[0] for k in secrets}))})")
print(f"working-tree findings: {tree_hits}; history findings: {len(findings) - tree_hits}")
seen = set()
for name, where, info in findings:
    key = (name, where.split(':', 2)[-1], info)
    if key in seen:
        continue
    seen.add(key)
    print(f"  {name:22} {where[:110]}  {info}")
