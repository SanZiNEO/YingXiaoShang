// E 轮 · OpenAPI 覆盖核对（冻结 §5/§6/§7/§8，02-contract.md §7）
//
// 本模块不依赖任何第三方 YAML 包；下方 parseYaml 是一个只服务于本模块四处
// 提取目标的轻量缩进块解析器。
//
// 【解析器覆盖的 YAML 写法】
//   1. 缩进嵌套块：`key:` 下一层缩进的子对象 / 子数组；
//   2. 行内数组：`enum: [a, b, c]`（支持引号包裹的元素、逗号在引号内不切分）；
//   3. 块状列表：`- item`，含 `- key: value` 形态的数组项及其同级兄弟键；
//   4. 注释行（整行 `# ...`）与空行跳过；行内 ` # ...` 注释在引号外剥离；
//   5. 单引号 / 双引号标量与键名去引号；路径键（如 `/api/v1/rpc:`）中的冒号不误切；
//   6. 本地 `$ref: '#/components/schemas/X'` 一层解析（请求体 schema 引用 components 时回链取值）；
//   7. 块标量 `|` / `>`：后续缩进行吞为一段字符串，不参与结构归属；
//   8. 锚点定义 `&name` 后挂嵌套块（锚点名忽略，子块正常递归）；空流式对象 `{}`；
//   9. 别名叶子 `*name` 按字符串保留（不回链锚点目标；别名不会再带子块）。
//
// 【解析器明确不覆盖的写法】（本模块不做兼容，遇到按缺失处理并在报告里列差集）
//   - 非空流式对象 `{a: 1, b: 2}`（空 `{}` 支持；流式数组 `[...]` 支持）；
//   - 别名 `*name` 解析到锚点的实际内容、合并键 `<<`；
//   - 远程 / 循环 `$ref`、跨文件引用；
//   - 多文档 `---` 分隔、标签类型 `!!str`、`${...}` 占位插值；
//   - 嵌套过深的数组项内再嵌数组（只支持数组项为标量或单层对象）；
//   - 数字 / 布尔 / null 的类型还原（标量一律按字符串保留，null 仅识别空值与 `~`/`null`）。
// 以上不覆盖项若出现在 A 轮产物里，应在 coverage 报告的 missing/extra 差集中暴露，
// 由 A 修；E 轮不改 yaml（冻结 §8）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 契约文件在仓库内的冻结相对路径（02-contract.md §7）。 */
export const CONTRACT_FILE = 'docs/contracts/openapi.yaml';

/** 四条覆盖核对编号（02-contract.md §2.1 编号段 E-077 … E-080）。 */
export const CHECK_IDS = ['E-077', 'E-078', 'E-079', 'E-080'];

/** 冻结 §7 的 5 个专用通道 path。 */
export const CHANNEL_PATHS = [
  '/api/v1/chat/stream',
  '/api/v1/chat/cancel',
  '/api/v1/answer',
  '/api/v1/answer-set',
  '/api/v1/health',
];

/** 冻结 §6 的 4 个 legacy 只读方法（不计入 30 方法覆盖统计）。 */
export const LEGACY_METHODS = ['getKp', 'getBlock', 'getResource', 'listIdeology'];

/** 冻结 §5 的 30 个业务方法，顺序即冻结表 #1 … #30。 */
export const METHOD_NAMES = [
  'student.current',
  'chapters.list',
  'kps.list',
  'news.list',
  'news.status',
  'news.refresh',
  'news.get',
  'news.match',
  'questions.attempts',
  'profile.get',
  'profile.growth',
  'profile.evidence',
  'profile.snapshot',
  'profile.review',
  'artifacts.list',
  'artifacts.get',
  'artifacts.export',
  'memory.facts',
  'memory.episodes',
  'memory.summary',
  'memory.upsert',
  'memory.delete',
  'chat.sessions',
  'chat.messages',
  'agent.snapshot',
  'agent.suggestions',
  'agent.turns',
  'agent.ledger',
  'agent.retry',
  'agent.sessions',
];

/**
 * 方法名 → Result schema 名（冻结 §8：点转驼峰，如 news.list → NewsListResult）。
 * 按点分段，每段首字母大写后拼接，末尾加 `Result`。
 */
