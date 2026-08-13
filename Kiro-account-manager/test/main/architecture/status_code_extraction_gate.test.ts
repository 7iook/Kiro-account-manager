import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = process.cwd()
const SOURCE_ROOT = resolve(PROJECT_ROOT, 'src')

interface StatusCodeExtractionFinding {
  file: string
  line: number
  expression: string
  pattern: string
  anchored: boolean
}

interface RegexBinding {
  name: string
  pattern: string
  declarationStart: number
  scope: ts.Node
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
    } else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) {
      out.push(absolute)
    }
  }
  return out
}

function scriptKind(file: string): ts.ScriptKind {
  if (/\.[jt]sx$/.test(file)) return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function regexLiteralPattern(expression: ts.Expression, parsed: ts.SourceFile): string | undefined {
  const target = unwrap(expression)
  if (ts.isRegularExpressionLiteral(target)) {
    const literal = target.getText(parsed)
    const closingSlash = literal.lastIndexOf('/')
    return literal.slice(1, closingSlash)
  }

  const isRegExpConstruction =
    (ts.isNewExpression(target) || ts.isCallExpression(target)) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === 'RegExp'
  if (!isRegExpConstruction) return undefined

  const pattern = target.arguments?.[0]
  if (pattern && (ts.isStringLiteral(pattern) || ts.isNoSubstitutionTemplateLiteral(pattern))) {
    return pattern.text
  }
  return undefined
}

function lexicalScope(node: ts.Node, parsed: ts.SourceFile): ts.Node {
  let current: ts.Node | undefined = node.parent
  while (current && !ts.isBlock(current) && !ts.isSourceFile(current)) {
    current = current.parent
  }
  return current ?? parsed
}

function regexBindings(parsed: ts.SourceFile): RegexBinding[] {
  const bindings: RegexBinding[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const pattern = regexLiteralPattern(node.initializer, parsed)
      if (pattern !== undefined) {
        bindings.push({
          name: node.name.text,
          pattern,
          declarationStart: node.getStart(parsed),
          scope: lexicalScope(node, parsed)
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return bindings
}

function resolvePattern(
  expression: ts.Expression,
  parsed: ts.SourceFile,
  bindings: RegexBinding[]
): string | undefined {
  const target = unwrap(expression)
  if (ts.isIdentifier(target)) {
    const position = target.getStart(parsed)
    const candidates = bindings
      .filter(
        (binding) =>
          binding.name === target.text &&
          binding.scope.pos <= position &&
          position < binding.scope.end
      )
      .sort((left, right) => {
        const scopeDifference =
          left.scope.end - left.scope.pos - (right.scope.end - right.scope.pos)
        if (scopeDifference !== 0) return scopeDifference
        const leftBeforeUse = left.declarationStart <= position
        const rightBeforeUse = right.declarationStart <= position
        if (leftBeforeUse !== rightBeforeUse) return leftBeforeUse ? -1 : 1
        return (
          Math.abs(position - left.declarationStart) - Math.abs(position - right.declarationStart)
        )
      })
    return candidates[0]?.pattern
  }
  return regexLiteralPattern(target, parsed)
}

function calledMethod(
  expression: ts.LeftHandSideExpression
): { receiver: ts.Expression; name: string } | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    return { receiver: expression.expression, name: expression.name.text }
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    (ts.isStringLiteral(expression.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))
  ) {
    return { receiver: expression.expression, name: expression.argumentExpression.text }
  }
  return undefined
}

const DIGIT_ATOM = String.raw`(?:\\d|\[[0-9-]+\])`
const EXACT_THREE_DIGITS = new RegExp(
  [
    `${DIGIT_ATOM}\\{3(?:,3)?\\}`,
    `${DIGIT_ATOM}${DIGIT_ATOM}${DIGIT_ATOM}`,
    `${DIGIT_ATOM}${DIGIT_ATOM}\\{2(?:,2)?\\}`,
    `${DIGIT_ATOM}\\{2(?:,2)?\\}${DIGIT_ATOM}`
  ].join('|')
)

function isHttpSemanticPattern(pattern: string): boolean {
  const match = EXACT_THREE_DIGITS.exec(pattern)
  if (!match) return false

  // 锚点看数字两侧的协议语义，而不是文件名白名单。这样协议边界的 HTTP
  // 状态行可合法就地解析，新文件里的裸三位数仍会被同一判据抓住。
  const context = `${pattern.slice(Math.max(0, match.index - 120), match.index)} ${pattern.slice(
    match.index + match[0].length,
    match.index + match[0].length + 120
  )}`
  if (/http|status/i.test(context)) return true
  if (/(?:api|auth)[\s\S]*error|error[\s\S]*(?:api|auth)/i.test(context)) return true
  return /(?:request|response)[\s\S]*code|code[\s\S]*(?:request|response)/i.test(context)
}

function collectStatusCodeExtractions(file: string, source: string): StatusCodeExtractionFinding[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file))
  const bindings = regexBindings(parsed)
  const findings: StatusCodeExtractionFinding[] = []
  const relativeFile = slash(relative(PROJECT_ROOT, file))

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const method = calledMethod(node.expression)
      let pattern: string | undefined
      if (method && (method.name === 'match' || method.name === 'matchAll')) {
        const argument = node.arguments[0]
        if (argument) pattern = resolvePattern(argument, parsed, bindings)
      } else if (method?.name === 'exec') {
        pattern = resolvePattern(method.receiver, parsed, bindings)
      }

      if (pattern !== undefined && EXACT_THREE_DIGITS.test(pattern)) {
        const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed))
        findings.push({
          file: relativeFile,
          line: line + 1,
          expression: node.getText(parsed),
          pattern,
          anchored: isHttpSemanticPattern(pattern)
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return findings
}

function formatFindings(findings: StatusCodeExtractionFinding[]): string {
  return findings
    .map(
      (finding) => `${finding.file}:${finding.line} ${finding.expression} (/${finding.pattern}/)`
    )
    .join('\n')
}

describe('状态码提取防扩散门禁', () => {
  it('受控正样本：直接、变量与 RegExp 构造的裸三位数提取都会被抓住', () => {
    const mutant = String.raw`
      const direct = error.message.match(/(\d{3})/)
      const STATUS = /\b[0-9]{3}\b/
      const indirect = STATUS.exec(errMsg)
      const constructed = new RegExp('(\\d{3})').exec(message)
      const ranged = body.match(/([1-5]\d{2})/)
    `
    const findings = collectStatusCodeExtractions(
      resolve(PROJECT_ROOT, 'src/main/proxy/__status_gate_mutant.ts'),
      mutant
    )

    expect(findings).toHaveLength(4)
    expect(findings.filter((finding) => !finding.anchored)).toHaveLength(4)
  })

  it('受控负样本：SSOT 与协议状态行的锚定提取均通过，不靠文件豁免', () => {
    const anchored = String.raw`
      const api = message.match(/\b(?:API|Auth) error (\d{3})\b/)
      const common = message.match(/\bstatus(?:Code)?\s*[=:]\s*(\d{3})\b/i)
      const http = message.match(/\bHTTP\/?\s*(\d{3})\b/i)
      const statusLine = raw.match(/^HTTP\/1\.[01]\s+(\d{3})\s*(.*)$/)
      const timestamp = stamp.replace(/\.\d{3}Z$/, '.000Z')
    `
    const findings = collectStatusCodeExtractions(
      resolve(PROJECT_ROOT, 'src/main/proxy/__status_gate_anchored.ts'),
      anchored
    )

    expect(findings, '锚定样本必须被扫描器实际看见，不能以零命中冒充通过').toHaveLength(4)
    expect(findings.filter((finding) => !finding.anchored)).toEqual([])
  })

  it('生产源码不得新增无 HTTP 语义锚点的三位数提取', () => {
    const findings = sourceFiles(SOURCE_ROOT).flatMap((file) =>
      collectStatusCodeExtractions(file, readFileSync(file, 'utf8'))
    )
    expect(
      findings.length,
      '生产源码必须至少命中既有锚定状态码提取；零命中的门禁与没有门禁同形'
    ).toBeGreaterThan(0)

    const bare = findings.filter((finding) => !finding.anchored)
    expect(
      bare,
      bare.length > 0
        ? `发现绕开 extractHttpStatusCode 的裸三位数提取：\n${formatFindings(bare)}`
        : undefined
    ).toEqual([])
  })
})
