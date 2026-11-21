<#
.SYNOPSIS
  Collect A-round acceptance evidence under .scratch\run\A\evidence\<AC>\.

.DESCRIPTION
  Reproducible evidence collector for AC-A-01 .. AC-A-18 (plus A-19/A-20/A-21
  status notes). Every AC gets its own directory with request.txt, response.json
  and status.txt. The script is safe to re-run: it overwrites the per-AC files.

  Prerequisites: the server is running (YXS_LLM=mock) and the test student
  exists (scripts/add-student.mjs). Failures are recorded per AC instead of
  aborting the whole run.

.EXAMPLE
  pwsh -NoProfile -File apps\server\scripts\evidence.ps1
  $env:YXS_BASE_URL='http://127.0.0.1:8080'; pwsh -NoProfile -File apps\server\scripts\evidence.ps1
#>

#requires -Version 7
[CmdletBinding()]
param(
  [string]$Base = ($env:YXS_BASE_URL ?? 'http://127.0.0.1:8080'),
  [string]$StudentId = ($env:YXS_SMOKE_STUDENT ?? '20230001'),
  [string]$Password = ($env:YXS_SMOKE_PASSWORD ?? 'abc12345'),
  [string]$StudentBId = '20230002'
)

$ErrorActionPreference = 'Continue'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$outRoot = Join-Path $repoRoot '.scratch\run\A\evidence'
$serverScripts = Join-Path $repoRoot 'apps\server\scripts'
New-Item -ItemType Directory -Force $outRoot | Out-Null

$script:Token = $null

function Get-EvidenceDir([string]$ac) {
  $dir = Join-Path $outRoot $ac
  New-Item -ItemType Directory -Force $dir | Out-Null
  return $dir
}

function Save-Text([string]$dir, [string]$name, [string]$content) {
  Set-Content -Path (Join-Path $dir $name) -Value $content -Encoding utf8
}

function Invoke-Api {
  param(
    [string]$Method = 'GET',
    [string]$Path,
    [object]$Body,
    [string]$Token,
    [switch]$Raw
  )
  $headers = @{ 'content-type' = 'application/json; charset=utf-8' }
  if ($Token) { $headers.Authorization = "Bearer $Token" }
  $jsonBody = if ($null -ne $Body) { $Body | ConvertTo-Json -Depth 10 -Compress } else { $null }
  try {
    $params = @{ Uri = "$Base$Path"; Method = $Method; Headers = $headers }
    if ($null -ne $jsonBody) { $params.Body = $jsonBody }
    $resp = Invoke-WebRequest @params -SkipHttpErrorCheck
    $content = $resp.Content
    if ($Raw) { return [pscustomobject]@{ Status = $resp.StatusCode; Content = $content } }
    $parsed = $null
    if ($content) { try { $parsed = $content | ConvertFrom-Json } catch { $parsed = $null } }
    return [pscustomobject]@{ Status = $resp.StatusCode; Json = $parsed; Content = $content }
  } catch {
    return [pscustomobject]@{ Status = 0; Json = $null; Content = $_.Exception.Message }
  }
}

function Save-RpcEvidence {
  param([string]$Ac, [string]$RpcMethod, [object]$Params, [string]$Token, [string]$Note)
  $dir = Get-EvidenceDir $Ac
  $body = @{ method = $RpcMethod; params = $Params }
  $requestText = "POST /api/v1/rpc`nmethod: $RpcMethod`nparams: $($Params | ConvertTo-Json -Depth 10 -Compress)"
  if ($Note) { $requestText += "`nnote: $Note" }
  Save-Text $dir 'request.txt' $requestText
  $resp = Invoke-Api -Method Post -Path '/api/v1/rpc' -Body $body -Token $Token
  Save-Text $dir 'response.json' ($resp.Content ?? '')
  Save-Text $dir 'status.txt' ([string]$resp.Status)
  return $resp
}

