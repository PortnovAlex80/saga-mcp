# Kill orchestrate-cli engines AND claude -p workers (full emergency stop).
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'orchestrate-cli' -or ($_.Name -like 'claude*' -and $_.CommandLine -match ' -p ') } | ForEach-Object { Write-Output ("KILL {0}" -f $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
