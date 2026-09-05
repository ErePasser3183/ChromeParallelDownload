param(
    [string]$DownloadDir = '',
    [switch]$SkipRegistration
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$native = Join-Path $root 'native'
$expectedAriaHash = 'BE2099C214F63A3CB4954B09A0BECD6E2E34660B886D4C898D260FEBFE9D70C2'
$ariaUrl = 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip'

function Find-Python {
    $command = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($command) {
        try {
            $actual = & $command.Source -c 'import sys; print(sys.executable)' 2>$null
            if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $actual)) { return $actual }
        } catch {}
    }
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        try {
            $actual = & $launcher.Source -3 -c 'import sys; print(sys.executable)' 2>$null
            if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $actual)) { return $actual }
        } catch {}
    }
    throw '需要 Python 3。请先从 https://www.python.org/downloads/windows/ 安装，然后重试。'
}

function Install-Aria2 {
    $aria = Join-Path $native 'aria2c.exe'
    if (Test-Path -LiteralPath $aria) {
        if ((Get-FileHash -LiteralPath $aria -Algorithm SHA256).Hash -ne $expectedAriaHash) {
            throw 'native\aria2c.exe 哈希不匹配。请删除它后重试。'
        }
        return
    }
    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('ChromeParallelDownload-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    try {
        $archive = Join-Path $tempRoot 'aria2.zip'
        $expanded = Join-Path $tempRoot 'expanded'
        Write-Host '正在从 aria2 官方 GitHub 发布页下载引擎……'
        Invoke-WebRequest -Uri $ariaUrl -OutFile $archive
        Expand-Archive -LiteralPath $archive -DestinationPath $expanded
        $source = Get-ChildItem -LiteralPath $expanded -Recurse -Filter aria2c.exe | Select-Object -First 1
        if (-not $source -or (Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash -ne $expectedAriaHash) {
            throw 'aria2 官方文件校验失败，安装已停止。'
        }
        Copy-Item -LiteralPath $source.FullName -Destination $aria
    } finally {
        if ([IO.Directory]::GetParent($tempRoot).FullName -eq [IO.Path]::GetTempPath().TrimEnd('\')) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

$python = Find-Python
Install-Aria2
& $python (Join-Path $native 'build_local64.py')
if ($LASTEXITCODE -ne 0) { throw '生成 64 路下载引擎失败。' }

$utf8 = New-Object System.Text.UTF8Encoding($false)
$manifest = Get-Content -LiteralPath (Join-Path $root 'extension\manifest.json') -Raw | ConvertFrom-Json
$key = [Convert]::FromBase64String($manifest.key)
$sha = [Security.Cryptography.SHA256]::Create()
$hash = $sha.ComputeHash($key)
$id = -join ($hash[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })

$configPath = Join-Path $native 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $secretBytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($secretBytes)
    if ([string]::IsNullOrWhiteSpace($DownloadDir)) {
        $DownloadDir = if (Test-Path -LiteralPath 'D:\') { 'D:\Downloads' } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads' }
    }
    $config = @{port=$port; secret=[Convert]::ToBase64String($secretBytes); download_dir=[IO.Path]::GetFullPath($DownloadDir)}
    [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), $utf8)
}
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Path $config.download_dir -Force | Out-Null

$lines = @('enable-rpc=true', 'rpc-listen-all=false', 'rpc-allow-origin-all=false',
    "rpc-listen-port=$($config.port)", "rpc-secret=$($config.secret)",
    'max-concurrent-downloads=3', 'split=8', 'max-connection-per-server=8', 'min-split-size=1M',
    'file-allocation=none', 'max-tries=3', 'retry-wait=2', 'connect-timeout=15', 'timeout=20',
    'max-download-result=1000', 'auto-save-interval=10', 'summary-interval=0',
    'console-log-level=error', 'quiet=true', 'check-certificate=true', 'no-netrc=true',
    'enable-dht=false', 'enable-peer-exchange=false', 'follow-torrent=false', 'follow-metalink=false')
[IO.File]::WriteAllText((Join-Path $native 'aria2.conf'), (($lines -join "`n") + "`n"), $utf8)

$launcher = '@echo off' + "`r`n" + '"' + $python + '" -u "' + (Join-Path $native 'host.py') + '"' + "`r`n"
[IO.File]::WriteAllText((Join-Path $native 'host.cmd'), $launcher, [Text.Encoding]::Default)
$hostManifest = @{name='local.chrome_parallel_download';description='Local parallel download bridge';
    path=(Join-Path $native 'host.cmd'); type='stdio'; allowed_origins=@("chrome-extension://$id/")}
$hostManifestPath = Join-Path $native 'host-manifest.json'
[IO.File]::WriteAllText($hostManifestPath, ($hostManifest | ConvertTo-Json), $utf8)

if (-not $SkipRegistration) {
    $reg = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\local.chrome_parallel_download'
    New-Item -Path $reg -Force | Out-Null
    Set-Item -Path $reg -Value $hostManifestPath
}
Write-Host "`n本机组件已准备完成。扩展 ID：$id"
Write-Host "在 Chrome 加载这个目录：$(Join-Path $root 'extension')"
Write-Host "下载目录：$($config.download_dir)"
