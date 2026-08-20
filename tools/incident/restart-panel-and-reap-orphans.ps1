# Reap orphan orchestrate-cli engines, then restart the tracker panel (paths pinned to the test2 workshop-testing DB — edit DB_PATH before reuse on another run).
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'orchestrate-cli' } | ForEach-Object { Write-Output ("KILL ORPHAN ENGINE {0}" -f $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
$env:DB_PATH = 'C:/Users/user/.zcode/saga-test2-20260816.db'
$env:SAGA_PRODUCT_LIFECYCLE_COMPOSITION = 'D:/Development/saga-mcp/tracker-view/product-delivery-composition.mjs'
$env:SAGA_FACTORY_CHECKPOINT_STORE = 'C:/Users/user/.zcode/factory-checkpoints-test2'
$env:SAGA_FACTORY_CHECKPOINT_LOGS = '1'
$env:NODE_OPTIONS = '--max-old-space-size=8192'
Start-Process -WindowStyle Hidden node -ArgumentList 'tracker-view\tracker-view.mjs' -WorkingDirectory 'D:\Development\saga-mcp'
Write-Output 'PANEL RESTARTED'