function Login-Student([string]$Id, [string]$Pw) {
  # The server allows 5 login attempts per IP per minute (contract §3.2); this
  # script deliberately spends several of them, so a 429 is expected here and
  # waiting out the window is the correct response, not a failure.
  for ($attempt = 1; $attempt -le 2; $attempt += 1) {
    $resp = Invoke-Api -Method Post -Path '/api/v1/auth/login' -Body @{ studentId = $Id; password = $Pw }
    if ($resp.Status -eq 200 -and $resp.Json.ok) { return $resp.Json.result.token }
    if ($resp.Status -ne 429) { return $null }
    Start-Sleep -Seconds 62
  }
  return $null
}

# AC-A-01 health (no auth)
$dir = Get-EvidenceDir 'AC-A-01'
Save-Text $dir 'request.txt' "GET /health"
$resp = Invoke-Api -Path '/health'
Save-Text $dir 'response.json' ($resp.Content ?? '')
Save-Text $dir 'status.txt' ([string]$resp.Status)

# AC-A-02 login correct
$dir = Get-EvidenceDir 'AC-A-02'
Save-Text $dir 'request.txt' "POST /api/v1/auth/login`nstudentId: $StudentId"
$resp = $null
for ($attempt = 1; $attempt -le 2; $attempt += 1) {
  # A stale 429 from a previous run is an environment condition, not a verdict.
  $resp = Invoke-Api -Method Post -Path '/api/v1/auth/login' -Body @{ studentId = $StudentId; password = $Password }
  if ($resp.Status -ne 429) { break }
  Start-Sleep -Seconds 62
}
Save-Text $dir 'response.json' ($resp.Content ?? '')
Save-Text $dir 'status.txt' ([string]$resp.Status)
if ($resp.Status -eq 200 -and $resp.Json.ok) { $script:Token = $resp.Json.result.token }

# AC-A-03 two failing logins, identical message
$dir = Get-EvidenceDir 'AC-A-03'
$fail1 = Invoke-Api -Method Post -Path '/api/v1/auth/login' -Body @{ studentId = $StudentId; password = 'wrong-password' }
$fail2 = Invoke-Api -Method Post -Path '/api/v1/auth/login' -Body @{ studentId = '99999999'; password = 'whatever' }
if ($fail1.Status -eq 429) {
  Start-Sleep -Seconds 62
  $fail1 = Invoke-Api -Method Post -Path '/api/v1/auth/login' -Body @{ studentId = $StudentId; password = 'wrong-password' }
  $fail2 = Invoke-Api -Method Post -Path '/api/v1/auth/login' -Body @{ studentId = '99999999'; password = 'whatever' }
}
Save-Text $dir 'request.txt' "POST /api/v1/auth/login (wrong password)`nPOST /api/v1/auth/login (unknown student)"
Save-Text $dir 'login-fail-1.json' ($fail1.Content ?? '')
Save-Text $dir 'login-fail-2.json' ($fail2.Content ?? '')
Save-Text $dir 'status.txt' "$($fail1.Status) / $($fail2.Status)"

# AC-A-04 spoofed studentId in body must be ignored (identity comes from token)
Save-RpcEvidence -Ac 'AC-A-04' -RpcMethod 'student.current' -Params @{ studentId = '99999999' } -Token $script:Token -Note '日志中的 ignoredStudentId=true 取自服务端 stdout；本目录只留存请求/响应原文。' | Out-Null

# AC-A-05 logout then reuse the same token
$dir = Get-EvidenceDir 'AC-A-05'
$logout = Invoke-Api -Method Post -Path '/api/v1/auth/logout' -Body @{} -Token $script:Token
Save-Text $dir 'request.txt' "POST /api/v1/auth/logout`nPOST /api/v1/rpc student.current (reuse revoked token)"
Save-Text $dir 'logout.json' ($logout.Content ?? '')
$reuse = Invoke-Api -Method Post -Path '/api/v1/rpc' -Body @{ method = 'student.current'; params = @{} } -Token $script:Token
Save-Text $dir 'response.json' ($reuse.Content ?? '')
Save-Text $dir 'status.txt' ([string]$reuse.Status)
# re-login for the remaining ACs
$script:Token = Login-Student $StudentId $Password

