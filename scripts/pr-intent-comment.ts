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
  headSha: string
}

const MARKER = '<!-- pr-intent-scan -->'
const MAX_ROWS = 25
// The report is written by a run of the pull request's own code, so it is data:
// every field is bounded before it reaches the comment body.
const MAX_FINDINGS = 200
const MAX_FILE_CHARS = 300
const MAX_DETAIL_CHARS = 300
const MAX_EXCERPT_CHARS = 500
const MAX_REF_CHARS = 100
const CHECK_NAME = 'PR intent scan findings'

export type CheckOutcome = {
  conclusion: 'success' | 'failure'
  title: string
  summary: string
}

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
  if (!ref) return 'unknown'
  return ref.length > 8 ? ref.slice(0, 8) : ref
}

function clampText(value: unknown, limit: number): string | null {
  return typeof value === 'string' ? value.slice(0, limit) : null
}

export function parseReport(text: string): ScanReport | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  const candidate = parsed as Record<string, unknown>
  if (!Array.isArray(candidate.findings)) return null

  const findings: ScanFinding[] = []
  for (const raw of candidate.findings) {
    if (findings.length >= MAX_FINDINGS) break
    if (!raw || typeof raw !== 'object') continue

    const item = raw as Record<string, unknown>
    if (item.severity !== 'high' && item.severity !== 'medium') continue

    const file = clampText(item.file, MAX_FILE_CHARS)
    const detail = clampText(item.detail, MAX_DETAIL_CHARS)
    const excerpt = clampText(item.excerpt, MAX_EXCERPT_CHARS)
    if (!file || !detail || excerpt === null) continue

    const line =
      typeof item.line === 'number' && Number.isFinite(item.line) && item.line >= 0
        ? Math.trunc(item.line)
        : 0

    findings.push({
      severity: item.severity,
      code: clampText(item.code, MAX_REF_CHARS) ?? '',
      file,
      line,
      detail,
      excerpt,
    })
  }

  const addedLines =
    typeof candidate.addedLines === 'number' &&
    Number.isFinite(candidate.addedLines) &&
    candidate.addedLines >= 0
      ? Math.trunc(candidate.addedLines)
      : 0

  return {
    baseRef: clampText(candidate.baseRef, MAX_REF_CHARS) ?? '',
    headRef: clampText(candidate.headRef, MAX_REF_CHARS) ?? '',
    addedLines,
    findings,
  }
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

  const report = parseReport(text)
  if (!report) {
    return { report: null, reason: `${path} is not a scan report` }
  }
  return { report, reason: '' }
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

function publish(
  repo: string,
  pullRequest: string,
  body: string,
): { action: 'created' | 'updated'; url: string } {
  const commentId = existingCommentId(repo, pullRequest)
  const payload = JSON.stringify({ body })
  const response = commentId
    ? gh(
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
    : gh(
        ['api', '-X', 'POST', `repos/${repo}/issues/${pullRequest}/comments`, '--input', '-'],
        payload,
      )

  const url = (JSON.parse(response) as { html_url?: string }).html_url ?? ''
  return { action: commentId ? 'updated' : 'created', url }
}

// Re-read the comment before the check is allowed to pass, so a green check
// means the findings are actually on the pull request.
function verifyPublished(repo: string, pullRequest: string): void {
  const commentId = existingCommentId(repo, pullRequest)
  if (!commentId) {
    throw new Error('published comment could not be found')
  }

  const body = gh(['api', `repos/${repo}/issues/comments/${commentId}`, '-q', '.body'])
  if (!body.startsWith(MARKER)) {
    throw new Error('published comment does not carry the scan marker')
  }
}

export function checkOutcome(
  report: ScanReport | null,
  reason: string,
): CheckOutcome {
  if (!report) {
    return {
      conclusion: 'failure',
      title: 'Scan did not complete',
      summary: `No findings were published: ${reason}`,
    }
  }

  const high = report.findings.filter(finding => finding.severity === 'high').length
  const medium = report.findings.filter(finding => finding.severity === 'medium').length
  return {
    conclusion: 'success',
    title: `${high} high, ${medium} medium`,
    summary: `The scan findings are published in the pull request comment (${report.findings.length} total).`,
  }
}

function startCheck(repo: string, headSha: string): string | null {
  try {
    const response = gh(
      ['api', '-X', 'POST', `repos/${repo}/check-runs`, '--input', '-'],
      JSON.stringify({
        name: CHECK_NAME,
        head_sha: headSha,
        status: 'in_progress',
        output: {
          title: 'Publishing findings',
          summary: 'Waiting for the findings comment to be published on the pull request.',
        },
      }),
    )
    const id = (JSON.parse(response) as { id?: number }).id
    return typeof id === 'number' ? String(id) : null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`PR intent check: could not start the check run (${message})\n`)
    return null
  }
}

function completeCheck(
  repo: string,
  checkId: string,
  outcome: CheckOutcome,
  detailsUrl: string,
): void {
  gh(
    ['api', '-X', 'PATCH', `repos/${repo}/check-runs/${checkId}`, '--input', '-'],
    JSON.stringify({
      status: 'completed',
      conclusion: outcome.conclusion,
      details_url: detailsUrl || undefined,
      output: { title: outcome.title, summary: outcome.summary },
    }),
  )
}

function parseOptions(argv: string[]): CliOptions {
  const options: CliOptions = { reportPath: '', pullRequest: '', repo: '', headSha: '' }

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
    } else if (arg === '--head-sha') {
      options.headSha = value
      index++
    }
  }

  return options
}

export function run(options: CliOptions): void {
  if (!options.reportPath || !options.pullRequest || !options.repo) {
    throw new Error('--report, --pr and --repo are required')
  }

  const checkId = options.headSha ? startCheck(options.repo, options.headSha) : null
  const { report, reason } = readReport(options.reportPath)
  const body = report ? renderComment(report) : renderFailure(reason)
  const outcome = checkOutcome(report, reason)

  if (report) {
    process.stdout.write(
      `PR intent comment: ${report.findings.length} finding(s) (${outcome.title})\n`,
    )
  } else {
    process.stdout.write(`PR intent comment: scan report unavailable (${reason})\n`)
  }

  try {
    const { action, url } = publish(options.repo, options.pullRequest, body)
    verifyPublished(options.repo, options.pullRequest)
    process.stdout.write(
      `PR intent comment ${action} on ${options.repo}#${options.pullRequest}\n`,
    )

    if (checkId) {
      completeCheck(options.repo, checkId, outcome, url)
      process.stdout.write(`PR intent check completed: ${outcome.conclusion}\n`)
    }
  } catch (error) {
    if (checkId) {
      completeCheck(options.repo, checkId, {
        conclusion: 'failure',
        title: 'Findings were not published',
        summary: error instanceof Error ? error.message : String(error),
      }, '')
    }
    throw error
  }
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
