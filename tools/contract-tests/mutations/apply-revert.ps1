<#
.SYNOPSIS
  E 轮 mutation apply / revert 回放驱动（02-contract §10、04-acceptance §5）。

.DESCRIPTION
  流程：打印改前 git status --porcelain → 调 node src/patch.mjs --run 回放 →
  打印中文汇总表与 killed 证据行 → 打印改后 git status --porcelain apps/server docs/contracts。

  安全边界：
  - 不使用 git checkout / git stash / git reset 还原；还原由 patch.mjs 按原字节备份写回。
  - 不删除 report 目录之外的任何文件。
  - 退出码：全部 not-run / anchor-miss → 0；任一条 killed 且全部已还原 → 0；
    任一条 survived 或 revert-failed（或有未还原改动）→ 1。

.PARAMETER Only
  可选，重复传入：只回放指定 mutation id（M1 / M2 / M3）。

.PARAMETER Report
  可选：diff 与回放产物落盘目录；缺省由 src/patch.mjs 决定（tools/contract-tests/report）。
#>

[CmdletBinding()]
param(
  [string[]]$Only,
  [string]$Report
)

$ErrorActionPreference = 'Stop'
$toolRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $toolRoot '..\..')).Path

Write-Host '== 改前 git status --porcelain =='
$pre = git -C $repoRoot status --porcelain
if ($pre) { $pre | ForEach-Object { Write-Host $_ } } else { Write-Host '(工作区无未提交改动)' }

$nodeArgs = @('src/patch.mjs', '--run')
if ($Only) {
  foreach ($id in $Only) { $nodeArgs += '--only'; $nodeArgs += $id }
}
if ($Report) {
  $nodeArgs += '--report'
  $nodeArgs += $Report
}

Write-Host ''
Write-Host ("== 执行: node " + ($nodeArgs -join ' ') + " ==")
$output = & node @nodeArgs 2>&1
$nodeExit = $LASTEXITCODE
$output | ForEach-Object { Write-Host $_ }

# 从 node 输出里提取 JSON 数组（首行中文摘要之后的那段 JSON），并平铺成单条对象列表。
$jsonText = ($output -join "`n")
$results = @()
$start = $jsonText.IndexOf('[')
if ($start -ge 0) {
  $end = $jsonText.LastIndexOf(']')
  if ($end -gt $start) {
    $parsed = $jsonText.Substring($start, $end - $start + 1) | ConvertFrom-Json
    foreach ($item in @($parsed)) { $results += $item }
  }
}

Write-Host ''
Write-Host '== mutation 回放汇总 =='
foreach ($r in $results) {
  $gitMark = if ($null -ne $r.gitStatus) { $r.gitStatus } else { '' }
  Write-Host ("{0}  {1,-13}  git=[{2}]  用例 {3}  applied={4}  reverted={5}  {6}" -f `
    $r.id, $r.status, $gitMark, $r.targetCase, $r.applied, $r.reverted, $r.reason)
}

$killed = @($results | Where-Object { $_.status -eq 'killed' })
foreach ($k in $killed) {
  Write-Host ("killed 证据：{0} 已使用例 {1} 变红，且已还原（reverted={2}）" -f `
    $k.id, $k.targetCase, $k.reverted)
}

$bad = @($results | Where-Object { $_.status -eq 'survived' -or $_.status -eq 'revert-failed' })
$unreverted = @($results | Where-Object { -not $_.reverted })

Write-Host ''
Write-Host '== 改后 git status --porcelain apps/server docs/contracts =='
$post = git -C $repoRoot status --porcelain -- apps/server docs/contracts
if ($post) { $post | ForEach-Object { Write-Host $_ } } else { Write-Host '(为空)' }

if ($bad.Count -gt 0 -or $unreverted.Count -gt 0 -or $nodeExit -ne 0) {
  exit 1
}
exit 0
