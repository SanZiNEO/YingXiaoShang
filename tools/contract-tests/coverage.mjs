#!/usr/bin/env node
// E 轮 · OpenAPI 覆盖核对命令（02-contract.md §7、§9；冻结 §8）。
//
// 两种调用方式同口径（仓库根按脚本所在目录上溯两级定位，不依赖调用时 cwd）：
//   cd tools/contract-tests && node coverage.mjs
//   node tools/contract-tests/coverage.mjs
//
// 退出码：green → 0；pending（openapi 缺失，按冻结表降级核对）→ 0；red（文件存在但有缺项/多出项）→ 1。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContract, runChecks } from './src/openapi.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function parseArgs(argv) {
  const opts = { report: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--report') {
      opts.report = argv[++i];
    }
  }
  return opts;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function summarize(result) {
  let head;
  if (result.openapi === 'missing') {
    head = 'openapi: missing，已按冻结表降级核对；覆盖结论待 A 轮产物落地后重跑。';
  } else if (result.openapi === 'invalid') {
    head = `openapi: invalid（文件在但解析不出结构）：${result.parseError ?? '未知原因'}；四条核对全部判红。`;
  } else if (result.status === 'green') {
    head = 'openapi: present，四项核对全部通过（green）。';
  } else {
    const bad = result.checks
      .filter((c) => !c.ok)
      .map((c) => `${c.id} ${c.name}（缺 ${c.missing.length} / 多 ${c.extra.length}）`)
      .join('、');
    head = `openapi: present，核对未通过（red）：${bad}。明细见 coverage.json。`;
  }
  // readAt 与结论来自同一次读取；时刻写进摘要，避免跨时刻混用。
  return `${head} 读取时刻 ${result.readAt}（openapi: ${result.openapi}）`;
}

const opts = parseArgs(process.argv);
const contract = loadContract({ repoRoot: REPO_ROOT });
const result = runChecks(contract, { repoRoot: REPO_ROOT });

const reportDir = resolveReportDir(opts.report);
fs.mkdirSync(reportDir, { recursive: true });
const reportPath = path.join(reportDir, 'coverage.json');
fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

/** 显式 --report 必须落在本包内（写权只覆盖 tools/contract-tests/**）；自动命名撞到已存在的同秒目录时加 -2/-3，不覆盖别人的证据。 */
function resolveReportDir(reportArg) {
  if (reportArg) {
    const target = path.resolve(HERE, reportArg);
    const rel = path.relative(HERE, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      process.stderr.write('参数 --report 非法：必须落在 tools/contract-tests/ 内。\n');
      process.exit(3);
    }
    return target;
  }
  const base = path.join(HERE, 'report', timestamp());
  let candidate = base;
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = `${base}-${n}`;
  return candidate;
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${summarize(result)}\n`);
process.stdout.write(`报告 ${path.relative(HERE, reportPath).split(path.sep).join('/')}\n`);

process.exit(result.status === 'red' ? 1 : 0);