export function resultSchemaName(method) {
  return method
    .split('.')
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join('') + 'Result';
}

// ---------------------------------------------------------------------------
// 轻量 YAML 解析
// ---------------------------------------------------------------------------

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let cur = '';
  for (const c of s) {
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    if ((c === '[' || c === '{') && !inSingle && !inDouble) depth++;
    if ((c === ']' || c === '}') && !inSingle && !inDouble) depth--;
    if (c === sep && depth === 0 && !inSingle && !inDouble) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevel(inner, ',').map((x) => unquote(x));
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    // 只认空流式对象 `{}`；非空流式对象不解析，原样留字符串。
    return s.slice(1, -1).trim() === '' ? {} : s;
  }
  return unquote(s);
}

function splitKv(text) {
  const m = /^([^\s:][^:]*?):(?:\s+(.*))?$/.exec(text);
  if (!m) return [unquote(text), ''];
  return [unquote(m[1]), m[2] === undefined ? '' : m[2]];
}

/** 锚点定义标量，如 `&a1`；其后仍可能挂嵌套块。 */
const ANCHOR_RE = /^&[\w.-]+$/;
/** 块标量标记 `|` / `>`（含 `-`/`+` 裁剪后缀）。 */
const BLOCK_SCALAR_RE = /^[|>][+-]?\s*$/;

function consumeBlockScalar(lines, i, indent) {
  const body = [];
  while (i < lines.length && lines[i].indent > indent) {
    body.push(lines[i].text);
    i++;
  }
  return [body.join('\n'), i];
}

/**
 * 解析一个键的值，返回 [value, nextIndex]。
 * 空值 / 锚点标记且后续有更深缩进 → 递归子块；块标量标记 → 吞掉后续缩进行为字符串；
 * 其余按标量。
 */
function parseValue(lines, i, indent, val) {
  if (val === '' || ANCHOR_RE.test(val)) {
    if (i + 1 < lines.length && lines[i + 1].indent > indent) {
      const [child, ni] = parseBlock(lines, i + 1, lines[i + 1].indent);
      return [child, ni];
    }
    return [null, i + 1];
  }
  if (BLOCK_SCALAR_RE.test(val)) {
    return consumeBlockScalar(lines, i + 1, indent);
  }
  return [parseScalar(val), i + 1];
}

function prepareLines(text) {
  const lines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const noComment = stripComment(rawLine);
    if (noComment.trim() === '') continue;
    const indent = noComment.match(/^ */)[0].length;
    lines.push({ indent, text: noComment.trim() });
  }
  return lines;
}

function parseObject(lines, start, indent) {
  const obj = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i];
    if (/^-(\s|$)/.test(line.text)) break;
    const [key, val] = splitKv(line.text);
    const [v, ni] = parseValue(lines, i, indent, val);
    obj[key] = v;
    i = ni;
  }
  return [obj, i];
}

function parseArray(lines, start, indent) {
  const arr = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && /^-(\s|$)/.test(lines[i].text)) {
    const line = lines[i];
    const rest = line.text === '-' ? '' : line.text.slice(1).trim();
    if (rest === '') {
      const [child, ni] = parseBlock(lines, i + 1, lines[i + 1].indent);
      arr.push(child);
      i = ni;
      continue;
    }
    const [k0, v0] = splitKv(rest);
    if (rest.includes(':') && !rest.startsWith('[')) {
      const obj = {};
      const [v, ni] = parseValue(lines, i, indent, v0);
      obj[k0] = v;
      i = ni;
      // 吸收该数组项（对象）缩进更深的同级兄弟键。
      while (i < lines.length && lines[i].indent > indent && !/^-(\s|$)/.test(lines[i].text)) {
        const [k2, v2] = splitKv(lines[i].text);
        const [v2val, ni2] = parseValue(lines, i, lines[i].indent, v2);
        obj[k2] = v2val;
        i = ni2;
      }
      arr.push(obj);
    } else {
      arr.push(parseScalar(rest));
      i++;
    }
  }
  return [arr, i];
}

