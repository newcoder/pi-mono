#requires -RunAsAdministrator
<#
.SYNOPSIS
    配置 Windows 任务计划程序，每天 01:20 运行 A-Share 数据同步
.DESCRIPTION
    创建定时任务 "A-Share-Daily-Sync"，运行 daily_sync.py
    任务在每天 01:20 执行，失败后重试 3 次
.NOTES
    需要以管理员身份运行 PowerShell
#>

$TaskName = "A-Share-Daily-Sync"
$SkillDir = Join-Path $env:USERPROFILE ".agents\skills\a-share-analysis\scripts"
$PythonExe = "python"
$ScriptPath = Join-Path $SkillDir "daily_sync.py"
$LogDir = Join-Path $env:USERPROFILE ".trading-agent\logs"

# Check if script exists
if (-not (Test-Path $ScriptPath)) {
    Write-Error "Script not found: $ScriptPath"
    Write-Host "请确保已将 daily_sync.py 和 sync_validator.py 复制到 $SkillDir"
    exit 1
}

# Ensure log directory exists
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Action: run python daily_sync.py
$Action = New-ScheduledTaskAction -Execute $PythonExe -Argument "`"$ScriptPath`"" -WorkingDirectory $SkillDir

# Trigger: daily at 01:20
$Trigger = New-ScheduledTaskTrigger -Daily -At "01:20"

# Settings
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -WakeToRun `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5)

# Principal: run whether user is logged on or not
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest

# Register or update task
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($ExistingTask) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "已移除旧任务: $TaskName"
}

Register-ScheduledTask -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description "A-Share Analysis 全市场数据每日同步 (stocks/quotes/klines/fundamentals/industries/concepts/news)"

Write-Host ""
Write-Host "========================================"
Write-Host "定时任务配置成功!"
Write-Host "========================================"
Write-Host "任务名称: $TaskName"
Write-Host "执行时间: 每天 01:20"
Write-Host "执行命令: $PythonExe `"$ScriptPath`""
Write-Host "工作目录: $SkillDir"
Write-Host "日志目录: $LogDir"
Write-Host ""
Write-Host "查看任务: schtasks /query /tn `"$TaskName`" /v"
Write-Host "手动运行: schtasks /run /tn `"$TaskName`""
Write-Host "删除任务: schtasks /delete /tn `"$TaskName`" /f"
Write-Host ""
Write-Host "日志文件: $LogDir\sync_YYYYMMDD.log"
Write-Host "报告文件: $LogDir\sync_summary_YYYYMMDD.json"
