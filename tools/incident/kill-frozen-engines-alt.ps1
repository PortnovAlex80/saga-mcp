# Compact variant: kill orchestrate-cli processes (frozen-engine recovery one-shot).
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'orchestrate-cli' } | ForEach-Object {
  Write-Output ("KILL FROZEN ENGINE {0}" -f $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
