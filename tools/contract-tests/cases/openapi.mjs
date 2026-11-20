// E 轮 · OpenAPI 覆盖用例 E-077 … E-080（02-contract.md §2.1、§7；冻结 §8）。
//
// 目标无关：四条均为 `targets: '*'`（stub / http / electron / both 同一口径）。
// 宿主注入 ctx：`ctx.make(name, expected, actual)`、`ctx.skip(reason)`（记 skipped）、
// `ctx.pending(reason)`（记 pending）、`ctx.repoRoot`、`ctx.writeEvidence(text)`；
// 本文件不 import 宿主模块，只依赖 ../src/openapi.mjs。

import {
  loadContract,
  runChecks,
  METHOD_NAMES,
  CHANNEL_PATHS,
  LEGACY_METHODS,
  resultSchemaName,
} from '../src/openapi.mjs';

const PENDING_REASON = 'openapi 缺失：docs/contracts/openapi.yaml 尚未落地（A 轮产物），按冻结 §8 标 pending';

function expectedList(caseId) {
  switch (caseId) {
    case 'E-077':
      return [...METHOD_NAMES];
    case 'E-078':
      return [...CHANNEL_PATHS];
    case 'E-079':
      return [...LEGACY_METHODS];
    case 'E-080':
      return METHOD_NAMES.map(resultSchemaName);
    default:
      return [];
  }
}

function actualList(caseId, check) {
  switch (caseId) {
    case 'E-077':
      return [...METHOD_NAMES.filter((m) => !check.missing.includes(m)), ...check.extra];
    case 'E-078':
      return CHANNEL_PATHS.filter((p) => !check.missing.includes(p));
    case 'E-079':
      return [...LEGACY_METHODS.filter((m) => !check.missing.includes(m)), ...check.extra];
    case 'E-080':
      return [
        ...METHOD_NAMES.filter((m) => !check.missing.includes(m)).map(resultSchemaName),
        ...check.extra,
      ];
    default:
      return [];
  }
}

function buildRun(caseId) {
  return async function run(ctx) {
    const contract = loadContract({ repoRoot: ctx.repoRoot });
    if (contract.openapi === 'missing') {
      // 缺失态按冻结 §8 / 02-contract §6 标 pending（pending 仅用于 OpenAPI 缺失的覆盖核对）：
      // 不伪造 passed，交宿主记 pending；不是 skipped。
      ctx.pending(PENDING_REASON);
    }
    const result = runChecks(contract, { repoRoot: ctx.repoRoot });
    const check = result.checks.find((c) => c.id === caseId);

    const assertions = [
      // 契约文件必须真的解析成 OpenAPI 文档：文件在但结构坏了要在这里红，
      // 而不是靠四条 count/missing 断言碰巧不成立。
      ctx.make('contractParsed', 'present 且结构可识别', result.openapi, {
        ok: result.openapi === 'present',
      }),
      ctx.make(`${check.name}-count`, check.expected, check.actual),
      ctx.make(`${check.name}-missing`, [], check.missing),
      ctx.make(`${check.name}-extra`, [], check.extra),
    ];
    if (Array.isArray(check.duplicates)) {
      assertions.push(ctx.make(`${check.name}-duplicates`, [], check.duplicates));
    }

    return {
      assertions,
      expected: expectedList(caseId),
      actual: actualList(caseId, check),
      error: null,
    };
  };
}

export const CASES = [
  { id: 'E-077', kind: 'oas', method: null, channel: 'openapi', targets: '*', run: buildRun('E-077') },
  { id: 'E-078', kind: 'oas', method: null, channel: 'openapi', targets: '*', run: buildRun('E-078') },
  { id: 'E-079', kind: 'oas', method: null, channel: 'openapi', targets: '*', run: buildRun('E-079') },
  { id: 'E-080', kind: 'oas', method: null, channel: 'openapi', targets: '*', run: buildRun('E-080') },
];
