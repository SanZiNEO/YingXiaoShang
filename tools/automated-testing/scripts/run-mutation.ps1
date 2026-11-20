<#
.SYNOPSIS
  H 轮 Electron mutation 闭环编排脚本（Windows PowerShell 5.1 与 PowerShell 7 均可运行）。

.DESCRIPTION
  闭环顺序：预检工作区 -> 取 Electron 锁 -> 基线跑 -> 逐条 apply -> 定向构建 -> 红跑 ->
  finally 还原 -> 定向构建 -> 绿跑 -> 工作区校验 -> 汇总写 mutation-report.md。

  代码事实（实测，脚本口径据此固定，请勿凭描述改动）：

  0) 运行环境：目标解释器是 Windows 自带的 `powershell.exe` 5.1，不依赖 `pwsh`。
     由此带来三条硬约束：
       - 本文件必须以 UTF-8 **带 BOM** 保存。5.1 读取无 BOM 的 .ps1 时按 ANSI 解码，
         脚本里的中文直接量（关键词、中文消息）会变成乱码，红例关键词判定直接失效。
       - 不能用 `??` 空合并运算符、不能用 `[System.IO.Path]::GetRelativePath`
         （.NET Framework 没有该方法），不能用三元 `? :`。
       - `$ErrorActionPreference='Stop'` 下原生命令写 stderr 会抛 NativeCommandError，
         而 pnpm / playwright / robocopy 都会写 stderr，故 Invoke-Native 内部临时降级。

  1) 构建口径：根 `pnpm build` = `pnpm -r build`，会连带构建 apps/server；其
     `apps/server/src/auth/routes.ts` 当前存在 TS 语法错误导致 exit 2，与 H 轮无关，
     本轮禁止调用根 build，也不改 apps/server 代码。改为按 mutant 目标路径定向构建：
       - 目标在 packages/agent/**（M2/M3）：先 `pnpm --dir packages/agent build`
         （实测 packages/agent/package.json 的 scripts.build = `tsc -b`），再
         `pnpm --dir apps/desktop build`（electron-vite build）；两步都须 exit 0。
       - 目标只在 apps/desktop/**（M1/M4/M5）：只跑 `pnpm --dir apps/desktop build`。
     任一步非 0 -> 记 apply-failed 类错误、退出码 3，不跑红例也不跑绿例。
     apps/desktop 以 packages/agent/lib/ 打包，漏掉 packages 前置构建会让改动不生效 -> 假绿。

  2) M4 打包坑：apps/desktop/seed/learning.db 当前不存在（scripts/package-desktop.mjs:84
     打包后 rmSync(desktopDir/seed)）；electron-builder.yml 的 extraResources 需要
     seed/learning.db。重打包前必须把 release/win-unpacked/resources/seed/learning.db
     复制到 apps/desktop/seed/learning.db（.gitignore 已忽略该目录），打包完成后删除；
     否则 win-unpacked 缺种子库 -> p0-08 命中 learning.db 关键词假红（环境错误，非断言）。

  3) 离线打包：复用 apps/desktop devDependency 已解包的 electron dist；若
     apps/desktop/node_modules/electron/dist/electron.exe 存在，追加
     `-c.electronDist=<dist 绝对路径>`；取不到就不加该参数，不联网等待下载。

  4) 不调用 `node scripts/package-desktop.mjs`：它会先 pnpm build、造种子库、打 NSIS
     安装包并删 seed，比 `electron-builder --dir` 慢且副作用多；M4 重打包只用 --dir。

  5) 测试入口用 `pnpm --dir tools/automated-testing exec playwright test --reporter=list
     --output=<dir> <spec>`，而不是 `pnpm ... test -- <spec>`：后者在本机 PowerShell 下
     实测被 Playwright 当成全量 31 条执行（文件过滤参数丢失），会覆盖 `.artifacts`
     历史报告。exec 入口仍复用同一 `playwright.config.ts`、driver 与 fixture；CLI
     `--reporter=list` 覆盖配置里的 CaseReporter，实测 report.md 不再被重写；证据 fixture
     仍会向 `.artifacts/index.jsonl` 追加行，脚本开跑前备份、结束时还原。

  锚点口径（对照 plans/server-client-split/H-electron-mutation/02-contract.md §2.2）：

  - M3（streaming.patch，packages/agent/src/team.ts:157-160）：删除 tool-start -> type:'tool'
    的转发分支。p0-03-chat-stream.spec.ts 全文没有 tool / tool-end 帧断言（:22-31 只断言
    session 与 text(lead)，:73-75 同样只到 text），按 01-scope §2「不为 mutant 补写新断言」
    的要求，本条**预期 survived**：这是真实的覆盖缺口，不是脚本失败。脚本照常跑红/绿两段，
    红阶段退出码 0 即记 survived（退出码 1），缺口写进 notes。
  - M4（packaged-boot.patch，apps/desktop/src/main/index.ts:157）：loadFile 指向不存在的
    out/renderer/missing.html。driver 的 `waitForFunction(learning.health)` 会超时，
    属环境错误（classification=timeout），按契约 §4.2 不计 killed，记 skipped 并写明环境原因。
    改页面标题（renderer/index.html）会把缺陷挪到 p0-01 / p0-02 也断言得到的位置，且与
    packaged 目标无关，属等价替换而非契约点，故不采用。

  退出码（契约 02-contract §4.1）：0 全绿/符合预期（含按约定 skipped）；1 存在 survived；
  2 前置不可用（锁未取得、基线红、driver 环境不可用）；3 参数或 apply/build 失败；
  4 还原失败或工作区脏；5 绿阶段仍红。优先级 4 > 5 > 3 > 2 > 1 > 0。
  单条 mutant 因 packaged 产物缺失而 skipped 属于「按约定 skipped」，整体仍为 0；
  只有锁未取得 / 基线红 / 全局环境不可用才返回 2。

  `-Drill <name>` 用于演练验收项（AC-H-09 锁跳过、AC-H-11 DryRun、AC-H-13 还原失败、
  AC-H-14 隔离核对）：每条演练把结果写进 `.scratch/run/H/drills/<name>/result.json`，
  报告里生成「AC 演练记录」表。演练退出码：0 全部符合预期；5 演练预期未满足；3 参数错。

.PARAMETER ReportPath
  报告落点。默认 `tools/automated-testing/mutation-report.md`；演练用独立路径，避免覆盖正式报告。
#>

[CmdletBinding()]
param(
  [string]$Case,
  [string]$Apply,
  [string]$Revert,
  [switch]$All,
  [switch]$DryRun,
  [switch]$RefreshReport,
  [ValidateSet('dryrun', 'lock', 'revert', 'isolation', 'all')]
  [string]$Drill,
  [string]$PatchDir = 'tools/automated-testing/mutations',
  [string]$ReportPath = 'tools/automated-testing/mutation-report.md',
  [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
$script:ScriptVersion = '1.1.0'

# 5.1 的控制台输出编码默认是 gb2312，原生命令（node / pnpm / playwright）写出的 UTF-8
# 中文会被按 GBK 解码成乱码，导致关键词匹配（「没有静默」「营小商」等）全部落空。
# 实测：不设置时 `$out.Contains('必须收到 session 事件')` 为 False，设置后为 True。
# 必须在任何原生命令调用之前执行。
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

# ---------------------------------------------------------------------------
# 登记表（按 02-contract §2.2 契约锚点；M3 预期 survived、M4 预期 skipped，理由见头注释）
# ---------------------------------------------------------------------------
$script:Mutants = @(
  [pscustomobject]@{
    Id            = 'M1'
    Patch         = 'cancel.patch'
    TargetFile    = 'apps/desktop/src/main/index.ts'
    AnchorLine    = 485
    Tc            = 'TC-P1-03'
    Spec          = 'src/scenarios/p1-03-cancel.spec.ts'
    Keywords      = @('没有静默', 'toBeInstanceOf')
    BuildTargets  = @('desktop')
    IsPackaged    = $false
    AsarMarker    = ''
    Expected      = 'killed'
    DefectSummary = '取消控制器不再把 AbortSignal 交进执行链——点「停止」只断界面回调，在途模型请求继续跑（历史假停缺陷）。'
    Notes         = ''
  },
  [pscustomobject]@{
    Id            = 'M2'
    Patch         = 'answer-set.patch'
    TargetFile    = 'packages/agent/src/index.ts'
    AnchorLine    = 856
    Tc            = 'TC-P0-06'
    Spec          = 'src/scenarios/p0-06-answer-set.spec.ts'
    Keywords      = @('questionId', 'score', 'toHaveLength')
    BuildTargets  = @('packages', 'desktop')
    IsPackaged    = $false
    AsarMarker    = ''
    Expected      = 'killed'
    DefectSummary = '交卷返回的 results 丢掉 questionId / score 等判分字段（DB 落库链路不动）。'
    Notes         = ''
  },
  [pscustomobject]@{
    Id            = 'M3'
    Patch         = 'streaming.patch'
    TargetFile    = 'packages/agent/src/team.ts'
    AnchorLine    = 157
    Tc            = 'TC-P0-03'
    Spec          = 'src/scenarios/p0-03-chat-stream.spec.ts'
    Keywords      = @('必须收到 session 事件', 'toBeGreaterThan')
    BuildTargets  = @('packages', 'desktop')
    IsPackaged    = $false
    AsarMarker    = ''
    Expected      = 'survived'
    DefectSummary = 'tool-start 帧不再转发给界面（type:''tool'' 不发出），工具帧序列缺开始帧。'
    Notes         = '覆盖缺口（01-scope §2 明文要求如实记录）：p0-03 只断言 session / text(lead) 帧，全文没有 tool / tool-end 帧断言，故删除 tool-start 转发后用例仍绿，本条预期 survived。后续补断言方向：工具帧与 tool-end 配对顺序。'
  },
  [pscustomobject]@{
    Id            = 'M4'
    Patch         = 'packaged-boot.patch'
    TargetFile    = 'apps/desktop/src/main/index.ts'
    AnchorLine    = 157
    Tc            = 'TC-P0-08'
    Spec          = 'src/scenarios/p0-08-packaged-boot.spec.ts'
    Keywords      = @('营小商', 'app.asar', 'user_version', 'learning.db')
    BuildTargets  = @('desktop')
    IsPackaged    = $true
    AsarMarker    = 'missing.html'
    Expected      = 'skipped'
    DefectSummary = 'packaged 首窗 loadFile 指向不存在的 out/renderer/missing.html，界面起不来。'
    Notes         = '环境原因预期：loadFile 指向不存在路径后 driver 的 waitForFunction(learning.health) 超时，失败分类为 timeout（契约 §4.2 不计 killed），本条按 skipped 记录并写明缺失环节。'
  },
  [pscustomobject]@{
    Id            = 'M5'
    Patch         = 'empty-question-set.patch'
    TargetFile    = 'apps/desktop/src/renderer/src/question-set.ts'
    AnchorLine    = 12
    Tc            = 'TC-P1-02'
    Spec          = 'src/scenarios/p1-02-empty-question-set.spec.ts'
    Keywords      = @('retry', 'question-set')
    BuildTargets  = @('desktop')
    IsPackaged    = $false
    AsarMarker    = ''
    Expected      = 'killed'
    DefectSummary = '空题集判定恒返回 markdown，空题集不再走 retry 兜底（学生进入死胡同）。'
    Notes         = ''
  }
)

# ---------------------------------------------------------------------------
# 路径解析
# ---------------------------------------------------------------------------
if (-not $RepoRoot) {
  $candidate = $PSScriptRoot
  for ($i = 0; $i -lt 5 -and $candidate; $i++) {
    if (Test-Path (Join-Path $candidate '.git')) { break }
    $parent = Split-Path $candidate -Parent
    if (-not $parent) { break }
    $candidate = $parent
  }
  $RepoRoot = $candidate
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
if (-not (Test-Path (Join-Path $RepoRoot '.git'))) {
  Write-Host "[H] 仓库根缺少 .git 目录：$RepoRoot"
  exit 3
}
if (-not [System.IO.Path]::IsPathRooted($PatchDir)) {
  $PatchDir = Join-Path $RepoRoot $PatchDir
}
$PatchDir = [System.IO.Path]::GetFullPath($PatchDir)
if (-not [System.IO.Path]::IsPathRooted($ReportPath)) {
  $ReportPath = Join-Path $RepoRoot $ReportPath
}
$script:ReportPath = [System.IO.Path]::GetFullPath($ReportPath)

$script:ScratchRoot = Join-Path $RepoRoot '.scratch/run/H'
$script:DrillRoot = Join-Path $script:ScratchRoot 'drills'
$script:LockDir = Join-Path $RepoRoot '.scratch/run/electron.lock'
$script:ArtifactsRoot = Join-Path $RepoRoot 'tools/automated-testing/.artifacts'
$script:IndexJsonl = Join-Path $script:ArtifactsRoot 'index.jsonl'

# ---------------------------------------------------------------------------
# 基础辅助（PS 5.1 兼容：不用 ?? / 三元 / Path.GetRelativePath）
# ---------------------------------------------------------------------------
function Write-Global([string]$Detail) { Write-Host "[H] $Detail" }
function Write-Phase([string]$Tag, [string]$Phase, [string]$Detail) {
  Write-Host "[$Tag] $Phase $Detail"
}

function Ensure-Dir([string]$Path) {
  if (-not (Test-Path $Path)) { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
}

# 证据文件统一写 UTF-8 无 BOM：5.1 的 `-Encoding utf8` 会带 BOM，跨机器比对时是噪音。
function Write-TextFile([string]$Path, [string]$Text) {
  $dir = Split-Path $Path -Parent
  if ($dir) { Ensure-Dir $dir }
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Add-TextFile([string]$Path, [string]$Text) {
  $dir = Split-Path $Path -Parent
  if ($dir) { Ensure-Dir $dir }
  [System.IO.File]::AppendAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# 读文件必须走 ReadAllText：5.1 的 Get-Content -Raw 按 ANSI 解码无 BOM 的 UTF-8，中文会乱码。
function Read-TextFile([string]$Path) {
  if (-not (Test-Path $Path)) { return '' }
  return [System.IO.File]::ReadAllText($Path)
}

function Get-RelPath([string]$Base, [string]$Target) {
  if ([string]::IsNullOrWhiteSpace($Target)) { return '' }
  $b = [System.IO.Path]::GetFullPath($Base).TrimEnd('\', '/')
  $t = [System.IO.Path]::GetFullPath($Target)
  if ($t.StartsWith($b, [StringComparison]::OrdinalIgnoreCase)) {
    return $t.Substring($b.Length).TrimStart('\', '/').Replace('\', '/')
  }
  return $t.Replace('\', '/')
}

function Get-DirSizeMb([string]$Path) {
  if (-not (Test-Path $Path)) { return 0 }
  $bytes = (Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  if (-not $bytes) { return 0 }
  return [int]([Math]::Round($bytes / 1MB, 0))
}

function Resolve-Mutant([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $v = $Value.Trim()
  $leaf = Split-Path $v -Leaf
  foreach ($m in $script:Mutants) {
    if ($m.Id -eq $v) { return $m }
    if ($m.Patch -eq $v) { return $m }
    if ($m.Patch -eq $leaf) { return $m }
    if ($m.Tc -eq $v) { return $m }
    if ((Split-Path $m.Spec -Leaf) -eq $leaf) { return $m }
  }
  return $null
}

function Invoke-Native {
  param([string]$Exe, [string[]]$ArgList, [string]$Cwd)
  # 5.1 在 EAP=Stop 下会把原生命令的 stderr 当作终止错误（NativeCommandError），
  # pnpm / playwright / robocopy 都会写 stderr；这里临时降级，成败只认退出码。
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Push-Location $Cwd
  try {
    $combined = (& $Exe @ArgList 2>&1 | Out-String)
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    return [pscustomobject]@{ ExitCode = [int]$code; Output = [string]$combined }
  } finally {
    Pop-Location
    $ErrorActionPreference = $previous
  }
}

function Invoke-Git([string[]]$GitArgs) {
  return Invoke-Native -Exe 'git' -ArgList $GitArgs -Cwd $RepoRoot
}

function Get-PatchPath($Mutant) {
  return Join-Path $PatchDir $Mutant.Patch
}

function Get-PatchRel($Mutant) {
  return Get-RelPath $RepoRoot (Get-PatchPath $Mutant)
}

function Get-EvidenceRel([string]$MutantId, [string]$Phase) {
  return Get-RelPath $RepoRoot (Join-Path $script:ScratchRoot "$MutantId/$Phase")
}

# 定向构建：按登记表 BuildTargets 推导步骤；任一步非 0 即失败。
function Get-BuildSteps($Mutant) {
  $steps = @()
  if ($Mutant.BuildTargets -contains 'packages') {
    $steps += [pscustomobject]@{
      Name    = 'packages-agent'
      Command = 'pnpm --dir packages/agent build'
      Exe     = 'pnpm'
      ArgList = @('--dir', 'packages/agent', 'build')
    }
  }
  $steps += [pscustomobject]@{
    Name    = 'desktop'
    Command = 'pnpm --dir apps/desktop build'
    Exe     = 'pnpm'
    ArgList = @('--dir', 'apps/desktop', 'build')
  }
  return $steps
}

function Invoke-Build {
  param($Mutant, [string]$PhaseDir, [string]$PhaseLabel)
  $buildLog = Join-Path $PhaseDir 'build.log'
  $steps = @()
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  foreach ($step in Get-BuildSteps $Mutant) {
    $stepStart = [DateTime]::UtcNow
    $r = Invoke-Native -Exe $step.Exe -ArgList $step.ArgList -Cwd $RepoRoot
    $stepMs = ([DateTime]::UtcNow - $stepStart).TotalMilliseconds
    $line = "$ $($step.Command)`nexit=$($r.ExitCode)`n$($r.Output)`n"
    Add-TextFile $buildLog $line
    $steps += [pscustomobject]@{
      Step       = $step.Name
      Command    = $step.Command
      ExitCode   = $r.ExitCode
      DurationMs = [int]$stepMs
    }
    if ($r.ExitCode -ne 0) {
      $sw.Stop()
      return [pscustomobject]@{
        Ok         = $false
        Steps      = $steps
        FailedStep = $step.Name
        TotalMs    = [int]$sw.ElapsedMilliseconds
        BuildLog   = $buildLog
      }
    }
  }
  $sw.Stop()
  return [pscustomobject]@{ Ok = $true; Steps = $steps; FailedStep = $null; TotalMs = [int]$sw.ElapsedMilliseconds; BuildLog = $buildLog }
}

# 跑单条 spec：--reporter=list 关闭 CaseReporter，避免清空/重写既有 report.md/json；
# 证据输出重定向到 scratch 阶段目录。
function Invoke-Spec {
  param($Mutant, [string]$PhaseDir)
  $outDir = Join-Path $PhaseDir 'playwright'
  Ensure-Dir $outDir
  $cmdArgs = @(
    '--dir', 'tools/automated-testing', 'exec', 'playwright', 'test',
    '--reporter=list', "--output=$outDir", $Mutant.Spec
  )
  $r = Invoke-Native -Exe 'pnpm' -ArgList $cmdArgs -Cwd $RepoRoot
  # 报告里的命令按仓库根相对路径记录：换机器 clone 到别的目录后照样能粘贴复跑。
  $relOut = Get-RelPath $RepoRoot $outDir
  $command = "pnpm --dir tools/automated-testing exec playwright test --reporter=list --output=$relOut $($Mutant.Spec)"
  return [pscustomobject]@{ Command = $command; ExitCode = $r.ExitCode; Output = $r.Output }
}

# 分类优先级：env-error > timeout > assertion（命中关键词）> ambiguous。
# 超时优先于关键词：契约 §4.2 明确超时类失败不算有效红，即使错误上下文里带了关键词
# （M4 的 loadFile 缺陷就是 driver 等待超时，error-context 会带标题关键词）。
function Get-Classification([string]$Output, [string[]]$KeywordsHit) {
  if ($Output -match '未取得 electron 锁|网关不可达|gateway|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed|未配置 YXS_LLM|种子库不存在|打包产物不存在|EADDRINUSE|端口被占|driver 启动失败|electron 启动失败') {
    return 'env-error'
  }
  if ($Output -match 'Test timeout of \d+ms exceeded|Timeout \d+ms exceeded|Timed out|TimedOut|等待流式事件超时|TimeoutError') {
    return 'timeout'
  }
  if ($KeywordsHit.Count -gt 0) { return 'assertion' }
  return 'ambiguous'
}

function Find-Keywords($Mutant, [string]$Output) {
  $hit = @()
  foreach ($k in $Mutant.Keywords) {
    if ($Output -and $Output.Contains($k)) { $hit += $k }
  }
  return $hit
}

function Get-Excerpt([string]$Output) {
  if ([string]::IsNullOrWhiteSpace($Output)) { return '' }
  $lines = @($Output -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 })
  $hit = $lines | Where-Object {
    $_ -match 'Error:|AssertionError|expect\(|Expected|Received|没有静默|必须收到|toBe|toContain|toHave|Timeout|超时' -and
    $_ -notmatch '^\s*at\s'
  } | Select-Object -First 1
  if ($null -eq $hit) { $hit = $lines | Select-Object -First 1 }
  if ($null -eq $hit) { return '' }
  $clean = ($hit -replace "`e\[[0-9;]*m", '').Trim()
  return $clean.Substring(0, [Math]::Min(300, $clean.Length))
}

function New-PhaseMeta($Mutant, [string]$Phase, [bool]$LockAcquired, $Extra) {
  $meta = [ordered]@{
    mutant       = $Mutant.Id
    patch        = (Get-PatchRel $Mutant)
    tc           = $Mutant.Tc
    spec         = $Mutant.Spec
    phase        = $Phase
    startedAt    = $(if ($script:PhaseStart) { $script:PhaseStart.ToString('o') } else { [DateTime]::UtcNow.ToString('o') })
    finishedAt   = [DateTime]::UtcNow.ToString('o')
    durationMs   = $null
    lockAcquired = $LockAcquired
    env          = [ordered]@{
      YXS_WORKERS   = $(if ($env:YXS_WORKERS) { $env:YXS_WORKERS } else { '1' })
      YXS_RETRIES   = $(if ($env:YXS_RETRIES) { $env:YXS_RETRIES } else { '0' })
      CI            = $(if ($env:CI) { $env:CI } else { '' })
      host          = "$($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion)"
      isolatedHome  = 'fixture createHome 落系统 tmpdir，脚本不指向真实数据目录'
    }
    build        = $null
  }
  if ($Extra) { foreach ($p in $Extra.PSObject.Properties) { $meta[$p.Name] = $p.Value } }
  return $meta
}

function Save-PhaseEvidence {
  param([string]$Dir, $Meta, [int]$ExitCode, [string]$Output, [string]$Summary)
  Ensure-Dir $Dir
  Write-TextFile (Join-Path $Dir 'stdout.txt') ([string]$Output)
  Write-TextFile (Join-Path $Dir 'exit-code.txt') ("$ExitCode")
  Write-TextFile (Join-Path $Dir 'failure-summary.txt') ([string]$Summary)
  if ([string]::IsNullOrWhiteSpace($Meta.startedAt)) { $Meta.startedAt = [DateTime]::UtcNow.ToString('o') }
  $started = [DateTimeOffset]::Parse($Meta.startedAt)
  $Meta.durationMs = [int]([DateTimeOffset]::UtcNow - $started).TotalMilliseconds
  $Meta.finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
  Write-TextFile (Join-Path $Dir 'meta.json') ($Meta | ConvertTo-Json -Depth 8)
}

# --- .artifacts/index.jsonl 备份/还原（CaseReporter 被 --reporter=list 关闭，仍兜底保护） ---
$script:IndexBackup = $null
function Backup-IndexJsonl {
  if (Test-Path $script:IndexJsonl) {
    $script:IndexBackup = Join-Path $script:ScratchRoot ("index.jsonl.bak." + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))
    Copy-Item $script:IndexJsonl $script:IndexBackup
  }
}
function Restore-IndexJsonl {
  if ($script:IndexBackup -and (Test-Path $script:IndexBackup)) {
    Copy-Item $script:IndexBackup $script:IndexJsonl -Force
    Remove-Item $script:IndexBackup -Force
    $script:IndexBackup = $null
  }
}

# --- M4：打包产物备份 / 恢复 / 种子库 / 重打包 / asar 探针 ---
function Get-M4Paths {
  $unpacked = Join-Path $RepoRoot 'release/win-unpacked'
  return [pscustomobject]@{
    Unpacked     = $unpacked
    Exe          = Join-Path $unpacked '营小商.exe'
    SeedDb       = Join-Path $unpacked 'resources/seed/learning.db'
    Asar         = Join-Path $unpacked 'resources/app.asar'
    Backup       = Join-Path $script:ScratchRoot 'baseline-unpacked'
    DesktopSeed  = Join-Path $RepoRoot 'apps/desktop/seed/learning.db'
    ElectronDist = Join-Path $RepoRoot 'apps/desktop/node_modules/electron/dist'
  }
}

# robocopy 退出码 0-7 成功，>=8 失败；禁止用 $? 或 -ne 0 判成功。
function Invoke-Robocopy {
  param([string]$Src, [string]$Dst, [string]$LogFile)
  $r = Invoke-Native -Exe 'robocopy' -ArgList @($Src, $Dst, '/MIR', '/NFL', '/NDL', '/NP', '/R:2', '/W:2') -Cwd $RepoRoot
  $ok = ($r.ExitCode -ge 0 -and $r.ExitCode -lt 8)
  Add-TextFile $LogFile ("$ robocopy $Src $Dst /MIR`nexit=$($r.ExitCode) ok=$ok`n$($r.Output)`n")
  return [pscustomobject]@{ Ok = $ok; ExitCode = $r.ExitCode; Output = $r.Output }
}

# asar 探针：记录长度/哈希/mtime，并按 mutant 登记的 marker 判断改动是否真的进了包。
# 只比长度或只认某个固定字符串都不够——换锚点就会误判，故用哈希变化 + marker 双条件。
function Get-AsarInfo([string]$AsarPath, [string]$Marker) {
  if (-not (Test-Path $AsarPath)) {
    return [pscustomobject]@{ Exists = $false; Length = 0; Sha256 = ''; LastWriteTime = ''; MarkerPresent = $false }
  }
  $item = Get-Item $AsarPath
  $hash = (Get-FileHash -Path $AsarPath -Algorithm SHA256).Hash
  $markerPresent = $false
  if ($Marker) {
    $text = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($AsarPath))
    $markerPresent = $text.Contains($Marker)
  }
  return [pscustomobject]@{
    Exists        = $true
    Length        = $item.Length
    Sha256        = $hash
    LastWriteTime = $item.LastWriteTime.ToString('o')
    MarkerPresent = $markerPresent
  }
}

function Repackage-M4 {
  param([string]$PhaseDir)
  $p = Get-M4Paths
  $argList = @('--dir', 'apps/desktop', 'exec', 'electron-builder', '--dir', '--publish', 'never')
  $distArg = $null
  if (Test-Path (Join-Path $p.ElectronDist 'electron.exe')) {
    $distArg = "-c.electronDist=$($p.ElectronDist)"
    $argList += $distArg
  }
  $log = Join-Path $PhaseDir 'repackage.log'
  $r = Invoke-Native -Exe 'pnpm' -ArgList $argList -Cwd $RepoRoot
  Add-TextFile $log ("$ pnpm $($argList -join ' ')`nexit=$($r.ExitCode)`n$($r.Output)`n")
  return [pscustomobject]@{ Ok = ($r.ExitCode -eq 0); ExitCode = $r.ExitCode; Output = $r.Output; DistArg = $distArg; Log = $log }
}

# ---------------------------------------------------------------------------
# 基线 31 行索引：dependencies.ts 台账 + 既有 .artifacts/report.json / index.jsonl
# ---------------------------------------------------------------------------
function Get-BaselineIndex {
  $depFile = Join-Path $RepoRoot 'tools/automated-testing/src/scenarios/dependencies.ts'
  $depText = Read-TextFile $depFile
  $tcDeps = [ordered]@{}
  foreach ($m in [regex]::Matches($depText, "'(TC-P\d-\d{2})'\s*:\s*\[(.*?)\]", 'Singleline')) {
    $tc = $m.Groups[1].Value
    $ids = @([regex]::Matches($m.Groups[2].Value, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
    $tcDeps[$tc] = $ids
  }

  $byTc = @{}
  $reportJson = Join-Path $script:ArtifactsRoot 'report.json'
  if (Test-Path $reportJson) {
    try {
      $rep = (Read-TextFile $reportJson) | ConvertFrom-Json
      foreach ($row in $rep.rows) { $byTc[$row.tc] = $row }
    } catch {
      Write-Global "既有 .artifacts/report.json 无法解析，基线索引回落到 meta.json：$($_.Exception.Message)"
    }
  }

  # report.json 只覆盖最近一次 reporter 汇总到的 TC；其余条目回落到既有证据目录的
  # meta.json（同样是 reporter 产物，不另造数据），按目录时间取最新一份。
  $byMeta = @{}
  foreach ($dir in (Get-ChildItem $script:ArtifactsRoot -Directory -ErrorAction SilentlyContinue)) {
    $metaFile = Join-Path $dir.FullName 'meta.json'
    if (-not (Test-Path $metaFile)) { continue }
    try {
      $meta = (Read-TextFile $metaFile) | ConvertFrom-Json
      if (-not $meta.tc) { continue }
      $prev = $byMeta[$meta.tc]
      if (-not $prev -or $dir.LastWriteTime -gt $prev.mtime) {
        $status = $meta.mappedStatus
        if (-not $status) { $status = $meta.status }
        $byMeta[$meta.tc] = [pscustomobject]@{
          title     = [string]$meta.title
          status    = [string]$status
          outputDir = $dir.FullName
          mtime     = $dir.LastWriteTime
        }
      }
    } catch {
      Write-Global "证据目录 meta.json 无法解析，跳过：$metaFile"
    }
  }

  # 标题兜底：spec 首个 test('TC-... 标题') 文本；仍取不到就留空，不臆造。
  $specTitles = @{}
  foreach ($spec in (Get-ChildItem (Join-Path $RepoRoot 'tools/automated-testing/src/scenarios') -Filter '*.spec.ts' -ErrorAction SilentlyContinue)) {
    $text = Read-TextFile $spec.FullName
    $m = [regex]::Match($text, "test\('(TC-P\d-\d{2})\s+(.+?)'")
    if ($m.Success) { $specTitles[$m.Groups[1].Value] = "$($m.Groups[1].Value) $($m.Groups[2].Value)" }
  }

  $artRootFull = [System.IO.Path]::GetFullPath($script:ArtifactsRoot)
  $rows = @()
  foreach ($tc in ($tcDeps.Keys | Sort-Object)) {
    $row = $byTc[$tc]
    $meta = $byMeta[$tc]
    $title = ''
    if ($row -and $row.title) { $title = [string]$row.title }
    elseif ($meta -and $meta.title) { $title = $meta.title }
    elseif ($specTitles[$tc]) { $title = $specTitles[$tc] }

    $evidenceDir = ''
    if ($row -and $row.outputDir) { $evidenceDir = Get-RelPath $artRootFull ([string]$row.outputDir) }
    elseif ($meta -and $meta.outputDir) { $evidenceDir = Get-RelPath $artRootFull $meta.outputDir }
    if ($evidenceDir -and -not $evidenceDir.StartsWith('.artifacts/')) { $evidenceDir = '.artifacts/' + $evidenceDir }

    $baselineStatus = 'unknown'
    if ($row -and $row.mappedStatus) { $baselineStatus = [string]$row.mappedStatus }
    elseif ($meta -and $meta.status) { $baselineStatus = $meta.status }

    $rows += [pscustomobject]@{
      tc             = $tc
      title          = $title
      deps           = @($tcDeps[$tc])
      evidenceDir    = $evidenceDir
      baselineStatus = $baselineStatus
      runRef         = "pnpm --dir tools/automated-testing test -- -g $tc"
    }
  }
  return $rows
}

# ---------------------------------------------------------------------------
# 计划打印（DryRun）
# ---------------------------------------------------------------------------
function Print-Plan($Mutants) {
  Write-Global "repo-root: $RepoRoot"
  Write-Global "patch-dir: $PatchDir"
  Write-Global "report: $script:ReportPath"
  Write-Global "script-version: $script:ScriptVersion"
  foreach ($m in $Mutants) {
    $patch = Get-PatchPath $m
    Write-Host ""
    Write-Phase $m.Id 'PLAN' "patch=$patch"
    Write-Phase $m.Id 'PLAN' "target=$($m.TargetFile):$($m.AnchorLine) tc=$($m.Tc) spec=$($m.Spec)"
    Write-Phase $m.Id 'PLAN' "expected=$($m.Expected) keywords=$($m.Keywords -join ', ')"
    foreach ($step in Get-BuildSteps $m) {
      Write-Phase $m.Id 'PLAN-BUILD' $step.Command
    }
    Write-Phase $m.Id 'APPLY' "git apply --verbose $patch"
    if ($m.IsPackaged) {
      $p = Get-M4Paths
      Write-Phase $m.Id 'PLAN-M4' "备份基线 unpacked: robocopy release\win-unpacked $($p.Backup) /MIR（退出码 0-7 成功）"
      Write-Phase $m.Id 'PLAN-M4' "复制种子库: $($p.SeedDb) -> $($p.DesktopSeed)"
      Write-Phase $m.Id 'PLAN-M4' '重打包: pnpm --dir apps/desktop exec electron-builder --dir --publish never（离线 electronDist 按需追加）'
      Write-Phase $m.Id 'PLAN-M4' "asar 探针: 哈希变化 + marker=$($m.AsarMarker)；改动未进 asar 记 skipped(asar-stale)"
    }
    $redOut = Join-Path $script:ScratchRoot "$($m.Id)/red/playwright"
    Write-Phase $m.Id 'RED-RUN' "pnpm --dir tools/automated-testing exec playwright test --reporter=list --output=$redOut $($m.Spec)"
    Write-Phase $m.Id 'REVERT' "git apply -R --verbose $patch"
    if ($m.IsPackaged) {
      Write-Phase $m.Id 'PLAN-M4' '还原: robocopy 备份基线反向 /MIR 恢复 release\win-unpacked；删除 apps/desktop/seed；成功后删除备份目录'
    }
    $greenOut = Join-Path $script:ScratchRoot "$($m.Id)/green/playwright"
    Write-Phase $m.Id 'GREEN-RUN' "pnpm --dir tools/automated-testing exec playwright test --reporter=list --output=$greenOut $($m.Spec)"
    Write-Phase $m.Id 'STATUS-CHECK' 'git status --porcelain apps/desktop packages'
  }
}

# ---------------------------------------------------------------------------
# 单条闭环
# ---------------------------------------------------------------------------
function Invoke-MutantLoop {
  param($Mutant, [bool]$LockAcquired, $Record)

  $mId = $Mutant.Id
  $preDir = Join-Path $script:ScratchRoot "$mId/pre"
  $redDir = Join-Path $script:ScratchRoot "$mId/red"
  $greenDir = Join-Path $script:ScratchRoot "$mId/green"
  Ensure-Dir $preDir; Ensure-Dir $redDir; Ensure-Dir $greenDir

  $patch = Get-PatchPath $Mutant
  $applied = $false
  $skipGreen = $false
  $m4 = Get-M4Paths
  $m4BackupDone = $false
  $m4BackupMb = 0
  $m4SeedPrepared = $false
  $m4Restored = $false

  # 应用前快照（diff + 目标文件副本），供还原兜底。
  $preSnapshot = Join-Path $preDir 'target-file.bak'
  Copy-Item (Join-Path $RepoRoot $Mutant.TargetFile) $preSnapshot -Force
  $preDiff = Invoke-Git @('diff', '--', 'apps/desktop', 'packages')
  Write-TextFile (Join-Path $preDir 'git-diff-before.txt') ([string]$preDiff.Output)

  try {
    # --- M4 前置：产物存在性 + 备份基线 ---
    if ($Mutant.IsPackaged) {
      if (-not (Test-Path $m4.Exe) -or -not (Test-Path $m4.SeedDb)) {
        $Record.status = 'skipped'
        $Record.notes = "打包产物不存在：$($m4.Exe) 或 $($m4.SeedDb)（先按既有流程完成打包再跑 M4）。"
        Write-Phase $mId 'SKIP' $Record.notes
        return
      }
      if (Test-Path $m4.Backup) {
        # 上一轮残留的备份先清掉，避免把旧基线当成本轮基线。
        Remove-Item -LiteralPath $m4.Backup -Recurse -Force
      }
      Ensure-Dir $m4.Backup
      $bk = Invoke-Robocopy $m4.Unpacked $m4.Backup (Join-Path $preDir 'backup-unpacked.log')
      if (-not $bk.Ok) {
        $Record.status = 'skipped'
        $Record.notes = "release/win-unpacked 备份失败（robocopy exit=$($bk.ExitCode)），不把旧 asar 绿跑当 killed。"
        Write-Phase $mId 'SKIP' $Record.notes
        return
      }
      $m4BackupDone = $true
      $m4BackupMb = Get-DirSizeMb $m4.Backup
      Write-Phase $mId 'PLAN-M4' "基线备份完成：$($m4.Backup)（$m4BackupMb MB）"
    }

    # --- APPLY ---
    $check = Invoke-Git @('apply', '--check', '--verbose', $patch)
    if ($check.ExitCode -ne 0) {
      $Record.status = 'apply-failed'
      $Record.apply = [pscustomobject]@{ Command = "git apply --check --verbose $(Get-PatchRel $Mutant)"; ExitCode = $check.ExitCode; AppliedAt = $null }
      $Record.notes = "patch $($Mutant.Patch) 无法应用：上下文与当前源码不匹配，请先核对锚点行号。`n$($check.Output)"
      Write-Phase $mId 'APPLY' "git apply --check $patch exit=$($check.ExitCode)"
      return
    }
    $apply = Invoke-Git @('apply', '--verbose', $patch)
    $Record.apply = [pscustomobject]@{
      Command   = "git apply --verbose $(Get-PatchRel $Mutant)"
      ExitCode  = $apply.ExitCode
      AppliedAt = [DateTime]::UtcNow.ToString('o')
    }
    Write-Phase $mId 'APPLY' "git apply $patch exit=$($apply.ExitCode)"
    if ($apply.ExitCode -ne 0) {
      $Record.status = 'apply-failed'
      $Record.notes = "git apply 失败：`n$($apply.Output)"
      return
    }
    $applied = $true

    # --- 定向构建（红阶段前） ---
    $script:PhaseStart = [DateTime]::UtcNow
    $buildRed = Invoke-Build $Mutant $redDir 'red'
    $Record.build = [pscustomobject]@{
      red             = $buildRed.Steps
      green           = $null
      totalDurationMs = $buildRed.TotalMs
      repackage       = $null
      unpackedBackup  = $null
    }
    if (-not $buildRed.Ok) {
      $Record.status = 'apply-failed'
      $skipGreen = $true
      $failed = $buildRed.Steps | Where-Object { $_.Step -eq $buildRed.FailedStep } | Select-Object -First 1
      $Record.notes = "定向构建失败：步骤 $($buildRed.FailedStep) 非 0（$($failed.Command)），不跑红/绿例。"
      Write-Phase $mId 'BUILD' "failed step=$($buildRed.FailedStep)"
      return
    }

    # --- M4：种子库就位 -> 重打包 -> asar 探针 ---
    if ($Mutant.IsPackaged) {
      if (-not (Test-Path (Split-Path $m4.DesktopSeed))) { Ensure-Dir (Split-Path $m4.DesktopSeed) }
      Copy-Item $m4.SeedDb $m4.DesktopSeed -Force
      $m4SeedPrepared = $true

      $probeBefore = Get-AsarInfo $m4.Asar $Mutant.AsarMarker
      $repkg = Repackage-M4 $redDir
      $probeAfter = Get-AsarInfo $m4.Asar $Mutant.AsarMarker
      $Record.build.repackage = [pscustomobject]@{
        Command     = 'pnpm --dir apps/desktop exec electron-builder --dir --publish never'
        ExitCode    = $repkg.ExitCode
        DistArg     = $repkg.DistArg
        AsarBefore  = $probeBefore
        AsarAfter   = $probeAfter
        Log         = $repkg.Log
      }
      if (-not $repkg.Ok) {
        $Record.status = 'skipped'
        $skipGreen = $true
        $Record.notes = "M4 重打包失败（electron-builder exit=$($repkg.ExitCode)），重建链不可用，不计 killed。"
        Write-Phase $mId 'SKIP' $Record.notes
        return
      }
      $asarChanged = ($probeAfter.Sha256 -ne $probeBefore.Sha256)
      if (-not $asarChanged -or -not $probeAfter.MarkerPresent) {
        $Record.status = 'skipped'
        $skipGreen = $true
        $Record.notes = "asar-stale：重打包后 asar 哈希变化=$asarChanged、marker($($Mutant.AsarMarker))存在=$($probeAfter.MarkerPresent)，改动未进 app.asar，不跑红例。"
        Write-Phase $mId 'SKIP' $Record.notes
        return
      }
    }

    # --- RED-RUN ---
    $script:PhaseStart = [DateTime]::UtcNow
    $red = Invoke-Spec $Mutant $redDir
    $keywordsHit = Find-Keywords $Mutant $red.Output
    $classification = 'n/a'
    if ($red.ExitCode -ne 0) { $classification = Get-Classification $red.Output $keywordsHit }
    $summary = "exit=$($red.ExitCode) keywords=$($keywordsHit -join ',') classification=$classification`n$(Get-Excerpt $red.Output)"
    Save-PhaseEvidence -Dir $redDir -Meta (New-PhaseMeta $Mutant 'red' $LockAcquired ([pscustomobject]@{
      command = $red.Command; exitCode = $red.ExitCode; keywordsHit = $keywordsHit; classification = $classification; build = $Record.build
    })) -ExitCode $red.ExitCode -Output $red.Output -Summary $summary
    Write-Phase $mId 'RED-RUN' "exit=$($red.ExitCode) keywords=[$($keywordsHit -join ',')] classification=$classification"

    $Record.red = [pscustomobject]@{
      Command        = $red.Command
      ExitCode       = $red.ExitCode
      OutputExcerpt  = Get-Excerpt $red.Output
      KeywordsHit    = $keywordsHit
      Classification = $classification
    }

    if ($red.ExitCode -eq 0) {
      $Record.status = 'survived'
      $Record.notes = 'mutant 存活：用例未变红，覆盖不到这条缺陷。'
      return
    }
    if ($keywordsHit.Count -eq 0 -or $classification -ne 'assertion') {
      $Record.status = 'skipped'
      $Record.notes = "失败原因无法归类为断言失败（classification=$classification，keywords=[$($keywordsHit -join ',')]）：环境错误/超时/未命中登记关键词，不计 killed。"
      if ($classification -eq 'timeout') {
        $Record.notes = "超时类失败（classification=timeout，keywords=[$($keywordsHit -join ',')]）：driver 在 launch / 首窗 / health 任一等候超时，按契约 §4.2 不计 killed，记 skipped。缺的环节是「应用能起窗并暴露 learning.health」，不是断言。"
      }
      return
    }
    $Record.status = 'killed'
  }
  finally {
    # --- REVERT（异常也执行） ---
    if ($applied) {
      $revert = Invoke-Git @('apply', '-R', '--verbose', $patch)
      if ($revert.ExitCode -ne 0) {
        # 重试一次反向 apply；仍失败用预检快照恢复目标文件。
        Start-Sleep -Seconds 1
        $revert = Invoke-Git @('apply', '-R', '--verbose', $patch)
        if ($revert.ExitCode -ne 0 -and (Test-Path $preSnapshot)) {
          Copy-Item $preSnapshot (Join-Path $RepoRoot $Mutant.TargetFile) -Force
          Write-Phase $mId 'REVERT' '反向 apply 失败，已用预检快照恢复目标文件'
        }
        # 契约 §4.3 的逐字消息：还原失败必须显式告警，不能只在报告 notes 里留一句。
        Write-Global '反向还原失败，工作区可能残留改动，请人工核对'
      }
      $Record.revert = [pscustomobject]@{
        Command    = "git apply -R --verbose $(Get-PatchRel $Mutant)"
        ExitCode   = $revert.ExitCode
        RevertedAt = [DateTime]::UtcNow.ToString('o')
      }
      Write-Phase $mId 'REVERT' "git apply -R $patch exit=$($revert.ExitCode)"

      # 还原后定向构建（绿阶段前）
      $script:PhaseStart = [DateTime]::UtcNow
      $buildGreen = Invoke-Build $Mutant $greenDir 'green'
      if ($Record.build) { $Record.build.green = $buildGreen.Steps }
      if (-not $buildGreen.Ok) {
        $skipGreen = $true
        $Record.notes = [string]$Record.notes + "`n还原后定向构建失败：步骤 $($buildGreen.FailedStep) 非 0，跳过绿跑。"
      }

      # M4：恢复基线 unpacked，清理临时种子库与备份
      if ($Mutant.IsPackaged) {
        if ($m4BackupDone) {
          $restore = Invoke-Robocopy $m4.Backup $m4.Unpacked (Join-Path $greenDir 'restore-unpacked.log')
          $m4Restored = $restore.Ok
          if ($restore.Ok) {
            # 备份只在闭环期间需要；恢复成功后删除，避免每轮留 300+ MB 临时目录。
            Remove-Item -LiteralPath $m4.Backup -Recurse -Force -ErrorAction SilentlyContinue
          } else {
            $Record.status = 'skipped'
            $Record.notes = [string]$Record.notes + "`nrelease/win-unpacked 基线恢复失败（robocopy exit=$($restore.ExitCode)），备份保留在 $($m4.Backup)（$m4BackupMb MB），需人工清理。"
          }
          if ($Record.build) {
            $Record.build.unpackedBackup = [pscustomobject]@{
              Path     = $m4.Backup
              SizeMb   = $m4BackupMb
              Restored = $restore.Ok
              Removed  = $restore.Ok
            }
          }
        }
        if ($m4SeedPrepared -and (Test-Path (Split-Path $m4.DesktopSeed))) {
          Remove-Item (Split-Path $m4.DesktopSeed) -Recurse -Force -ErrorAction SilentlyContinue
        }
      }

      # --- GREEN-RUN（构建/打包失败或跳过的条目不跑绿例） ---
      $green = $null
      if (-not $skipGreen) {
        $script:PhaseStart = [DateTime]::UtcNow
        $green = Invoke-Spec $Mutant $greenDir
        $greenSummary = "exit=$($green.ExitCode)`n$(Get-Excerpt $green.Output)"
        Save-PhaseEvidence -Dir $greenDir -Meta (New-PhaseMeta $Mutant 'green' $LockAcquired ([pscustomobject]@{
          command = $green.Command; exitCode = $green.ExitCode; build = $Record.build
        })) -ExitCode $green.ExitCode -Output $green.Output -Summary $greenSummary
        Write-Phase $mId 'GREEN-RUN' "exit=$($green.ExitCode)"
        $Record.green = [pscustomobject]@{ Command = $green.Command; ExitCode = $green.ExitCode; OutputExcerpt = Get-Excerpt $green.Output }
      } else {
        Write-Phase $mId 'GREEN-RUN' 'skipped（前置失败，未跑绿例）'
      }

      # --- STATUS-CHECK ---
      $status = Invoke-Git @('status', '--porcelain', 'apps/desktop', 'packages')
      $clean = [string]::IsNullOrWhiteSpace($status.Output)
      $Record.cleanupCheck = [pscustomobject]@{ Command = 'git status --porcelain apps/desktop packages'; Clean = $clean; Output = $status.Output.TrimEnd() }
      Write-Phase $mId 'STATUS-CHECK' $(if ($clean) { 'clean' } else { "dirty: $($status.Output.Trim())" })

      if ($revert.ExitCode -ne 0 -or -not $clean) {
        $Record.status = 'revert-failed'
        $Record.notes = [string]$Record.notes + "`n反向还原失败或工作区残留改动，请人工核对。"
      } elseif ($green -and $green.ExitCode -ne 0) {
        $Record.status = 'green-failed'
        $Record.notes = [string]$Record.notes + "`n还原后用例仍然失败：可能是还原不彻底，也可能是基线回归，请对比红/绿两份输出。"
      }
    }
  }
}

# ---------------------------------------------------------------------------
# 证据完整性（AC-H-12）
# ---------------------------------------------------------------------------
function Get-EvidenceAudit($Records) {
  $required = @('stdout.txt', 'exit-code.txt', 'failure-summary.txt', 'meta.json')
  $rows = @()
  foreach ($r in $Records) {
    foreach ($phase in @('red', 'green')) {
      $dir = Join-Path $script:ScratchRoot "$($r.id)/$phase"
      $present = @()
      $missing = @()
      foreach ($f in $required) {
        if (Test-Path (Join-Path $dir $f)) { $present += $f } else { $missing += $f }
      }
      $rows += [pscustomobject]@{
        id        = $r.id
        phase     = $phase
        dir       = Get-RelPath $RepoRoot $dir
        present   = ($present -join ', ')
        missing   = ($missing -join ', ')
        complete  = ($missing.Count -eq 0)
      }
    }
  }
  return $rows
}

# ---------------------------------------------------------------------------
# 报告写入
# ---------------------------------------------------------------------------
function Write-Report($Records, [bool]$BaselineClean, [bool]$LockAcquired) {
  $baselineIndex = Get-BaselineIndex
  $branch = ([string]((Invoke-Git @('branch', '--show-current')).Output)).Trim()
  $evidenceAudit = Get-EvidenceAudit $Records
  $drillRows = Get-DrillRows

  $summary = [ordered]@{
    killed       = @($Records | Where-Object { $_.status -eq 'killed' }).Count
    survived     = @($Records | Where-Object { $_.status -eq 'survived' }).Count
    skipped      = @($Records | Where-Object { $_.status -eq 'skipped' }).Count
    applyFailed  = @($Records | Where-Object { $_.status -eq 'apply-failed' }).Count
    revertFailed = @($Records | Where-Object { $_.status -eq 'revert-failed' }).Count
    greenFailed  = @($Records | Where-Object { $_.status -eq 'green-failed' }).Count
  }

  $payload = [ordered]@{
    round               = 'H'
    generatedAt         = (Get-Date).ToString('o')
    repoRoot            = $RepoRoot
    branch              = $branch
    baselineCleanBefore = $BaselineClean
    lockAcquired        = $LockAcquired
    scriptVersion       = $script:ScriptVersion
    powershell          = "$($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion)"
    baselineIndex       = $baselineIndex
    mutations           = $Records
    evidenceAudit       = $evidenceAudit
    drills              = $drillRows
    leftovers           = (Get-LeftoverRows)
    summary             = $summary
  }

  $lines = @()
  $lines += '# H 轮 mutation 报告'
  $lines += ''
  $lines += "- 轮次：H"
  $lines += "- 生成时间：$($payload.generatedAt)"
  $lines += "- 仓库根：$RepoRoot"
  $lines += "- 分支：$branch"
  $lines += "- 应用 patch 前工作区干净：$BaselineClean"
  $lines += "- 取得 Electron 锁：$LockAcquired"
  $lines += "- 脚本版本：$($script:ScriptVersion)（运行宿主 $($payload.powershell)）"
  $lines += "- 证据根目录：``.scratch/run/H/``（相对仓库根，换机器后路径自动跟随）"
  $lines += ''
  $lines += '## 汇总'
  $lines += ''
  $lines += "killed=$($summary.killed) survived=$($summary.survived) skipped=$($summary.skipped) apply-failed=$($summary.applyFailed) revert-failed=$($summary.revertFailed) green-failed=$($summary.greenFailed)"
  $lines += ''
  $lines += '## Mutant 记录'
  $lines += ''
  $lines += '| ID | patch | 目标 | TC | 预期 | 状态 | 红退出码 | 命中关键词 | 分类 | 绿退出码 | 证据目录（红 / 绿） | 备注 |'
  $lines += '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  foreach ($r in $Records) {
    $redExit = '-'
    if ($r.red) { $redExit = $r.red.ExitCode }
    $greenExit = '-'
    if ($r.green) { $greenExit = $r.green.ExitCode }
    $kw = ''
    $cls = ''
    if ($r.red) {
      $kw = $r.red.KeywordsHit -join ', '
      $cls = $r.red.Classification
    }
    $expected = ''
    $mutant = Resolve-Mutant $r.id
    if ($mutant) { $expected = $mutant.Expected }
    $notes = ([string]$r.notes) -replace "\r?\n", ' / '
    $notes = $notes.Replace('|', '/')
    $evidence = "$(Get-EvidenceRel $r.id 'red') / $(Get-EvidenceRel $r.id 'green')"
    $lines += "| $($r.id) | $($r.patch) | $($r.targetFile):$($r.anchorLine) | $($r.targetCase.tc) | $expected | $($r.status) | $redExit | $kw | $cls | $greenExit | $evidence | $notes |"
  }
  $lines += ''
  $lines += '## 证据完整性（AC-H-12）'
  $lines += ''
  $lines += '| ID | 阶段 | 证据目录 | 已存在 | 缺失 |'
  $lines += '| --- | --- | --- | --- | --- |'
  foreach ($e in $evidenceAudit) {
    $missingText = $e.missing
    if ($e.complete) { $missingText = '—' }
    $lines += "| $($e.id) | $($e.phase) | ``$($e.dir)`` | $($e.present) | $missingText |"
  }
  $lines += ''
  $lines += '## AC 演练记录（AC-H-09 / H-11 / H-13 / H-14）'
  $lines += ''
  if ($drillRows.Count -eq 0) {
    $lines += '尚未跑演练。复跑：`powershell tools/automated-testing/scripts/run-mutation.ps1 -Drill all`。'
  } else {
    $lines += '| 演练 | AC | 结果 | 退出码 | 检查项 | 证据目录 |'
    $lines += '| --- | --- | --- | --- | --- | --- |'
    foreach ($d in $drillRows) {
      $result = '未通过'
      if ($d.passed) { $result = '通过' }
      $checks = @($d.checks | ForEach-Object { "$($_.name)=$($_.actual)" }) -join '; '
      $checks = $checks.Replace('|', '/')
      $lines += "| $($d.name) | $($d.ac) | $result | $($d.exitCode) | $checks | ``$($d.evidence)`` |"
    }
  }
  $lines += ''
  $lines += '## 残留与清理'
  $lines += ''
  $leftovers = Get-LeftoverRows
  if ($leftovers.Count -eq 0) {
    $lines += '本轮无残留目录：M4 基线备份在恢复成功后已删除，锁目录已释放。'
  } else {
    $lines += '| 路径 | 大小(MB) | 处理 |'
    $lines += '| --- | --- | --- |'
    foreach ($l in $leftovers) {
      $lines += "| ``$($l.path)`` | $($l.sizeMb) | $($l.action) |"
    }
  }
  $lines += ''
  $lines += '## 基线索引（31 行）'
  $lines += ''
  $lines += '| TC | 标题 | 依赖 ID | 证据目录 | 基线状态 | 复跑命令 |'
  $lines += '| --- | --- | --- | --- | --- | --- |'
  foreach ($b in $baselineIndex) {
    $title = ([string]$b.title).Replace('|', '/')
    $lines += "| $($b.tc) | $title | $($b.deps -join ', ') | $($b.evidenceDir) | $($b.baselineStatus) | $($b.runRef) |"
  }
  $basePassed = @($baselineIndex | Where-Object { $_.baselineStatus -eq 'passed' }).Count
  $baseFailed = @($baselineIndex | Where-Object { $_.baselineStatus -eq 'failed' }).Count
  $baseUnknown = @($baselineIndex | Where-Object { $_.baselineStatus -eq 'unknown' }).Count
  $lines += ''
  $lines += "基线索引状态取自既有 ``.artifacts/`` reporter 证据；本轮未重跑非目标用例。passed=$basePassed failed=$baseFailed unknown=$baseUnknown。"
  $lines += ''
  $lines += '## 结构化 payload'
  $lines += ''
  $lines += '```json'
  $lines += ($payload | ConvertTo-Json -Depth 10)
  $lines += '```'
  $lines += ''

  Write-TextFile $script:ReportPath ($lines -join "`n")
}

function Get-LeftoverRows {
  $rows = @()
  $m4 = Get-M4Paths
  if (Test-Path $m4.Backup) {
    $rows += [pscustomobject]@{
      path   = (Get-RelPath $RepoRoot $m4.Backup)
      sizeMb = (Get-DirSizeMb $m4.Backup)
      action = '保留（上一轮恢复失败或未跑 M4）；确认 release/win-unpacked 完好后可人工删除'
    }
  }
  if (Test-Path $script:LockDir) {
    $rows += [pscustomobject]@{
      path   = (Get-RelPath $RepoRoot $script:LockDir)
      sizeMb = 0
      action = '锁目录残留：确认无 Electron 进程后人工删除'
    }
  }
  return $rows
}

function Get-DrillRows {
  $rows = @()
  if (-not (Test-Path $script:DrillRoot)) { return $rows }
  foreach ($dir in (Get-ChildItem $script:DrillRoot -Directory -ErrorAction SilentlyContinue)) {
    $file = Join-Path $dir.FullName 'result.json'
    if (-not (Test-Path $file)) { continue }
    try {
      $d = (Read-TextFile $file) | ConvertFrom-Json
      $rows += [pscustomobject]@{
        name     = [string]$d.name
        ac       = [string]$d.ac
        passed   = [bool]$d.passed
        exitCode = [int]$d.exitCode
        checks   = @($d.checks)
        evidence = (Get-RelPath $RepoRoot $dir.FullName)
      }
    } catch {
      Write-Global "演练结果无法解析，跳过：$file"
    }
  }
  return $rows
}

# ---------------------------------------------------------------------------
# AC 演练（AC-H-09 锁跳过 / AC-H-11 DryRun / AC-H-13 还原失败 / AC-H-14 隔离核对）
# ---------------------------------------------------------------------------
function Invoke-SelfScript {
  param([string[]]$ArgList, [string]$Cwd)
  $psiArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath) + $ArgList
  return Invoke-Native -Exe 'powershell' -ArgList $psiArgs -Cwd $Cwd
}

function New-DrillResult {
  param([string]$Name, [string]$Ac, [string]$Dir)
  Ensure-Dir $Dir
  return [pscustomobject]@{
    name      = $Name
    ac        = $Ac
    dir       = $Dir
    startedAt = [DateTime]::UtcNow.ToString('o')
    checks    = @()
    stdout    = ''
  }
}

function Add-DrillCheck {
  param($Result, [string]$Name, $Expected, $Actual, [bool]$Ok)
  $Result.checks += [pscustomobject]@{ name = $Name; expected = [string]$Expected; actual = [string]$Actual; ok = $Ok }
}

function Save-DrillResult {
  param($Result, [int]$ExitCode)
  $passed = @($Result.checks | Where-Object { -not $_.ok }).Count -eq 0
  Write-TextFile (Join-Path $Result.dir 'stdout.txt') ([string]$Result.stdout)
  $payload = [ordered]@{
    name      = $Result.name
    ac        = $Result.ac
    passed    = $passed
    exitCode  = $ExitCode
    startedAt = $Result.startedAt
    finishedAt = [DateTime]::UtcNow.ToString('o')
    checks    = @($Result.checks)
  }
  Write-TextFile (Join-Path $Result.dir 'result.json') ($payload | ConvertTo-Json -Depth 6)
  Write-Global "drill $($Result.name)：$(if ($passed) { '通过' } else { '未通过' })（退出码 $ExitCode）"
  foreach ($c in $Result.checks) {
    $mark = 'ok'
    if (-not $c.ok) { $mark = 'FAIL' }
    Write-Host "  [$mark] $($c.name)：期望 $($c.expected)，实际 $($c.actual)"
  }
  if ($passed) { return 0 }
  return 5
}

function Get-StatusPorcelain {
  return ([string]((Invoke-Git @('status', '--porcelain', 'apps/desktop', 'packages')).Output)).Trim()
}

function Invoke-DrillDryRun {
  $dir = Join-Path $script:DrillRoot 'dryrun'
  $r = New-DrillResult 'dryrun' 'AC-H-11' $dir
  $beforeLock = Test-Path $script:LockDir
  $beforeDirs = @(Get-ChildItem $script:ScratchRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  $child = Invoke-SelfScript -ArgList @('-All', '-DryRun', '-RepoRoot', $RepoRoot) -Cwd $RepoRoot
  $r.stdout = $child.Output
  Add-DrillCheck $r '退出码' '0' $child.ExitCode ($child.ExitCode -eq 0)
  Add-DrillCheck $r '打印 M3 契约锚点' 'target=packages/agent/src/team.ts:157' ($child.Output.Contains('target=packages/agent/src/team.ts:157')) ($child.Output.Contains('target=packages/agent/src/team.ts:157'))
  Add-DrillCheck $r '打印 M4 契约锚点' 'target=apps/desktop/src/main/index.ts:157' ($child.Output.Contains('target=apps/desktop/src/main/index.ts:157')) ($child.Output.Contains('target=apps/desktop/src/main/index.ts:157'))
  Add-DrillCheck $r '未创建锁目录' "$beforeLock" (Test-Path $script:LockDir) ((Test-Path $script:LockDir) -eq $beforeLock)
  $afterDirs = @(Get-ChildItem $script:ScratchRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  $newDirs = @($afterDirs | Where-Object { $beforeDirs -notcontains $_ -and $_ -ne 'drills' })
  Add-DrillCheck $r '未新建证据目录' '0' $newDirs.Count ($newDirs.Count -eq 0)
  $porcelain = Get-StatusPorcelain
  Add-DrillCheck $r '工作区干净' 'empty' $(if ($porcelain) { $porcelain } else { 'empty' }) ([string]::IsNullOrWhiteSpace($porcelain))
  return Save-DrillResult $r $child.ExitCode
}

function Invoke-DrillLock {
  $dir = Join-Path $script:DrillRoot 'lock'
  $r = New-DrillResult 'lock' 'AC-H-09' $dir
  if (Test-Path $script:LockDir) {
    Add-DrillCheck $r '演练前置：锁目录未被占用' 'absent' 'present' $false
    return Save-DrillResult $r 5
  }
  Ensure-Dir $script:LockDir
  Write-TextFile (Join-Path $script:LockDir 'holder.txt') ("drill=AC-H-09`nstartedAt=$([DateTime]::UtcNow.ToString('o'))`npid=$PID")
  $childReport = Join-Path $dir 'report.md'
  try {
    $child = Invoke-SelfScript -ArgList @('-Case', 'M5', '-RepoRoot', $RepoRoot, '-ReportPath', $childReport) -Cwd $RepoRoot
  } finally {
    if (Test-Path $script:LockDir) { Remove-Item -LiteralPath $script:LockDir -Recurse -Force }
  }
  $r.stdout = $child.Output
  Add-DrillCheck $r '退出码' '2' $child.ExitCode ($child.ExitCode -eq 2)
  Add-DrillCheck $r 'stdout 含中文原因' '未取得 electron 锁' ($child.Output.Contains('未取得 electron 锁')) ($child.Output.Contains('未取得 electron 锁'))
  $reportText = Read-TextFile $childReport
  Add-DrillCheck $r '报告 lockAcquired=false' 'False' ($reportText -match '取得 Electron 锁：False') ($reportText -match '取得 Electron 锁：False')
  Add-DrillCheck $r '报告 M5 记 skipped' 'skipped' ($reportText -match '\| M5 \|.*\| skipped \|') ($reportText -match '\| M5 \|.*\| skipped \|')
  $porcelain = Get-StatusPorcelain
  Add-DrillCheck $r '工作区干净' 'empty' $(if ($porcelain) { $porcelain } else { 'empty' }) ([string]::IsNullOrWhiteSpace($porcelain))
  return Save-DrillResult $r $child.ExitCode
}

function Invoke-DrillRevert {
  $dir = Join-Path $script:DrillRoot 'revert'
  $r = New-DrillResult 'revert' 'AC-H-13' $dir
  $mutant = Resolve-Mutant 'M5'
  $target = Join-Path $RepoRoot $mutant.TargetFile
  $pristine = Read-TextFile $target
  if ((Get-StatusPorcelain) -ne '') {
    Add-DrillCheck $r '演练前置：工作区干净' 'empty' 'dirty' $false
    return Save-DrillResult $r 5
  }

  # 看门狗：等 patch 落地后把 mutant 那一行改成别的文本，让反向 apply 的 hunk 上下文失配，
  # 从而真实演练「重试 -> 快照恢复 -> 退 4」这条兜底链。
  # 注意：必须改 hunk 覆盖的那一行本身；在文件末尾追加注释不会影响 hunk 上下文，
  # 反向 apply 照样成功，演练就假通过了。
  # 判据用 mutant 独有的片段（`  return 'markdown'` 这一整行替换了原来的三元表达式，
  # 该片段在未变异的文件里不存在），不带换行符——目标文件可能是 CRLF，带 `\n` 会匹配不上。
  # 不能用 `'retry'` 做否定条件——类型声明行 `'markdown' | 'retry'` 里就有它，会立刻误触发。
  $watchdog = Join-Path $dir 'watchdog.ps1'
  Write-TextFile $watchdog @'
param([string]$TargetFile, [string]$Marker, [string]$Replacement)
$deadline = (Get-Date).AddMinutes(10)
while ((Get-Date) -lt $deadline) {
  if (Test-Path $TargetFile) {
    $text = [System.IO.File]::ReadAllText($TargetFile)
    if ($text.Contains($Marker)) {
      $mutated = $text.Replace($Marker, $Replacement)
      [System.IO.File]::WriteAllText($TargetFile, $mutated, (New-Object System.Text.UTF8Encoding($false)))
      exit 0
    }
  }
  Start-Sleep -Milliseconds 250
}
exit 1
'@
  $watchArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -TargetFile "{1}" -Marker "{2}" -Replacement "{3}"' -f `
    $watchdog, $target, "  return 'markdown'", "  return 'markdown' // drill-revert"
  $proc = Start-Process -FilePath 'powershell' -ArgumentList $watchArgs -PassThru -WindowStyle Hidden
  $childReport = Join-Path $dir 'report.md'
  try {
    $child = Invoke-SelfScript -ArgList @('-Case', 'M5', '-RepoRoot', $RepoRoot, '-ReportPath', $childReport) -Cwd $RepoRoot
    [void]$proc.WaitForExit(60000)
  } finally {
    if (-not $proc.HasExited) { $proc.Kill() }
    # 兜底：演练自己也要把目标文件还原成演练前内容，绝不留脏。
    if ((Read-TextFile $target) -ne $pristine) { Write-TextFile $target $pristine }
  }
  $r.stdout = $child.Output
  Add-DrillCheck $r '退出码' '4' $child.ExitCode ($child.ExitCode -eq 4)
  Add-DrillCheck $r 'stdout 含中文提示' '反向还原失败' ($child.Output.Contains('反向还原失败')) ($child.Output.Contains('反向还原失败'))
  $reportText = Read-TextFile $childReport
  Add-DrillCheck $r '报告 M5 记 revert-failed' 'revert-failed' ($reportText -match '\| M5 \|.*\| revert-failed \|') ($reportText -match '\| M5 \|.*\| revert-failed \|')
  Add-DrillCheck $r '看门狗确实注入过外部改动' '1' $proc.ExitCode ($proc.ExitCode -eq 0)
  Add-DrillCheck $r '目标文件已恢复演练前内容' 'identical' ((Read-TextFile $target) -eq $pristine) ((Read-TextFile $target) -eq $pristine)
  $porcelain = Get-StatusPorcelain
  Add-DrillCheck $r '工作区干净' 'empty' $(if ($porcelain) { $porcelain } else { 'empty' }) ([string]::IsNullOrWhiteSpace($porcelain))
  return Save-DrillResult $r $child.ExitCode
}

function Invoke-DrillIsolation {
  $dir = Join-Path $script:DrillRoot 'isolation'
  $r = New-DrillResult 'isolation' 'AC-H-14' $dir
  $metas = @(Get-ChildItem $script:ScratchRoot -Recurse -Filter 'meta.json' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notlike "*$($script:DrillRoot)*" })
  Add-DrillCheck $r '存在阶段 meta.json' '>0' $metas.Count ($metas.Count -gt 0)
  $badWorkers = @()
  $badRetries = @()
  $badDuration = @()
  $realPaths = @()
  $legacy = 0
  foreach ($f in $metas) {
    try {
      $meta = (Read-TextFile $f.FullName) | ConvertFrom-Json
    } catch {
      $badDuration += $f.FullName
      continue
    }
    # 旧版脚本（1.0.x）写的 meta.json 没有 env 字段，也缺 finishedAt/durationMs。
    # 那些是历史证据，不在本轮隔离口径的校验范围内；这里只统计本轮格式的证据。
    if (-not $meta.env) { $legacy++; continue }
    if ([string]$meta.env.YXS_WORKERS -ne '1') { $badWorkers += $f.FullName }
    if ([string]$meta.env.YXS_RETRIES -ne '0') { $badRetries += $f.FullName }
    if (-not $meta.startedAt -or -not $meta.finishedAt) { $badDuration += $f.FullName }
    $text = Read-TextFile $f.FullName
    if ($text -match 'AppData\\Roaming' -or $text -match '\.learning-agent') { $realPaths += $f.FullName }
  }
  $current = $metas.Count - $legacy
  Add-DrillCheck $r '本轮格式 meta.json 数量' '>0' $current ($current -gt 0)
  Add-DrillCheck $r '全部 YXS_WORKERS=1' '0 例外' $badWorkers.Count ($badWorkers.Count -eq 0)
  Add-DrillCheck $r '全部 YXS_RETRIES=0' '0 例外' $badRetries.Count ($badRetries.Count -eq 0)
  Add-DrillCheck $r 'meta 含起止时间戳' '0 例外' $badDuration.Count ($badDuration.Count -eq 0)
  Add-DrillCheck $r 'meta 未指向真实数据目录' '0 例外' $realPaths.Count ($realPaths.Count -eq 0)

  $configText = Read-TextFile (Join-Path $RepoRoot 'tools/automated-testing/playwright.config.ts')
  Add-DrillCheck $r '用例超时 180000' '180_000' ($configText -match 'timeout:\s*180_000') ($configText -match 'timeout:\s*180_000')
  Add-DrillCheck $r '并发取自 YXS_WORKERS' 'process.env.YXS_WORKERS' ($configText -match "process\.env\.YXS_WORKERS") ($configText -match "process\.env\.YXS_WORKERS")
  Add-DrillCheck $r '重试取自 YXS_RETRIES' 'process.env.YXS_RETRIES' ($configText -match "process\.env\.YXS_RETRIES") ($configText -match "process\.env\.YXS_RETRIES")

  # H 自己的临时 home 必须落在系统 tmpdir；这里只检查残留进程不指向真实目录（用户自己开的窗口不计）。
  $ours = @()
  try {
    $tmp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $ours = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $_.CommandLine -and $_.CommandLine.Contains($tmp) -and $_.Name -like '*electron*'
    })
  } catch {
    Add-DrillCheck $r '枚举进程' 'available' $_.Exception.Message $false
  }
  Add-DrillCheck $r '无残留 H 临时 home 进程' '0' $ours.Count ($ours.Count -eq 0)
  $r.stdout = "metas=$($metas.Count) badWorkers=$($badWorkers.Count) badRetries=$($badRetries.Count) realPaths=$($realPaths.Count) ourProcesses=$($ours.Count)"
  return Save-DrillResult $r 0
}

function Invoke-Drills([string]$Name) {
  $results = @()
  if ($Name -eq 'dryrun' -or $Name -eq 'all') { $results += Invoke-DrillDryRun }
  if ($Name -eq 'lock' -or $Name -eq 'all') { $results += Invoke-DrillLock }
  if ($Name -eq 'revert' -or $Name -eq 'all') { $results += Invoke-DrillRevert }
  if ($Name -eq 'isolation' -or $Name -eq 'all') { $results += Invoke-DrillIsolation }
  $failed = @($results | Where-Object { $_ -ne 0 }).Count
  if ($failed -gt 0) { return 5 }
  return 0
}

# ---------------------------------------------------------------------------
# 参数校验
# ---------------------------------------------------------------------------
$usage = @(
  '用法（Windows PowerShell 5.1 与 PowerShell 7 均可，本机只需 powershell.exe）：',
  '  powershell -NoProfile -ExecutionPolicy Bypass -File tools/automated-testing/scripts/run-mutation.ps1 -All [-DryRun]',
  '  powershell -NoProfile -ExecutionPolicy Bypass -File tools/automated-testing/scripts/run-mutation.ps1 -Case <TC 编号 | spec 文件名 | M1..M5> [-DryRun]',
  '  powershell -NoProfile -ExecutionPolicy Bypass -File tools/automated-testing/scripts/run-mutation.ps1 -Apply <M1..M5 | patch 文件名>',
  '  powershell -NoProfile -ExecutionPolicy Bypass -File tools/automated-testing/scripts/run-mutation.ps1 -Revert <M1..M5 | patch 文件名>',
  '  powershell -NoProfile -ExecutionPolicy Bypass -File tools/automated-testing/scripts/run-mutation.ps1 -Drill <dryrun|lock|revert|isolation|all>',
  '  powershell -NoProfile -ExecutionPolicy Bypass -File tools/automated-testing/scripts/run-mutation.ps1 -RefreshReport（按当前 .artifacts 证据刷新 31 行基线索引，不跑测）',
  '参数：-PatchDir <dir>（默认 tools/automated-testing/mutations）；-ReportPath <file>（默认 tools/automated-testing/mutation-report.md）；-RepoRoot <path>（默认脚本向上定位 .git）'
)

if ($RefreshReport -and ($Apply -or $Revert -or $Case -or $All -or $DryRun -or $Drill)) {
  Write-Global '-RefreshReport 与其他操作互斥。'
  exit 3
}
if ($Drill -and ($Apply -or $Revert -or $Case -or $All -or $DryRun -or $RefreshReport)) {
  Write-Global '-Drill 与其他操作互斥，不能同时使用。'
  exit 3
}
if ($Apply -and $Revert) {
  Write-Global '-Apply 与 -Revert 互斥，不能同时使用。'
  $usage | ForEach-Object { Write-Host $_ }
  exit 3
}
if ($All -and $Case) {
  Write-Global '-All 与 -Case 互斥，不能同时使用。'
  $usage | ForEach-Object { Write-Host $_ }
  exit 3
}

# --- -Drill：演练验收项，不碰正式报告 ---
if ($Drill) {
  exit (Invoke-Drills $Drill)
}

# --- -RefreshReport：只重算 31 行基线索引，复用报告里已记录的 5 条闭环，不跑测 ---
if ($RefreshReport) {
  if (-not (Test-Path $script:ReportPath)) {
    Write-Global "报告不存在：$($script:ReportPath)"
    exit 2
  }
  $txt = Read-TextFile $script:ReportPath
  $m = [regex]::Match($txt, '(?s)```json\s*(?<json>\{.*?\})\s*```')
  if (-not $m.Success) {
    Write-Global '报告里找不到结构化 payload，无法刷新。'
    exit 3
  }
  $payload = $m.Groups['json'].Value | ConvertFrom-Json
  Write-Report -Records @($payload.mutations) -BaselineClean ([bool]$payload.baselineCleanBefore) -LockAcquired ([bool]$payload.lockAcquired)
  Write-Global "报告已刷新：$($script:ReportPath)"
  exit 0
}

if (-not $Apply -and -not $Revert -and -not $Case -and -not $All) {
  $usage | ForEach-Object { Write-Host $_ }
  exit 3
}
if (-not (Test-Path $PatchDir)) {
  Write-Global "patch 目录不存在：$PatchDir"
  exit 3
}

# 解析选中 mutant
$selected = @()
if ($All) {
  $selected = @($script:Mutants)
} elseif ($Case) {
  $m = Resolve-Mutant $Case
  if (-not $m) { Write-Global "未识别的 -Case 取值：$Case（可用：$($script:Mutants.Id -join ', ')）"; exit 3 }
  $selected = @($m)
} elseif ($Apply) {
  $m = Resolve-Mutant $Apply
  if (-not $m) { Write-Global "未识别的 -Apply 取值：$Apply"; exit 3 }
  $selected = @($m)
} elseif ($Revert) {
  $m = Resolve-Mutant $Revert
  if (-not $m) { Write-Global "未识别的 -Revert 取值：$Revert"; exit 3 }
  $selected = @($m)
}

foreach ($m in $selected) {
  if (-not (Test-Path (Get-PatchPath $m))) {
    Write-Global "patch 文件不存在：$(Get-PatchPath $m)"
    exit 3
  }
}

# --- DryRun：只打印计划，不取锁、不建证据目录、不 apply、不 build、不跑测、不写报告 ---
if ($DryRun) {
  Print-Plan $selected
  exit 0
}

# ---------------------------------------------------------------------------
# 单边：-Apply / -Revert（不跑测、不写报告；各 build 一次）
# ---------------------------------------------------------------------------
if ($Apply) {
  $m = $selected[0]
  $patch = Get-PatchPath $m
  $precheck = Invoke-Git @('status', '--porcelain', 'apps/desktop', 'packages')
  if (-not [string]::IsNullOrWhiteSpace($precheck.Output)) {
    Write-Global '应用 patch 前工作区不干净，中止'
    Write-Global $precheck.Output.Trim()
    exit 4
  }
  $check = Invoke-Git @('apply', '--check', '--verbose', $patch)
  if ($check.ExitCode -ne 0) {
    Write-Phase $m.Id 'APPLY' "git apply --check exit=$($check.ExitCode)"
    exit 3
  }
  $apply = Invoke-Git @('apply', '--verbose', $patch)
  Write-Phase $m.Id 'APPLY' "git apply $patch exit=$($apply.ExitCode)"
  if ($apply.ExitCode -ne 0) { exit 3 }
  $buildDir = Join-Path $script:ScratchRoot "$($m.Id)/apply-build"
  Ensure-Dir $buildDir
  $build = Invoke-Build $m $buildDir 'apply-build'
  if (-not $build.Ok) {
    Write-Phase $m.Id 'BUILD' "failed step=$($build.FailedStep)"
    exit 3
  }
  exit 0
}

if ($Revert) {
  $m = $selected[0]
  $patch = Get-PatchPath $m
  $check = Invoke-Git @('apply', '-R', '--check', '--verbose', $patch)
  if ($check.ExitCode -ne 0) {
    Write-Phase $m.Id 'REVERT' '无已应用记录可还原（反向 check 未通过），退出码 0。'
    exit 0
  }
  $revert = Invoke-Git @('apply', '-R', '--verbose', $patch)
  Write-Phase $m.Id 'REVERT' "git apply -R $patch exit=$($revert.ExitCode)"
  if ($revert.ExitCode -ne 0) {
    Write-Global '反向还原失败，工作区可能残留改动，请人工核对'
    exit 4
  }
  $buildDir = Join-Path $script:ScratchRoot "$($m.Id)/revert-build"
  Ensure-Dir $buildDir
  $build = Invoke-Build $m $buildDir 'revert-build'
  if (-not $build.Ok) {
    Write-Phase $m.Id 'BUILD' "failed step=$($build.FailedStep)"
    exit 3
  }
  exit 0
}

# ---------------------------------------------------------------------------
# 完整闭环
# ---------------------------------------------------------------------------
# PRECHECK
$precheck = Invoke-Git @('status', '--porcelain', 'apps/desktop', 'packages')
$baselineClean = [string]::IsNullOrWhiteSpace($precheck.Output)
if (-not $baselineClean) {
  Write-Global '应用 patch 前工作区不干净，中止'
  Write-Global $precheck.Output.Trim()
  exit 4
}
Write-Phase 'H' 'PRECHECK' 'git status --porcelain apps/desktop packages -> clean'

Ensure-Dir $script:ScratchRoot
Backup-IndexJsonl

$lockAcquired = $false
$records = @()
$overallExit = 0

try {
  # LOCK：目录锁，2s 退避共 30s（必须先取锁，再做基线跑与 patch/构建，避免与并行轮的 Electron 目标冲突）。
  $lockAcquired = $false
  $deadline = (Get-Date).AddSeconds(30)
  while (-not $lockAcquired) {
    try {
      New-Item -ItemType Directory -Path $script:LockDir -ErrorAction Stop | Out-Null
      $lockAcquired = $true
    } catch {
      if ((Get-Date) -ge $deadline) { break }
      Start-Sleep -Seconds 2
    }
  }
  if (-not $lockAcquired) {
    Write-Global '未取得 electron 锁，本轮 electron 目标未执行'
    foreach ($m in $selected) {
      $records += [pscustomobject]@{
        id            = $m.Id
        patch         = (Get-PatchRel $m)
        targetFile    = $m.TargetFile
        anchorLine    = $m.AnchorLine
        defectSummary = $m.DefectSummary
        targetCase    = [pscustomobject]@{ tc = $m.Tc; spec = $m.Spec }
        status        = 'skipped'
        apply         = $null
        red           = $null
        revert        = $null
        green         = $null
        cleanupCheck  = $null
        build         = $null
        notes         = '未取得 electron 锁，本轮 electron 目标未执行。'
      }
    }
    $overallExit = 2
    throw [System.Exception]::new('lock-skip')
  }
  Write-TextFile (Join-Path $script:LockDir 'holder.txt') ("script=$PSCommandPath`nstartedAt=$([DateTime]::UtcNow.ToString('o'))`npid=$PID")
  Write-Global 'lock: acquired'

  # 基线跑（持锁）：未打 patch 先跑目标 spec，非 0 -> baseline-red，退出 2，不进故障阶段。
  $baselineDir = Join-Path $script:ScratchRoot 'baseline'
  Ensure-Dir $baselineDir
  $baselineFailedTc = $null
  foreach ($m in $selected) {
    $mBaseDir = Join-Path $baselineDir $m.Id
    Ensure-Dir $mBaseDir
    $script:PhaseStart = [DateTime]::UtcNow
    $base = Invoke-Spec $m $mBaseDir
    $summary = "baseline exit=$($base.ExitCode)`n$(Get-Excerpt $base.Output)"
    Save-PhaseEvidence -Dir $mBaseDir -Meta (New-PhaseMeta $m 'baseline' $true ([pscustomobject]@{ command = $base.Command; exitCode = $base.ExitCode })) -ExitCode $base.ExitCode -Output $base.Output -Summary $summary
    Write-Phase $m.Id 'BASELINE' "exit=$($base.ExitCode)"
    if ($base.ExitCode -ne 0) {
      Write-Global "基线用例 $($m.Tc) 在未打 patch 时已失败，请先修复基线再跑 mutation。"
      $baselineFailedTc = $m.Tc
      $overallExit = 2
      throw [System.Exception]::new('baseline-red')
    }
  }

  # 逐条闭环
  foreach ($m in $selected) {
    $record = [ordered]@{
      id            = $m.Id
      patch         = (Get-PatchRel $m)
      targetFile    = $m.TargetFile
      anchorLine    = $m.AnchorLine
      defectSummary = $m.DefectSummary
      targetCase    = [pscustomobject]@{ tc = $m.Tc; spec = $m.Spec }
      status        = 'skipped'
      apply         = $null
      red           = $null
      revert        = $null
      green         = $null
      cleanupCheck  = $null
      build         = $null
      notes         = $m.Notes
    }
    try {
      Invoke-MutantLoop -Mutant $m -LockAcquired $lockAcquired -Record $record
    } catch {
      $record.status = 'skipped'
      $record.notes = [string]$record.notes + "`n闭环异常：$($_.Exception.Message)"
    }
    $records += [pscustomobject]$record
  }
} catch {
  if ($overallExit -eq 0) { $overallExit = 2 }
  if ($records.Count -eq 0) {
    $reason = '闭环在进入故障阶段前中止：' + $_.Exception.Message
    if ($baselineFailedTc) { $reason = "baseline-red：基线用例 $baselineFailedTc 未打 patch 即失败，本轮不进故障阶段。" }
    foreach ($m in $selected) {
      $records += [pscustomobject]@{
        id            = $m.Id
        patch         = (Get-PatchRel $m)
        targetFile    = $m.TargetFile
        anchorLine    = $m.AnchorLine
        defectSummary = $m.DefectSummary
        targetCase    = [pscustomobject]@{ tc = $m.Tc; spec = $m.Spec }
        status        = 'skipped'
        apply         = $null
        red           = $null
        revert        = $null
        green         = $null
        cleanupCheck  = $null
        build         = $null
        notes         = $reason
      }
    }
  }
} finally {
  if ($lockAcquired -and (Test-Path $script:LockDir)) {
    Remove-Item -LiteralPath $script:LockDir -Recurse -Force
    Write-Global 'lock: released'
  }
  Restore-IndexJsonl
}

# 写报告（DryRun 之外的完整闭环才写）
if ($records.Count -gt 0) {
  Write-Report -Records $records -BaselineClean $baselineClean -LockAcquired $lockAcquired
}

# 汇总与退出码优先级 4 > 5 > 3 > 2 > 1 > 0
# 注意：单条 mutant 的 skipped（产物缺失 / 环境错误）属契约 §4.1「按约定 skipped」，整体仍为 0；
# 只有锁未取得、基线红、全局环境不可用（$overallExit=2）才返回 2。
$cntKilled       = @($records | Where-Object { $_.status -eq 'killed' }).Count
$cntSurvived     = @($records | Where-Object { $_.status -eq 'survived' }).Count
$cntSkipped      = @($records | Where-Object { $_.status -eq 'skipped' }).Count
$cntApplyFailed  = @($records | Where-Object { $_.status -eq 'apply-failed' }).Count
$cntRevertFailed = @($records | Where-Object { $_.status -eq 'revert-failed' }).Count
$cntGreenFailed  = @($records | Where-Object { $_.status -eq 'green-failed' }).Count
$hasRevertFailed = $cntRevertFailed -gt 0
$hasGreenFailed  = $cntGreenFailed -gt 0
$hasApplyFailed  = $cntApplyFailed -gt 0
$hasSurvived     = $cntSurvived -gt 0

Write-Global ("SUMMARY killed={0} survived={1} skipped={2} apply-failed={3} revert-failed={4} green-failed={5}" -f `
  $cntKilled, $cntSurvived, $cntSkipped, $cntApplyFailed, $cntRevertFailed, $cntGreenFailed)

if ($hasRevertFailed) { exit 4 }
if ($hasGreenFailed) { exit 5 }
if ($hasApplyFailed) { exit 3 }
if ($overallExit -eq 2) { exit 2 }
if ($hasSurvived) { exit 1 }
exit 0
