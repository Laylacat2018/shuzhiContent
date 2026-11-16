# Managed by SCW real pipeline. Run once as the Windows user who owns this WSL distro.
$ErrorActionPreference = 'Stop'
$scwTaskName = 'SCW-Real-Platform'
$scwDescription = 'Managed by SCW real pipeline: start local API, ComfyUI and downloads; keep WSL alive.'
$scwCodePath = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$scwResolved = @(& wsl.exe -d Ubuntu-22.04 --exec /usr/bin/wslpath -a -u $scwCodePath.Replace('\','/'))
if ($LASTEXITCODE -ne 0 -or !$scwResolved.Count) { throw 'Cannot resolve this checkout in WSL.' }
$scwLinuxPath = ($scwResolved -join '').Trim()
if (!$scwLinuxPath.StartsWith('/mnt/')) { throw 'Cannot resolve this checkout in WSL.' }
$scwExisting = Get-ScheduledTask -TaskName $scwTaskName -ErrorAction SilentlyContinue
if ($scwExisting -and $scwExisting.Description -notlike 'Managed by SCW real pipeline:*') { throw 'A different task already owns this name.' }
$scwUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$scwShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$scwArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -Command "& wsl.exe -d Ubuntu-22.04 --exec /bin/bash ''' + $scwLinuxPath + '/ops/production/keep-running.sh''; exit $LASTEXITCODE"'
$scwAction = New-ScheduledTaskAction -Execute $scwShell -Argument $scwArguments -WorkingDirectory $scwCodePath
$scwTrigger = New-ScheduledTaskTrigger -AtLogOn -User $scwUser
$scwPrincipal = New-ScheduledTaskPrincipal -UserId $scwUser -LogonType Interactive -RunLevel Limited
$scwSettings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $scwTaskName -Description $scwDescription -Action $scwAction -Trigger $scwTrigger -Principal $scwPrincipal -Settings $scwSettings -Force | Out-Null
Start-ScheduledTask -TaskName $scwTaskName
Get-ScheduledTask -TaskName $scwTaskName | Select-Object TaskName, State
