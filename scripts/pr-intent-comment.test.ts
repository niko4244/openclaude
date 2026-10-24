import { describe, expect, test } from 'bun:test'

import {
  checkOutcome,
  parseReport,
  renderComment,
  renderFailure,
  type ScanFinding,
} from './pr-intent-comment.ts'

const MARKER = '<!-- pr-intent-scan -->'

function finding(overrides: Partial<ScanFinding> = {}): ScanFinding {
  return {
    severity: 'high',
    code: 'powershell-encoded',
    file: 'desktop/e2e/perf.e2e.mjs',
    line: 85,
    detail: 'Added encoded PowerShell invocation',
    excerpt: 'powershell -NoProfile -EncodedCommand SQBtAA==',
    ...overrides,
  }
}

describe('renderComment', () => {
  test('renders a sticky marker, counts, and locations', () => {
    const body = renderComment({
      baseRef: '36b7ffd69aca678d',
      headRef: 'bd04f8ef6ed67bf4',
      addedLines: 45685,
      findings: [
        finding(),
        finding({
          severity: 'medium',
          code: 'long-encoded-payload',
          file: 'desktop/src-tauri/tauri.conf.json',
          line: 60,
          detail: 'Added long encoded blob or token-like payload',
        }),
      ],
    })

    expect(body.startsWith(MARKER)).toBe(true)
    expect(body).toContain('**1 high**, **1 medium**')
    expect(body).toContain('45,685')
    expect(body).toContain('`desktop/e2e/perf.e2e.mjs:85`')
    expect(body).toContain('`desktop/src-tauri/tauri.conf.json:60`')
  })

  test('escapes table-breaking characters in file names and details', () => {
    const body = renderComment({
      baseRef: 'aaaaaaaa',
      headRef: 'bbbbbbbb',
      addedLines: 3,
      findings: [
        finding({
          file: 'docs/a|b.md',
          detail: 'Added <script> and a | pipe',
        }),
      ],
    })

    expect(body).toContain('docs/a\\|b.md:85')
    expect(body).toContain('Added &lt;script&gt; and a \\| pipe')
    expect(body).not.toContain('Added <script> and a | pipe')
  })

  test('reports a clean scan without a findings table', () => {
    const body = renderComment({
      baseRef: 'aaaaaaaa',
      headRef: 'bbbbbbbb',
      addedLines: 12,
      findings: [],
    })

    expect(body.startsWith(MARKER)).toBe(true)
    expect(body).toContain('No suspicious additions found')
    expect(body).not.toContain('| Severity |')
  })

  test('caps the table and mentions the remainder', () => {
    const findings = Array.from({ length: 30 }, (_, index) =>
      finding({ line: index + 1 }),
    )
    const body = renderComment({
      baseRef: 'aaaaaaaa',
      headRef: 'bbbbbbbb',
      addedLines: 30,
      findings,
    })

    expect(body).toContain('_5 more finding(s) in the job log._')
    expect(body.match(/^\| high \|/gm)).toHaveLength(25)
  })
})

describe('parseReport', () => {
  test('treats a report from the pull request run as bounded data', () => {
    const report = parseReport(
      JSON.stringify({
        baseRef: 'a'.repeat(500),
        headRef: 'bbbbbbbb',
        addedLines: 12.9,
        findings: [
          { severity: 'high', file: 'f.mjs', line: 4, detail: 'd', excerpt: 'e'.repeat(4000) },
          { severity: 'critical', file: 'g.mjs', line: 5, detail: 'd', excerpt: 'e' },
          { severity: 'medium', file: 42, line: 6, detail: 'd', excerpt: 'e' },
        ],
      }),
    )

    expect(report?.baseRef).toHaveLength(100)
    expect(report?.addedLines).toBe(12)
    expect(report?.findings).toHaveLength(1)
    expect(report?.findings[0].excerpt).toHaveLength(500)
  })

  test('caps the number of findings it accepts', () => {
    const findings = Array.from({ length: 500 }, (_, index) => ({
      severity: 'medium',
      file: 'f.mjs',
      line: index,
      detail: 'd',
      excerpt: 'e',
    }))

    expect(parseReport(JSON.stringify({ findings }))?.findings).toHaveLength(200)
  })

  test('rejects content that is not a scan report', () => {
    expect(parseReport('not json')).toBeNull()
    expect(parseReport('null')).toBeNull()
    expect(parseReport('{"findings":"nope"}')).toBeNull()
  })
})

describe('checkOutcome', () => {
  test('passes only once a report is published', () => {
    const outcome = checkOutcome(
      {
        baseRef: 'aaaaaaaa',
        headRef: 'bbbbbbbb',
        addedLines: 10,
        findings: [finding(), finding({ severity: 'medium' }), finding({ severity: 'medium' })],
      },
      '',
    )

    expect(outcome).toEqual({
      conclusion: 'success',
      title: '1 high, 2 medium',
      summary: expect.stringContaining('3 total'),
    })
  })

  test('fails when the scan produced no report', () => {
    const outcome = checkOutcome(null, 'report is empty')

    expect(outcome.conclusion).toBe('failure')
    expect(outcome.title).toBe('Scan did not complete')
    expect(outcome.summary).toContain('report is empty')
  })
})

describe('renderFailure', () => {
  test('keeps the marker so the next run updates the same comment', () => {
    const body = renderFailure('git diff failed: <boom>')

    expect(body.startsWith(MARKER)).toBe(true)
    expect(body).toContain('git diff failed: &lt;boom&gt;')
  })
})
