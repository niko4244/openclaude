import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

export type ScanFinding = {
  severity: 'high' | 'medium'
  code: string
  file: string
  line: number
  detail: string
  excerpt: string
}

export type ScanReport = {
  baseRef: string
  headRef: string
  addedLines: number
  findings: ScanFinding[]
}

type CliOptions = {
  reportPath: string
  pullRequest: string
  repo: string
}

const MARKER = '<!-- pr-intent-scan -->'
const MAX_ROWS = 25

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function cell(value: string): string {
  return escapeHtml(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function shortRef(ref: string): string {
  return ref.length > 8 ? ref.slice(0, 8) : ref
}

export function renderComment(report: ScanReport): string {
  const high = report.findings.filter(finding => finding.severity === 'high')
  const medium = report.findings.filter(finding => finding.severity === 'medium')
  const lines = [MARKER, '## PR intent scan', '']

  if (report.findings.length === 0) {
    lines.push(
      `**No suspicious additions found** in ${report.addedLines.toLocaleString('en-US')} added lines (\`${shortRef(report.baseRef)}\` → \`${shortRef(report.headRef)}\`).`,
    )
    lines.push('', 'High-severity findings fail this check; medium findings are reported only.')
    return lines.join('\n')
  }

  lines.push(
    `**${high.length} high**, **${medium.length} medium** in ${report.addedLines.toLocaleString('en-US')} added lines (\`${shortRef(report.baseRef)}\` → \`${shortRef(report.headRef)}\`).`,
  )
  lines.push('', '| Severity | Location | Finding |', '| --- | --- | --- |')

  for (const finding of report.findings.slice(0, MAX_ROWS)) {
    lines.push(
      `| ${finding.severity} | \`${cell(`${finding.file}:${finding.line}`)}\` | ${cell(finding.detail)} |`,
    )
  }

  if (report.findings.length > MAX_ROWS) {
    lines.push(
      '',
      `_${report.findings.length - MAX_ROWS} more finding(s) in the job log._`,
    )
  }

  lines.push('', '<details><summary>Matching lines</summary>', '')
  for (const finding of report.findings.slice(0, MAX_ROWS)) {
    lines.push(
      `<b>${escapeHtml(finding.file)}:${finding.line}</b> (${finding.severity})`,
      '',
      `<pre>${escapeHtml(finding.excerpt)}</pre>`,
      '',
    )
  }
  lines.push('</details>', '')
  lines.push('High-severity findings fail this check; medium findings are reported only.')

  return lines.join('\n')
}

export function renderFailure(reason: string): string {
  return [
    MARKER,
    '## PR intent scan',
    '',
    'The scan did not complete, so nothing was classified for this PR. See the `pr-intent-scan` job log.',
    '',
    `<pre>${escapeHtml(reason.slice(0, 500))}</pre>`,
  ].join('\n')
}

function readReport(path: string): { report: ScanReport | null; reason: string } {
  if (!existsSync(path)) {
    return { report: null, reason: `${path} was not written` }
  }

  const text = readFileSync(path, 'utf8').trim()
  if (!text) {
    return { report: null, reason: `${path} is empty` }
  }

  try {
    const parsed = JSON.parse(text) as ScanReport
    if (!Array.isArray(parsed.findings)) {
      return { report: null, reason: `${path} has no findings array` }
    }
    return { report: parsed, reason: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { report: null, reason: `Could not parse ${path}: ${message}` }
  }
}

function gh(args: string[], input?: string): string {
  return execFileSync('gh', args, { encoding: 'utf8', input })
}

function existingCommentId(repo: string, pullRequest: string): string | null {
  const output = gh([
    'api',
    '--paginate',
    `repos/${repo}/issues/${pullRequest}/comments`,
    '-q',
    `.[] | select(.body | contains("${MARKER}")) | .id`,
  ]).trim()

  const first = output.split('\n').find(line => line.trim().length > 0)
  return first ? first.trim() : null
}

function publish(repo: string, pullRequest: string, body: string): 'created' | 'updated' {
  const commentId = existingCommentId(repo, pullRequest)
  const payload = JSON.stringify({ body })

  if (commentId) {
    gh(
      [
        'api',
        '-X',
        'PATCH',
        `repos/${repo}/issues/comments/${commentId}`,
        '--input',
        '-',
      ],
      payload,
    )
    return 'updated'
  }

  gh(
    ['api', '-X', 'POST', `repos/${repo}/issues/${pullRequest}/comments`, '--input', '-'],
    payload,
  )
  return 'created'
}

function parseOptions(argv: string[]): CliOptions {
  const options: CliOptions = { reportPath: '', pullRequest: '', repo: '' }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) continue

    if (arg === '--report') {
      options.reportPath = value
      index++
    } else if (arg === '--pr') {
      options.pullRequest = value
      index++
    } else if (arg === '--repo') {
      options.repo = value
      index++
    }
  }

  return options
}

export function run(options: CliOptions): void {
  if (!options.reportPath || !options.pullRequest || !options.repo) {
    throw new Error('--report, --pr and --repo are required')
  }

  const { report, reason } = readReport(options.reportPath)
  const body = report ? renderComment(report) : renderFailure(reason)

  if (report) {
    const high = report.findings.filter(finding => finding.severity === 'high').length
    const medium = report.findings.filter(finding => finding.severity === 'medium').length
    process.stdout.write(
      `PR intent comment: ${report.findings.length} finding(s) (${high} high, ${medium} medium)\n`,
    )
  } else {
    process.stdout.write(`PR intent comment: scan report unavailable (${reason})\n`)
  }

  const action = publish(options.repo, options.pullRequest, body)
  process.stdout.write(`PR intent comment ${action} on ${options.repo}#${options.pullRequest}\n`)
}

if (import.meta.main) {
  try {
    run(parseOptions(process.argv.slice(2)))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`PR intent comment failed: ${message}`)
    process.exitCode = 1
  }
}