# AC-A-06 three strict-validation rejections (verbatim Chinese messages)
Save-RpcEvidence -Ac 'AC-A-06' -RpcMethod 'kps.list' -Params @{ limit = '10' } -Token $script:Token | Out-Null
Save-RpcEvidence -Ac 'AC-A-06' -RpcMethod 'news.get' -Params @{} -Token $script:Token | Out-Null
Save-RpcEvidence -Ac 'AC-A-06' -RpcMethod 'profile.snapshot' -Params @{ chapterId = 'ch01'; checkpoint = 'mid' } -Token $script:Token | Out-Null

# AC-A-07 unknown method
Save-RpcEvidence -Ac 'AC-A-07' -RpcMethod 'foo.bar' -Params @{} -Token $script:Token | Out-Null

# AC-A-08 probe all 30 methods
$dir = Get-EvidenceDir 'AC-A-08'
Save-Text $dir 'request.txt' 'node scripts/probe-methods.mjs'
$probe = & node (Join-Path $serverScripts 'probe-methods.mjs') 2>&1
$probe | Set-Content (Join-Path $dir 'methods.jsonl') -Encoding utf8
Save-Text $dir 'status.txt' ([string]$LASTEXITCODE)

# AC-A-09 legacy 4 methods (filtered out of the combined probe output)
$dir = Get-EvidenceDir 'AC-A-09'
Save-Text $dir 'request.txt' 'legacy methods from probe-methods.mjs: getKp, getBlock, getResource, listIdeology'
$legacy = $probe | Where-Object { $_ -match '"method":"(getKp|getBlock|getResource|listIdeology)"' }
$legacy | Set-Content (Join-Path $dir 'legacy.jsonl') -Encoding utf8
Save-Text $dir 'status.txt' ([string]$LASTEXITCODE)

# AC-A-10 cross-student ownership: student B reads student A's session
$dir = Get-EvidenceDir 'AC-A-10'
$aSessions = Invoke-Api -Method Post -Path '/api/v1/rpc' -Body @{ method = 'chat.sessions'; params = @{} } -Token $script:Token
$sessionId = $null
if ($aSessions.Json?.result) { $sessionId = $aSessions.Json.result[0].id }
# ensure student B exists
& node (Join-Path $serverScripts 'add-student.mjs') --id $StudentBId --name '学生B' --cohort '2023' --password $Password 2>&1 | Out-Null
$tokenB = Login-Student $StudentBId $Password
if (-not $sessionId -or -not $tokenB) {
  Save-Text $dir 'request.txt' "chat.messages sessionId=$sessionId (student B)"
  Save-Text $dir 'response.json' 'skipped: 缺少 A 的会话或学生 B 登录失败'
  Save-Text $dir 'status.txt' 'skipped'
} else {
  $forbidden = Invoke-Api -Method Post -Path '/api/v1/rpc' -Body @{ method = 'chat.messages'; params = @{ sessionId = $sessionId } } -Token $tokenB
  Save-Text $dir 'request.txt' "chat.messages sessionId=$sessionId (token=$StudentBId)"
  Save-Text $dir 'response.json' ($forbidden.Content ?? '')
  Save-Text $dir 'status.txt' ([string]$forbidden.Status)
}

# AC-A-11 SSE greeting raw frames
$dir = Get-EvidenceDir 'AC-A-11'
Save-Text $dir 'request.txt' "POST /api/v1/chat/stream`nmessage: 你好"
curl.exe -s -N -X POST "$Base/api/v1/chat/stream" -H "authorization: Bearer $script:Token" -H 'content-type: application/json' -d '{"message":"你好"}' -o (Join-Path $dir 'sse-raw.txt')
Save-Text $dir 'status.txt' ([string]$LASTEXITCODE)

