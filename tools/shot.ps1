# 用无头 Chrome 给本地站点截图 + 抓取渲染后的 DOM。
# 关键点：必须用 Start-Process 重定向输出；直接用 & 调用会拿到 0 字节。
param(
  [string]$Url = 'http://127.0.0.1:8765/',
  [string]$Out = 'tmp\shot.png',
  [string]$Dom = 'tmp\dom.html',
  [int]$BudgetMs = 75000,
  [int]$W = 1600,
  [int]$H = 1000
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$prof = Join-Path $root ('tmp\cp-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$shot = Join-Path $root $Out
$dump = Join-Path $root $Dom
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $shot) | Out-Null

$common = @(
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-sync', '--hide-scrollbars',
  '--force-device-scale-factor=1',
  "--user-data-dir=$prof",
  "--virtual-time-budget=$BudgetMs",
  "--window-size=$W,$H"
)

$p = Start-Process -FilePath $chrome -ArgumentList ($common + @("--screenshot=$shot", $Url)) `
  -RedirectStandardOutput "$root\tmp\chrome1.out" -RedirectStandardError "$root\tmp\chrome1.err" -PassThru -Wait
"截图 exit=$($p.ExitCode)"
if (Test-Path $shot) { "截图: $shot  $((Get-Item $shot).Length) bytes" } else { "截图失败" }

$p2 = Start-Process -FilePath $chrome -ArgumentList ($common + @('--dump-dom', $Url)) `
  -RedirectStandardOutput $dump -RedirectStandardError "$root\tmp\chrome2.err" -PassThru -Wait
"DOM exit=$($p2.ExitCode)"
if (Test-Path $dump) { "DOM: $dump  $((Get-Item $dump).Length) bytes" }

Remove-Item $prof -Recurse -Force -ErrorAction SilentlyContinue
