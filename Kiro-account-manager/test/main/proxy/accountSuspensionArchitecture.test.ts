import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

const PROJECT_ROOT = process.cwd()
const SOURCE_ROOT = resolve(PROJECT_ROOT, 'src')
const AUTHORITATIVE_CLASSIFIER = 'src/shared/accountSuspension.ts'

/**
 * 这些不是通用账号封禁分类器：
 * - kiroApi / registrar 在各自协议边界读取结构化 HTTP/响应字段；
 * - RegisterPage 只把注册失败翻译成诊断文案，不参与账号池/选号；
 * - webPanel 当前由并行任务占用，本轮不能修改，先精确冻结这一处存量副本。
 */
const ALLOWED_RAW_DECISION_FILES = new Set([
  AUTHORITATIVE_CLASSIFIER,
  'src/main/proxy/kiroApi.ts',
  'src/main/registration/registrar.ts',
  'src/renderer/src/components/pages/RegisterPage.tsx',
  'src/webPanel/ui/format.ts'
])

interface RawDecisionFinding {
  file: string
  line: number
  expression: string
}

function slash(path: string): string {
  return path.replaceAll('\\', '/')
}

function sourceFiles(directory: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      out.push(...sourceFiles(absolute))
    } else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
      out.push(absolute)
    }
  }
  return out
}

function containsRawSuspensionMarker(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    lower.includes('suspend') ||
    lower.includes('封禁') ||
    lower.includes('account_locked') ||
    lower.includes('user id is') ||
    lower.includes('用户状态异常') ||
    /(?:^|\D)423(?:\D|$)/.test(lower)
  )
}

function collectRawDecisions(file: string, source: string): RawDecisionFinding[] {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const findings: RawDecisionFinding[] = []
  const relativeFile = slash(relative(PROJECT_ROOT, file))

  const add = (node: ts.Node): void => {
    const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed))
    findings.push({
      file: relativeFile,
      line: line + 1,
      expression: node.getText(parsed)
    })
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'includes'
    ) {
      const marker = node.arguments[0]
      if (
        marker &&
        (ts.isStringLiteral(marker) || ts.isNoSubstitutionTemplateLiteral(marker)) &&
        containsRawSuspensionMarker(marker.text)
      ) {
        add(node)
      }
    }

    if (
      ts.isRegularExpressionLiteral(node) &&
      containsRawSuspensionMarker(node.text) &&
      (
        (ts.isPropertyAccessExpression(node.parent) &&
          ts.isCallExpression(node.parent.parent)) ||
        (ts.isCallExpression(node.parent) &&
          ts.isPropertyAccessExpression(node.parent.expression) &&
          ['match', 'search', 'replace'].includes(node.parent.expression.name.text))
      )
    ) {
      add(node)
    }

    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return findings
}

describe('账号封禁文本分类架构门禁', () => {
  it('扫描器能抓住新复制的 ACCOUNT_SUSPENDED 判定（防空门禁）', () => {
    const mutant = "export const copied = (message: string) => message.includes('ACCOUNT_SUSPENDED')"
    expect(collectRawDecisions(resolve(PROJECT_ROOT, 'src/mutant.ts'), mutant)).toHaveLength(1)
  })

  it('生产代码只能在权威分类器或精确列明的协议/展示边界解析封禁原文', () => {
    expect(
      existsSync(resolve(PROJECT_ROOT, AUTHORITATIVE_CLASSIFIER)),
      `缺少权威分类器 ${AUTHORITATIVE_CLASSIFIER}`
    ).toBe(true)

    const findings = sourceFiles(SOURCE_ROOT).flatMap((file) =>
      collectRawDecisions(file, readFileSync(file, 'utf8'))
    )
    const authorityFindings = findings.filter(
      (finding) => finding.file === AUTHORITATIVE_CLASSIFIER
    )
    expect(
      authorityFindings.length,
      '权威分类器必须实际包含原文判定；零命中的门禁与没有门禁同形'
    ).toBeGreaterThan(0)

    const unexpected = findings.filter(
      (finding) => !ALLOWED_RAW_DECISION_FILES.has(finding.file)
    )
    expect(
      unexpected,
      unexpected
        .map((finding) => `${finding.file}:${finding.line} ${finding.expression}`)
        .join('\n')
    ).toEqual([])
  })
})
