# Kill all orchestrate-cli engine processes (frozen-engine recovery one-shot; operator battle-tested 2026-08 stage-10/11).
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'orchestrate-cli' } | ForEach-Object {
  Write-Output ("KILL FROZEN {0}" -f $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