function parseBlock(lines, start, indent) {
  if (start >= lines.length) return [null, start];
  const first = lines[start];
  if (/^-(\s|$)/.test(first.text)) return parseArray(lines, start, indent);
  return parseObject(lines, start, indent);
}

/** 解析 yaml 文本为嵌套对象/数组树；解析不出结构时返回空对象。 */
export function parseYaml(text) {
  const lines = prepareLines(text);
  if (lines.length === 0) return {};
  const [node] = parseBlock(lines, 0, lines[0].indent);
  return node ?? {};
}

// ---------------------------------------------------------------------------
// 四处提取
// ---------------------------------------------------------------------------

function asArray(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

/** 本地 `#/components/schemas/X` 一层回链；非本地 ref 或解析失败时原样返回节点。 */
function resolveRef(doc, node) {
  if (!node || typeof node !== 'object' || typeof node.$ref !== 'string' || !node.$ref.startsWith('#/')) {
    return node;
  }
  const parts = node.$ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = doc;
  for (const p of parts) {
    cur = cur?.[p];
  }
  return cur ?? node;
}

/** 在 rpc 子树内递归寻找带 `enum` 的 `method` 属性（标准位置找不到时的兜底）。 */
function findMethodEnum(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.method && Array.isArray(node.method.enum)) return node.method.enum;
  for (const k of Object.keys(node)) {
    const hit = findMethodEnum(node[k]);
    if (hit) return hit;
  }
  return null;
}

function extractMethodEnum(doc) {
  const rpc = doc?.paths?.['/api/v1/rpc'];
  if (!rpc) return [];
  // 标准位置：paths./api/v1/rpc.post.requestBody.content.application/json.schema；
  // 兼容 operation 节点直接挂 requestBody 的写法。
  const operation = rpc.post ?? rpc;
  let schema = operation?.requestBody?.content?.['application/json']?.schema;
  schema = resolveRef(doc, schema) ?? schema;
  const direct = schema?.properties?.method?.enum ?? schema?.properties?.method?.items?.enum;
  if (Array.isArray(direct)) return asArray(direct);
  const fallback = findMethodEnum(rpc);
  return fallback ? asArray(fallback) : [];
}

function extractLegacy(doc) {
  const raw = doc?.['x-legacy-methods'];
  if (!Array.isArray(raw)) return [];
  // 兼容两种写法：纯字符串列表 `[getKp, ...]`，或对象列表 `[{ name: getKp, ... }]`。
  return raw
    .map((item) => (item && typeof item === 'object' ? String(item.name ?? '') : String(item)))
    .filter(Boolean);
}

function extractSchemaKeys(doc) {
  const schemas = doc?.components?.schemas;
  return schemas && typeof schemas === 'object' ? Object.keys(schemas) : [];
}

function extractPathNames(doc) {
  const paths = doc?.paths;
  return paths && typeof paths === 'object' ? Object.keys(paths) : [];
}

// ---------------------------------------------------------------------------
// 契约加载与四项核对
// ---------------------------------------------------------------------------

function repoRootFromHere() {
  // HERE = tools/contract-tests/src，上溯三级到仓库根。
  return path.resolve(HERE, '..', '..', '..');
}

/**
 * 加载契约文件。stat/read 只发生在本函数内一次；`readAt` 是本次读取的 ISO 时刻，
 * 后续 runChecks 判定复用同一次读取结果，不再二次读文件。
 * @param {{ repoRoot?: string, file?: string }} [options]
 *   `repoRoot` 仓库根；缺省按本模块位置上溯两级定位。
 *   `file` 可选覆盖读取路径（自检注入合成 yaml 用；相对路径基于 repoRoot，绝对路径原样使用）。
 * @returns {{ openapi: 'present'|'missing', file: string, doc: object|null, readAt: string }}
 */
