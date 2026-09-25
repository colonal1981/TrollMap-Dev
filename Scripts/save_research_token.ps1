# save_research_token.ps1 -- store the research key once, encrypted to this Windows login.
#
# Personal use only, not for distribution or resale; not for navigation.
#
# Run it yourself, once, in PowerShell:
#
#     powershell -ExecutionPolicy Bypass -File F:\TrollMapPipeline\TrollMap-Dev\Scripts\save_research_token.ps1
#
# It asks for the key with hidden input (paste it and press Enter) and writes it encrypted with
# Windows' own per-user protection (DPAPI, the same thing Credential Manager uses). Only this Windows
# account on this computer can decrypt it; the file is useless anywhere else. Nothing is printed.
# run_research.ps1 reads it into the research process's environment and nowhere else, so a research
# run can be started without the key ever being typed, shown, logged or read by anyone.
#
# To replace the key later, run this again. To remove it, delete the file it names.

param([string]$KeyFile = (Join-Path $env:LOCALAPPDATA 'TrollMap\research_key.dat'))

$dir = Split-Path $KeyFile
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

$secure = Read-Host -AsSecureString 'Paste the TROLLMAP_SYNC_TOKEN value and press Enter (nothing will show)'
if ($secure.Length -eq 0) { Write-Host 'Nothing was entered; nothing was saved.'; exit 1 }

$secure | ConvertFrom-SecureString | Set-Content -Path $KeyFile -Encoding ASCII
Write-Host "Saved, encrypted to this Windows login: $KeyFile ($($secure.Length) characters)."