# AC-A-12 cancel: fire a stream, cancel after 200ms, keep whatever frames arrived
$dir = Get-EvidenceDir 'AC-A-12'
$cancelRequestId = "req_cancelprobe$([DateTime]::UtcNow.ToString('hhmmss'))"
Save-Text $dir 'request.txt' "POST /api/v1/chat/stream (requestId=$cancelRequestId)`nPOST /api/v1/chat/cancel (200ms later)"
$cancelStreamPath = Join-Path $dir 'cancel-stream.txt'
$bodyPath = Join-Path $dir 'stream-request.json'
Set-Content -LiteralPath $bodyPath -Value (@{ message = '出一道很长的题，慢慢想'; requestId = $cancelRequestId } | ConvertTo-Json -Compress) -Encoding utf8 -NoNewline
$curlArgs = @(
  '-s', '-N', '-X', 'POST', "$Base/api/v1/chat/stream",
  # Start-Process joins arguments with spaces, so header values need their own quotes.
  '-H', '"content-type: application/json"',
  '-H', "`"authorization: Bearer $script:Token`"",
  '-d', "@$bodyPath",
  '-o', $cancelStreamPath
)
$streamProcess = Start-Process -FilePath 'curl.exe' -ArgumentList $curlArgs -PassThru -NoNewWindow
# Wait until the stream is actually open (session frame on disk) before cancelling;
# a fixed sleep races the HTTP connect and would cancel a request that never started.
$sessionSeen = $false
for ($i = 0; $i -lt 30; $i += 1) {
  Start-Sleep -Milliseconds 100
  if ((Test-Path $cancelStreamPath) -and ((Get-Content -LiteralPath $cancelStreamPath -Raw) -match 'event: session')) { $sessionSeen = $true; break }
}
Start-Sleep -Milliseconds 100
$cancel = Invoke-Api -Method Post -Path '/api/v1/chat/cancel' -Body @{ requestId = $cancelRequestId } -Token $script:Token
# A cancel that lands before the registry entry exists is a no-op (cancelled:false);
# retry briefly while the paced stream is still running.
for ($i = 0; $i -lt 3 -and $cancel.Json?.result?.cancelled -ne $true; $i += 1) {
  Start-Sleep -Milliseconds 150
  $cancel = Invoke-Api -Method Post -Path '/api/v1/chat/cancel' -Body @{ requestId = $cancelRequestId } -Token $script:Token
}
Save-Text $dir 'cancel.txt' ($cancel.Content ?? '')
$null = $streamProcess.WaitForExit(10000)
$cancelStream = Get-Content -LiteralPath $cancelStreamPath -Raw
$cancelledFlag = $cancel.Json?.result?.cancelled
$hasCancelError = $cancelStream -match '"code":"CANCELLED"'
$hasDone = $cancelStream -match '(?m)^event: done'
Save-Text $dir 'checks.txt' "session_frame_seen=$sessionSeen`ncancel_status=$($cancel.Status)`ncancelled=$cancelledFlag`nerror_event=$hasCancelError`ndone_after_cancel=$hasDone"
$cancelOk = ($cancel.Status -eq 200) -and ($cancelledFlag -eq $true) -and (-not $hasDone)
Save-Text $dir 'status.txt' $(if ($cancelOk) { '200' } else { "FAIL cancel=$($cancel.Status) cancelled=$cancelledFlag error_event=$hasCancelError done=$hasDone" })


# AC-A-13 answer-set readback (raw evidence mirrors the smoke flow)
$dir = Get-EvidenceDir 'AC-A-13'
Save-Text $dir 'request.txt' 'stream 出题 → answer-set → questions.attempts（完整流程见 AC-A-20 smoke.txt）'
$stream = curl.exe -s -N -X POST "$Base/api/v1/chat/stream" -H "authorization: Bearer $script:Token" -H 'content-type: application/json' -d '{"message":"出两道题练习一下"}'
# curl output arrives as one element per line; join before splitting into frames.
$streamRaw = ($stream -join "`n")
$doneData = $null
foreach ($block in ($streamRaw -split "(\r?\n){2}")) {
  if ($block -match '(?m)^event: done\s*$') {
    $dataLine = ($block -split "`n" | Where-Object { $_ -like 'data:*' }) -replace '^data:\s?', ''
    if ($dataLine) { try { $doneData = ($dataLine -join "`n" | ConvertFrom-Json) } catch { $doneData = $null } }
  }
}
if ($doneData) {
  $artifact = @($doneData.artifacts | Where-Object { $_.type -eq 'question_set' -or $_.kind -eq 'question_set' })[0]
  if ($artifact) {
    $content = $artifact.content_json
    if ($content -is [string]) { try { $content = $content | ConvertFrom-Json } catch { $content = $null } }
    $questionIds = @($content.questions | ForEach-Object { $_.id } | Where-Object { $_ })
    $answers = @($questionIds | ForEach-Object { @{ questionId = $_; answer = '参考作答：结合课堂定义与案例说明。' } })
    $answerSet = Invoke-Api -Method Post -Path '/api/v1/answer-set' -Body @{ sessionId = $doneData.sessionId; artifactId = $artifact.id; answers = $answers } -Token $script:Token
    Save-Text $dir 'answer-set.json' ($answerSet.Content ?? '')
    $attempts = Invoke-Api -Method Post -Path '/api/v1/rpc' -Body @{ method = 'questions.attempts'; params = @{ questionIds = $questionIds } } -Token $script:Token
    Save-Text $dir 'attempts.json' ($attempts.Content ?? '')
    Save-Text $dir 'status.txt' ([string]$answerSet.Status)
  } else {
    Save-Text $dir 'response.json' 'skipped: done.artifacts 中没有 question_set'
    Save-Text $dir 'status.txt' 'skipped'
  }
} else {
  Save-Text $dir 'response.json' 'skipped: SSE 未解析到 done 帧'
  Save-Text $dir 'status.txt' 'skipped'
}

# AC-A-14 health without token, both routes
$dir = Get-EvidenceDir 'AC-A-14'
$h1 = Invoke-Api -Path '/health'
$h2 = Invoke-Api -Path '/api/v1/health'
Save-Text $dir 'request.txt' "GET /health`nGET /api/v1/health"
Save-Text $dir 'health-no-auth.json' (($h1.Content ?? '') + "`n" + ($h2.Content ?? ''))
Save-Text $dir 'status.txt' "$($h1.Status) / $($h2.Status)"

# AC-A-15 metrics
$dir = Get-EvidenceDir 'AC-A-15'
Save-Text $dir 'request.txt' 'GET /metrics'
$metrics = Invoke-Api -Path '/metrics' -Raw
Save-Text $dir 'metrics.txt' ($metrics.Content ?? '')
Save-Text $dir 'status.txt' ([string]$metrics.Status)

# AC-A-16 log sample: only when the server writes stdout to a file (YXS_LOG_FILE)
$dir = Get-EvidenceDir 'AC-A-16'
if ($env:YXS_LOG_FILE -and (Test-Path $env:YXS_LOG_FILE)) {
  Get-Content $env:YXS_LOG_FILE -Tail 100 | Set-Content (Join-Path $dir 'log-sample.jsonl') -Encoding utf8
  Save-Text $dir 'status.txt' '200'
} else {
  Save-Text $dir 'request.txt' '服务端 stdout 未重定向到文件；启动时用 YXS_LOG_FILE 指向日志文件后重跑本脚本。'
  Save-Text $dir 'status.txt' 'skipped'
}

# AC-A-17 concurrent snapshot writes (60), then record the busy counter
$dir = Get-EvidenceDir 'AC-A-17'
$chapters = Invoke-Api -Method Post -Path '/api/v1/rpc' -Body @{ method = 'chapters.list'; params = @{} } -Token $script:Token
$chapterRows = @($chapters.Json.result)
$chapterId = if ($chapterRows.Count -gt 0) { $chapterRows[0].id } else { '' }
if (-not $chapterId) {
  Save-Text $dir 'request.txt' 'chapters.list 返回空或未授权'
  Save-Text $dir 'busy.txt' ($chapters.Content ?? '')
  Save-Text $dir 'status.txt' 'skipped'
} else {
  Save-Text $dir 'request.txt' "60 并发 POST /api/v1/rpc profile.snapshot (chapterId=$chapterId, checkpoint=post)"
  $results = 1..60 | ForEach-Object -Parallel {
    $body = @{ method = 'profile.snapshot'; params = @{ chapterId = $using:chapterId; checkpoint = 'post' } } | ConvertTo-Json -Compress
    try {
      $r = Invoke-WebRequest -Uri "$using:Base/api/v1/rpc" -Method Post -Headers @{ authorization = "Bearer $using:Token"; 'content-type' = 'application/json' } -Body $body -SkipHttpErrorCheck
      $r.StatusCode
    } catch { 0 }
  } -ThrottleLimit 60
  $metricsAfter = Invoke-Api -Path '/metrics' -Raw
  $busyLine = ($metricsAfter.Content -split "`n" | Where-Object { $_ -like 'yxs_sqlite_busy_total*' }) -join "`n"
  Save-Text $dir 'busy.txt' ("statuses: " + ($results -join ',') + "`n" + $busyLine)
  Save-Text $dir 'status.txt' ([string]($results | Where-Object { $_ -ge 500 }).Count)
}

# AC-A-18 OpenAPI self-check
$dir = Get-EvidenceDir 'AC-A-18'
Save-Text $dir 'request.txt' 'node scripts/openapi-check.mjs'
$check = & node (Join-Path $serverScripts 'openapi-check.mjs') 2>&1
$check | Set-Content (Join-Path $dir 'openapi-check.txt') -Encoding utf8
Save-Text $dir 'status.txt' ([string]$LASTEXITCODE)

# AC-A-19 docker build/run: unavailable on this host
$dir = Get-EvidenceDir 'AC-A-19'
Save-Text $dir 'request.txt' 'docker build -f apps/server/Dockerfile -t yxs-server:local . && docker run --rm yxs-server:local'
Save-Text $dir 'status.txt' 'skipped'
Save-Text $dir 'response.json' 'skipped: 本机没有 docker 命令；Dockerfile 未实跑，详见 apps/server/docs/deviation-notes.md'

# AC-A-20 smoke five steps
$dir = Get-EvidenceDir 'AC-A-20'
Save-Text $dir 'request.txt' 'node scripts/smoke.mjs'
# smoke logs in itself; the login budget above is spent, so let the window reset.
Start-Sleep -Seconds 62
$smoke = & node (Join-Path $serverScripts 'smoke.mjs') 2>&1
$smoke | Set-Content (Join-Path $dir 'smoke.txt') -Encoding utf8
Save-Text $dir 'status.txt' ([string]$LASTEXITCODE)

# AC-A-21 offline smoke: depends on unplugging the network; mock does not call out
$dir = Get-EvidenceDir 'AC-A-21'
Save-Text $dir 'request.txt' '断网后重跑 node scripts/smoke.mjs（YXS_LLM=mock）'
Save-Text $dir 'status.txt' 'skipped'
Save-Text $dir 'response.json' 'skipped: 由人工断网后复跑 AC-A-20；mock LLM 不访问外网。'

Write-Host "证据采集完成：$outRoot"
