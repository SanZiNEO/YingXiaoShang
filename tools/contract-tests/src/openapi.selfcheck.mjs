#!/usr/bin/env node
// E 轮 · OpenAPI 覆盖核对自检（不进入报告产物，只在本地验证解析与判定三条路径）。
//
// 在 .scratch/run/E/oas-fixture/ 下生成四份合成 yaml，经 loadContract 的 file 覆盖参数
// 注入读取（不依赖 docs/contracts/openapi.yaml），分别验证：
//   1. full.yaml          → green：30 枚举 / 5 通道 / 4 legacy / 30 Result schema 全齐；
//   2. missing-enum.yaml  → red：E-077 missing 明细列出被删方法，extra 为空；
//   3. legacy-in-enum.yaml→ red：E-077 extra 与 E-079 extra 明细列出误入枚举的 legacy；
//   4. realistic.yaml     → green：复刻真实 A 文档用到的写法（锚点 &name + 别名 *name、
//      引号响应码、security: []、空流式对象 {}、legacy 对象列表取 name、本地 $ref），
//      挡住「合成 yaml 全绿、真实文件整树退化」这类解析回归。
//
// 覆盖写法：full 用块状 `- ` 列表；missing-enum 用行内 `[...]` 数组；
// legacy-in-enum 的 x-legacy-methods 用行内数组，enum 用块状列表。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadContract,
  runChecks,
  METHOD_NAMES,
  LEGACY_METHODS,
  CHANNEL_PATHS,
  resultSchemaName,
} from './openapi.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const FIXTURE_DIR = path.join(REPO_ROOT, '.scratch', 'run', 'E', 'oas-fixture');

function schemasBlock() {
  return METHOD_NAMES.map((m) => `    ${resultSchemaName(m)}:\n      type: object`).join('\n');
}

function channelsBlock() {
  return CHANNEL_PATHS.map((p) => `  ${p}:\n    post: {}`).join('\n');
}

function baseYaml({ legacyText, enumText }) {
  return [
    'openapi: 3.0.3',
    'info:',
    '  title: selfcheck fixture',
    '  version: 0.0.0',
    `x-legacy-methods:${legacyText}`,
    'paths:',
    '  /api/v1/rpc:',
    '    post:',
    '      requestBody:',
    '        content:',
    '          application/json:',
    '            schema:',
    '              properties:',
    '                method:',
    '                  type: string',
    `                  enum:${enumText}`,
    channelsBlock(),
    'components:',
    '  schemas:',
    schemasBlock(),
    '',
  ].join('\n');
}

const legacyBlock = LEGACY_METHODS.map((n) => `  - ${n}`).join('\n');
const fullEnumBlock = METHOD_NAMES.map((n) => `                    - ${n}`).join('\n');

// 复刻真实 A 文档的代表性片段（脱敏：只留结构写法，不带业务描述）。
function realisticYaml() {
  const enumBlock = METHOD_NAMES.map((n) => `                    - ${n}`).join('\n');
  const legacyObj = LEGACY_METHODS.map((n) => `  - name: ${n}\n    params: {}\n    result: string`).join('\n');
  return [
    'openapi: 3.0.3',
    'info:',
    '  title: realistic fixture',
    'servers:',
    '  - url: http://127.0.0.1:8080',
    'security:',
    '  - bearerAuth: []',
    `x-legacy-methods:\n${legacyObj}`,
    'paths:',
    '  /api/v1/health:',
    '    get:',
    '      security: []',
    '      responses:',
    '        "200": &ok',
    '          description: health result',
    '          content:',
    '            application/json:',
    '              schema:',
    '                $ref: "#/components/schemas/HealthResult"',
    '        "503": *ok',
    '  /api/v1/rpc:',
    '    post:',
    '      security: []',
    '      requestBody:',
    '        content:',
    '          application/json:',
    '            schema:',
    '              type: object',
    '              properties:',
    '                method:',
    '                  type: string',
    `                  enum:\n${enumBlock}`,
    channelsBlock(),
    'components:',
    '  schemas:',
    '    HealthResult:',
    '      type: object',
    schemasBlock(),
    '',
  ].join('\n');
}

