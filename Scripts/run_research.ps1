# run_research.ps1 -- start a research run with the stored key, without anyone seeing the key.
#
# Personal use only, not for distribution or resale; not for navigation.
#
# WHY. Every research run needed Ryan at his keyboard (or on his phone through Chrome Remote
# Desktop), because TROLLMAP_SYNC_TOKEN lived only in the shell he typed it into. The key is now
# stored once, encrypted to his Windows login (save_research_token.ps1), and this script puts it in
# the research process's environment and nowhere else: it is never printed, logged, passed on a
# command line or written to disk in the clear. Claude starts runs through this script and never
# reads the key.
#
#   powershell -ExecutionPolicy Bypass -File Scripts\run_research.ps1 -Run '--lake "LAKE JORDAN, NC" --group-models claude' -Detach
#   powershell -ExecutionPolicy Bypass -File Scripts\run_research.ps1 -Check
#
#   -Run     the arguments for research_lakes.py, as one string
#   -Detach  start it in the background and return at once; the output goes to the log it names
#   -Check   say whether everything a run needs is here, and start nothing
#
# ONE BATCH AT A TIME. It refuses to start while another research_lakes.py is running: two batches
# share the Gemini keys and the Claude allowance, and a push to main mid-run redeploys the Worker
# under it.

param(
  [string]$Run = '',
  [switch]$Detach,
  [switch]$Check,
  [string]$KeyFile = (Join-Path $env:LOCALAPPDATA 'TrollMap\research_key.dat'),
  [string]$Root = (Split-Path (Split-Path $PSScriptRoot))
)
$ErrorActionPreference = 'Stop'

function Read-Key {
  if (-not (Test-Path $KeyFile)) { throw "No stored key at $KeyFile -- run Scripts\save_research_token.ps1 once first." }
  $secure = Get-Content -Path $KeyFile | ConvertTo-SecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Get-Running {
  @(Get-CimInstance Win32_Process | Where-Object {
      $_.CommandLine -match 'research_lakes\.py' -and $_.Name -match '^(py|python)[0-9.]*\.exe$' })
}

$script = Join-Path $Root 'TrollMap-Dev\Scripts\research_lakes.py'
$py = (Get-Command py -ErrorAction SilentlyContinue).Source
$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude -and (Test-Path "$HOME\.local\bin\claude.exe")) { $claude = "$HOME\.local\bin\claude.exe" }

$running = Get-Running
if ($Check) {
  $ok = $true
  try { $k = Read-Key; Write-Host "key: stored, decrypts ($($k.Length) characters)"; $k = $null }
  catch { Write-Host "key: $($_.Exception.Message)"; $ok = $false }
  Write-Host "research_lakes.py: $(if (Test-Path $script) { $script } else { $ok = $false; 'NOT FOUND' })"
  Write-Host "py: $(if ($py) { $py } else { $ok = $false; 'NOT FOUND' })"
  Write-Host "claude CLI: $(if ($claude) { $claude } else { 'not found (only --group-models claude needs it)' })"
  Write-Host "research running now: $($running.Count)"
  if ($ok) {
    $env:TROLLMAP_SYNC_TOKEN = Read-Key
    & $py -c "import os; v = os.environ.get('TROLLMAP_SYNC_TOKEN', ''); print('key reaches a child process:', bool(v))"
    Remove-Item Env:TROLLMAP_SYNC_TOKEN
  }
  exit ([int](-not $ok))
}

if (-not $Run.Trim()) { throw 'Nothing to run: pass -Run with the research_lakes.py arguments.' }
if ($running.Count) { throw "A research run is already going (PID $($running.ProcessId -join ', ')). One batch at a time." }

$logs = Join-Path $Root '_reports\run_logs'
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$log = Join-Path $logs "research_$stamp.log"
$err = Join-Path $logs "research_$stamp.err.log"

# The key goes into THIS process's environment, which the run inherits, and nowhere else.
$env:TROLLMAP_SYNC_TOKEN = Read-Key
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUNBUFFERED = '1'
Remove-Item Env:CLAUDECODE -ErrorAction SilentlyContinue

$argLine = "`"$script`" $Run"
Set-Content -Path (Join-Path $logs 'latest.txt') -Value "$log`r`n$err`r`nstarted $(Get-Date -Format s)`r`nargs: $Run" -Encoding UTF8
$p = Start-Process -FilePath $py -ArgumentList $argLine -WorkingDirectory $Root -NoNewWindow -PassThru `
       -RedirectStandardOutput $log -RedirectStandardError $err
Remove-Item Env:TROLLMAP_SYNC_TOKEN
Write-Host "started research_lakes.py (PID $($p.Id)) with: $Run"
Write-Host "output: $log"
Write-Host "errors: $err"
if (-not $Detach) { $p.WaitForExit(); Write-Host "finished, exit $($p.ExitCode)"; exit $p.ExitCode }
