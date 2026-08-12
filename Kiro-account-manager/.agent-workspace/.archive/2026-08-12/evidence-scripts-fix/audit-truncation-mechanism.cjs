// 截断机制是否真实成立：给旧启发式一个含「与声明同缩进的独立闭合块」的函数，
// 看它是否提前结束。真实数据 0/40 未命中，但机制本身必须实测确认，
// 否则「潜在缺陷」也只是推断。
function oldHeuristic(text, name) {
  const lines = text.split(/\r?\n/)
  const s = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function ${name}\\b`).test(l))
  const indent = lines[s].match(/^(\s*)/)[1]
  for (let i = s + 1; i < lines.length; i++) if (lines[i] === indent + '}') return lines.slice(s, i + 1).join('\n')
  return null
}

// 形态 A：函数体内出现顶格 `}`（对象字面量/块结束正好落在声明缩进上）
const A = [
  'function victim(): string {',
  '  const cfg = {',
  '    a: 1',
  '}',                       // <-- 与 `function` 同缩进（0 格）的孤立 }
  '  return cfg.a + ""',
  '}',
  ''
].join('\n')

// 形态 B：工厂闭包内（2 格缩进）的函数，体内有 2 格缩进的孤立 }
const B = [
  '  function victim(): number {',
  '    const t = [1, 2].map((x) => {',
  '      return x',
  '  }',                     // <-- 与声明同缩进（2 格）
  '    )',
  '    return t.length',
  '  }',
  ''
].join('\n')

for (const [label, src] of [['A top-level', A], ['B inside factory', B]]) {
  const got = oldHeuristic(src, 'victim')
  const full = src.trimEnd()
  const truncated = got !== full
  console.log(`--- ${label}: truncated=${truncated}`)
  console.log(`    heuristic captured ${got.split('\n').length} of ${full.split('\n').length} lines`)
  console.log(`    lost tail: ${JSON.stringify(full.split('\n').slice(got.split('\n').length))}`)
}