const variants = [
  {
    file: 'full.yaml',
    expectStatus: 'green',
    yaml: baseYaml({ legacyText: '\n' + legacyBlock, enumText: '\n' + fullEnumBlock }),
  },
  {
    file: 'missing-enum.yaml',
    expectStatus: 'red',
    yaml: baseYaml({
      legacyText: '\n' + legacyBlock,
      enumText: ` [${METHOD_NAMES.filter((m) => m !== 'agent.sessions').join(', ')}]`,
    }),
  },
  {
    file: 'legacy-in-enum.yaml',
    expectStatus: 'red',
    yaml: baseYaml({
      legacyText: ` [${LEGACY_METHODS.join(', ')}]`,
      enumText: '\n' + [...METHOD_NAMES, 'getKp'].map((n) => `                    - ${n}`).join('\n'),
    }),
  },
  {
    file: 'realistic.yaml',
    expectStatus: 'green',
    yaml: realisticYaml(),
  },
];

let failures = 0;
function assert(cond, message) {
  if (cond) {
    console.log(`  ok: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

fs.mkdirSync(FIXTURE_DIR, { recursive: true });

for (const v of variants) {
  const abs = path.join(FIXTURE_DIR, v.file);
  fs.writeFileSync(abs, v.yaml, 'utf8');
  const contract = loadContract({ repoRoot: REPO_ROOT, file: abs });
  const result = runChecks(contract, { repoRoot: REPO_ROOT });

  console.log(`\n[${v.file}] status=${result.status}`);
  for (const c of result.checks) {
    console.log(
      `  ${c.id} ${c.name}: expected=${c.expected} actual=${c.actual} ok=${c.ok} ` +
      `missing=[${c.missing.join(', ')}] extra=[${c.extra.join(', ')}]`,
    );
  }

  assert(result.status === v.expectStatus, `status 为 ${v.expectStatus}`);
  const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));

  if (v.file === 'full.yaml') {
    assert(byId['E-077'].actual === 30 && byId['E-077'].ok, 'E-077 枚举恰好 30 个冻结方法');
    assert(byId['E-078'].actual === 5 && byId['E-078'].ok, 'E-078 五个通道 path 齐备');
    assert(byId['E-079'].actual === 4 && byId['E-079'].ok, 'E-079 legacy 恰好 4 个且未混入枚举');
    assert(byId['E-080'].actual === 30 && byId['E-080'].ok, 'E-080 30 个 Result schema 齐备');
  }

  if (v.file === 'missing-enum.yaml') {
    assert(
      !byId['E-077'].ok && byId['E-077'].missing.length === 1 && byId['E-077'].missing[0] === 'agent.sessions',
      'E-077 missing 明细为被删的 agent.sessions',
    );
    assert(byId['E-077'].extra.length === 0, 'E-077 extra 为空');
    assert(byId['E-078'].ok && byId['E-079'].ok && byId['E-080'].ok, '其余三项不受缺枚举影响');
  }

  if (v.file === 'legacy-in-enum.yaml') {
    assert(
      !byId['E-077'].ok && byId['E-077'].extra.includes('getKp'),
      'E-077 extra 明细含误入枚举的 getKp',
    );
    assert(byId['E-077'].missing.length === 0, 'E-077 missing 为空');
    assert(
      !byId['E-079'].ok && byId['E-079'].extra.includes('getKp'),
      'E-079 标出 legacy 误入 method 枚举',
    );
  }

  if (v.file === 'realistic.yaml') {
    assert(byId['E-077'].actual === 30 && byId['E-077'].ok, '真实结构：枚举 30 全认到');
    assert(byId['E-078'].actual === 5 && byId['E-078'].ok, '真实结构：5 通道 path 全认到');
    assert(byId['E-079'].actual === 4 && byId['E-079'].ok, '真实结构：legacy 对象列表取 name 得 4 个');
    assert(byId['E-080'].actual === 30 && byId['E-080'].ok, '真实结构：30 个 Result schema 齐备');
    // 锚点/别名/引号码段不得吞掉后续兄弟 path。
    assert(
      Object.keys(contract.doc?.paths ?? {}).includes('/api/v1/rpc') &&
        Object.keys(contract.doc?.paths ?? {}).includes('/api/v1/chat/stream'),
      '真实结构：锚点段后兄弟 path 未被吞掉',
    );
  }
}

console.log(failures === 0 ? '\n自检通过。' : `\n自检失败：${failures} 项断言未通过。`);
process.exit(failures === 0 ? 0 : 1);