export function loadContract({ repoRoot, file } = {}) {
  const readAt = new Date().toISOString();
  const root = repoRoot ?? repoRootFromHere();
  const abs = file ? path.resolve(root, file) : path.join(root, CONTRACT_FILE);
  if (!fs.existsSync(abs)) {
    // 只有「文件不存在」才降级 pending：这是 A 轮产物还没落盘的正常并行状态。
    return { openapi: 'missing', file: CONTRACT_FILE, doc: null, readAt, parseError: null };
  }
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (error) {
    return {
      openapi: 'invalid',
      file: CONTRACT_FILE,
      doc: null,
      readAt,
      parseError: `契约文件存在但读不出来：${error?.message ?? String(error)}`,
    };
  }
  const doc = parseYaml(text);
  const problem = describeStructureProblem(doc);
  if (problem) {
    // 文件在、解析不出 OpenAPI 结构：这是「契约坏了」，不是「契约还没来」。
    // 以前这里 catch 成 doc=null 再按 present 走 pending 退出 0，等于把坏文件伪装成缺失。
    return { openapi: 'invalid', file: CONTRACT_FILE, doc: null, readAt, parseError: problem };
  }
  return { openapi: 'present', file: CONTRACT_FILE, doc, readAt, parseError: null };
}

/**
 * 结构体检：一份能用的 OpenAPI 文档至少要有版本键与 paths。
 * 返回 null 表示结构可认；返回字符串表示哪里不认（写进报告，供人判断是解析器退化还是文件真坏了）。
 */
function describeStructureProblem(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return '解析结果不是对象：YAML 结构不可识别。';
  }
  const version = doc.openapi ?? doc.swagger;
  if (typeof version !== 'string' || version.length === 0) {
    return '缺少 openapi / swagger 版本键：解析结果不像 OpenAPI 文档。';
  }
  const paths = doc.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths) || Object.keys(paths).length === 0) {
    return '缺少非空 paths：解析结果不像 OpenAPI 文档。';
  }
  return null;
}

function diff(expected, actual) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((x) => !actualSet.has(x));
  const extra = actual.filter((x) => !expectedSet.has(x));
  return { missing, extra };
}

/** 重复出现的项（只报第 2 次及以后，便于报告里看出重复了几次）。 */
function duplicatesOf(list) {
  const seen = new Set();
  const duplicated = [];
  for (const item of list) {
    if (seen.has(item)) duplicated.push(item);
    else seen.add(item);
  }
  return duplicated;
}

function checkEnum(enumNames) {
  const { missing, extra } = diff(METHOD_NAMES, enumNames);
  // 集合语义看不见重复项：30 项里塞一个重复、同时漏一个方法时，missing/extra 会双双为空，
  // 只有把「条数」与「去重后的条数」一起比，E-077 才不会被重复枚举骗成绿。
  const duplicates = duplicatesOf(enumNames);
  return {
    id: 'E-077',
    name: 'method-enum',
    expected: METHOD_NAMES.length,
    actual: enumNames.length,
    ok: missing.length === 0
      && extra.length === 0
      && duplicates.length === 0
      && enumNames.length === METHOD_NAMES.length,
    missing,
    extra,
    duplicates,
  };
}

function checkChannels(pathNames) {
  const present = new Set(pathNames);
  const missing = CHANNEL_PATHS.filter((p) => !present.has(p));
  return {
    id: 'E-078',
    name: 'channel-paths',
    expected: CHANNEL_PATHS.length,
    actual: CHANNEL_PATHS.length - missing.length,
    ok: missing.length === 0,
    missing,
    extra: [],
  };
}

function checkLegacy(legacyNames, enumNames) {
  const { missing, extra } = diff(LEGACY_METHODS, legacyNames);
  // 冻结 §6：legacy 必须出现在 x-legacy-methods 扩展里，不得混入 method 枚举。
  // 误入枚举的 legacy 记入 extra 明细，便于报告交 A 修。
  const leaked = LEGACY_METHODS.filter((m) => enumNames.includes(m));
  const leakedExtra = leaked.filter((m) => !extra.includes(m));
  return {
    id: 'E-079',
    name: 'legacy-methods',
    expected: LEGACY_METHODS.length,
    actual: legacyNames.length,
    ok: missing.length === 0 && extra.length === 0 && leaked.length === 0,
    missing,
    extra: [...extra, ...leakedExtra],
  };
}

