#!/usr/bin/env node
/**
 * 安装前自检 —— 在 install_bundle 之前跑一遍，拦住会让 DSH 起不来的错误。
 *
 *   node scripts/check.js
 *
 * 为什么需要它：DSH 的 web boot 要求每个插件 entry 都激活成功，
 * 任何一个客户端模块 import 失败都会导致整个应用无法启动，
 * 而那时代理已经连不上了，只能靠弹窗里的「禁用第三方插件」硬救。
 *
 * 这里覆盖的正是最容易犯且后果最严重的一类错误：
 * client.js 里写死的模块 id 与包名不一致（改包名时漏改）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []

function fail(msg) {
  problems.push(msg)
}

function readJson(rel) {
  const p = join(ROOT, rel)
  if (!existsSync(p)) {
    fail(`缺少文件 ${rel}`)
    return null
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (error) {
    fail(`${rel} 不是合法 JSON：${error.message}`)
    return null
  }
}

/* ---------- 1. 语法 ---------- */
for (const rel of ['index.js', 'client.js']) {
  const p = join(ROOT, rel)
  if (!existsSync(p)) {
    fail(`缺少文件 ${rel}`)
    continue
  }
  try {
    execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' })
  } catch (error) {
    fail(`${rel} 语法错误：${String(error.stderr || error.message).split('\n').slice(0, 3).join(' ')}`)
  }
}

/* ---------- 2. 包名与客户端模块 id 必须一致 ---------- */
const pkg = readJson('package.json')
const clientSource = existsSync(join(ROOT, 'client.js'))
  ? readFileSync(join(ROOT, 'client.js'), 'utf8')
  : ''

if (pkg && clientSource) {
  const match = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]*?\bid\s*:\s*['"]([^'"]+)['"]/.exec(clientSource)
  if (!match) {
    fail('client.js 里没找到 __ModuleLoader__.load({ id })')
  } else if (match[1] !== pkg.name) {
    fail(
      `客户端模块 id 与包名不一致：\n` +
        `    client.js  的 id = ${match[1]}\n` +
        `    package.json 的 name = ${pkg.name}\n` +
        `    两者必须完全相同，否则启动会报 duplicate factory registration / import failed。`
    )
  } else {
    notes.push(`客户端模块 id 与包名一致：${match[1]}`)
  }
}

/* ---------- 3. bundle patch 声明 ---------- */
if (pkg) {
  const patchRel = pkg?.dsh?.bundle?.patch
  if (!patchRel) {
    fail('package.json 缺少 dsh.bundle.patch')
  } else if (!existsSync(join(ROOT, patchRel))) {
    fail(`dsh.bundle.patch 指向的 ${patchRel} 不存在`)
  } else {
    const patch = readFileSync(join(ROOT, patchRel), 'utf8')
    if (!patch.includes(`'${pkg.name}'`) && !patch.includes(`"${pkg.name}"`)) {
      fail(`${patchRel} 里没有引用包名 '${pkg.name}'（insert 的 name 字段应等于包名）`)
    } else {
      notes.push(`${patchRel} 已正确引用 ${pkg.name}`)
    }
  }
}

/* ---------- 4. Host 依赖的静态文件 ---------- */
const hostSource = existsSync(join(ROOT, 'index.js')) ? readFileSync(join(ROOT, 'index.js'), 'utf8') : ''
if (hostSource.includes("join(HERE, 'app')") && !existsSync(join(ROOT, 'app/index.html'))) {
  fail('index.js 会从 app/ 提供页面，但 app/index.html 不存在')
}

/* ---------- 输出 ---------- */
if (problems.length === 0) {
  for (const n of notes) console.log(`  ✅ ${n}`)
  console.log('\n自检通过，可以 install_bundle。')
  process.exit(0)
}

console.error('自检未通过：\n')
for (const p of problems) console.error(`  ❌ ${p}`)
console.error('\n装上去会导致 DSH 启动失败，请先修好再安装。')
process.exit(1)
