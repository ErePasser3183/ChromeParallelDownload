$ErrorActionPreference = 'Stop'
$targetConfig = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'native\aria2.conf'))
Get-CimInstance Win32_Process -Filter "Name = 'aria2c.exe' OR Name = 'aria2c-local64.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains($targetConfig)
} | ForEach-Object { Stop-Process -Id $_.ProcessId }
$reg = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\local.chrome_parallel_download'
if (Test-Path -LiteralPath $reg) { Remove-Item -LiteralPath $reg }
Write-Host '本机桥接已注销。请在 Chrome 中移除扩展；下载文件会保留。'