function checkSchemas(schemaKeys) {
  const present = new Set(schemaKeys);
  const missing = METHOD_NAMES.filter((m) => !present.has(resultSchemaName(m)));
  // E-080 只核对 30 方法的 <Method>Result 齐备；健康/登录等伴随 schema 虽以 Result 结尾，
  // 不属方法覆盖范围，不计 extra（冻结 §8「至少覆盖 30」，不多收伴随 schema）。
  return {
    id: 'E-080',
    name: 'result-schemas',
    expected: METHOD_NAMES.length,
    actual: METHOD_NAMES.length - missing.length,
    ok: missing.length === 0,
    missing,
    extra: [],
  };
}

function pendingReport(readAt) {
  // openapi 缺失：按冻结 §8 标 pending，不判红；missing 列出冻结表应有全部项。
  return {
    openapi: 'missing',
    file: CONTRACT_FILE,
    readAt: readAt ?? null,
    parseError: null,
    status: 'pending',
    checks: [
      { id: 'E-077', name: 'method-enum', expected: METHOD_NAMES.length, actual: 0, ok: false, missing: [...METHOD_NAMES], extra: [] },
      { id: 'E-078', name: 'channel-paths', expected: CHANNEL_PATHS.length, actual: 0, ok: false, missing: [...CHANNEL_PATHS], extra: [] },
      { id: 'E-079', name: 'legacy-methods', expected: LEGACY_METHODS.length, actual: 0, ok: false, missing: [...LEGACY_METHODS], extra: [] },
      { id: 'E-080', name: 'result-schemas', expected: METHOD_NAMES.length, actual: 0, ok: false, missing: [...METHOD_NAMES], extra: [] },
    ],
  };
}

/**
 * 跑四项覆盖核对。
 * @param {{ openapi: string, file: string, doc: object|null, readAt?: string }} contract loadContract 的返回
 * @param {{ repoRoot?: string }} [options]
 * @returns {{ openapi: string, file: string, readAt: string|null, status: 'green'|'pending'|'red', checks: object[] }}
 */
export function runChecks(contract, { repoRoot } = {}) {
  void repoRoot;
  // 只有「文件不存在」才是 pending（A 轮产物未落盘）；文件在但解析不出结构是 red。
  if (!contract || contract.openapi === 'missing') {
    return pendingReport(contract?.readAt);
  }
  if (contract.openapi !== 'present' || contract.doc == null) {
    return invalidReport(contract?.readAt, contract?.parseError ?? '契约文件存在但无法解析为 OpenAPI 文档。');
  }
  const enumNames = extractMethodEnum(contract.doc);
  const legacyNames = extractLegacy(contract.doc);
  const schemaKeys = extractSchemaKeys(contract.doc);
  const pathNames = extractPathNames(contract.doc);

  const checks = [
    checkEnum(enumNames),
    checkChannels(pathNames),
    checkLegacy(legacyNames, enumNames),
    checkSchemas(schemaKeys),
  ];
  const status = checks.every((c) => c.ok) ? 'green' : 'red';
  return {
    openapi: 'present',
    file: CONTRACT_FILE,
    readAt: contract.readAt ?? null,
    parseError: null,
    status,
    checks,
  };
}

/**
 * 文件在、但解析不出可用结构：按 red 处理，四条核对全部记 ok=false，
 * 并在 parseError 里写明原因。绝不再走 pending（那会让坏契约以退出码 0 通过）。
 */
function invalidReport(readAt, parseError) {
  return {
    openapi: 'invalid',
    file: CONTRACT_FILE,
    readAt: readAt ?? null,
    parseError,
    status: 'red',
    checks: [
      { id: 'E-077', name: 'method-enum', expected: METHOD_NAMES.length, actual: 0, ok: false, missing: [...METHOD_NAMES], extra: [], duplicates: [] },
      { id: 'E-078', name: 'channel-paths', expected: CHANNEL_PATHS.length, actual: 0, ok: false, missing: [...CHANNEL_PATHS], extra: [] },
      { id: 'E-079', name: 'legacy-methods', expected: LEGACY_METHODS.length, actual: 0, ok: false, missing: [...LEGACY_METHODS], extra: [] },
      { id: 'E-080', name: 'result-schemas', expected: METHOD_NAMES.length, actual: 0, ok: false, missing: [...METHOD_NAMES], extra: [] },
    ],
  };
}
