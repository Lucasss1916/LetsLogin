<#
.SYNOPSIS
  ApexCfgTool — Apex Legends 本地配置 备份/恢复/导出/导入 工具(Windows 原生, 零依赖)

.DESCRIPTION
  Windows PowerShell 5.1 与 PowerShell 7 均可运行;无需安装任何运行时。
  最简用法:双击同目录 Start.bat,按菜单数字操作。
  高级用法(命令行):
    powershell -ExecutionPolicy Bypass -File apex_cfg_tool.ps1 -Action backup
    powershell -ExecutionPolicy Bypass -File apex_cfg_tool.ps1 -Action restore -Path apex-backup-XXXX.zip
    powershell -ExecutionPolicy Bypass -File apex_cfg_tool.ps1 -Action export -Out 我的配置.apexcfg -Label "1.8灵敏度"
    powershell -ExecutionPolicy Bypass -File apex_cfg_tool.ps1 -Action import -Path 队友配置.apexcfg
.NOTES
  双击 .ps1 默认会被记事本打开,请通过 Start.bat 或上面的命令运行。
#>
param(
  [string]$Action = 'menu',     # menu|backup|restore|export|import|list|show|scan
  [string]$Path = '',           # restore: 备份包 / import: 分享文件
  [string]$Dir = '',            # 手动指定 Apex local 配置目录(默认自动检测)
  [string]$Out = '',            # backup: 备份目录 / export: 导出文件
  [string]$Label = '',          # export: 分享标题
  [string]$Note = '',           # export: 备注
  [string]$Filter = '',         # show: 关键字筛选(匹配键名或值,空=全部)
  [int]$Keep = 20,              # backup: 备份保留份数
  [switch]$Force,               # backup: 无变化也强制生成
  [switch]$Yes                  # restore/import 跳过确认(脚本调用用)
)
$ErrorActionPreference = 'Stop'
try { Add-Type -AssemblyName System.IO.Compression -ErrorAction Stop } catch { }
try { Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop } catch { }

$script:ToolVersion = '2.2.0'
$script:FormatVersion = 1
$script:IncludeSuffix = @('.cfg', '.txt', '.ini')
$script:MaxFileBytes = 8MB
$script:MaxTotalBytes = 32MB
$script:MaxFiles = 64
$script:BackupPrefix = 'apex-backup-'
$script:ManifestName = 'manifest.json'
$script:EntryPrefix = 'files/'

# ---------- 基础输出 ----------
function Write-Info([string]$Text) { Write-Host $Text }
function Write-Done([string]$Text) { Write-Host $Text -ForegroundColor Green }
function Write-Warnline([string]$Text) { Write-Host $Text -ForegroundColor Yellow }
function Write-Errline([string]$Text) { Write-Host $Text -ForegroundColor Red }
function Write-Head([string]$Text) {
  $bar = '=' * [Math]::Max(4, 46 - $Text.Length)
  Write-Host ''
  Write-Host ("== {0} {1}" -f $Text, $bar) -ForegroundColor Cyan
}

function Get-UtcIso {
  return ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture) + '+00:00')
}
function Format-Size([double]$Num) {
  if ($Num -ge 1MB) { return ('{0:N1}MB' -f ($Num / 1MB)) }
  if ($Num -ge 1KB) { return ('{0:N1}KB' -f ($Num / 1KB)) }
  return ('{0}B' -f [int]$Num)
}
function Get-Sha256OfBytes([byte[]]$Bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes)) -replace '-', '').ToLower() }
  finally { $sha.Dispose() }
}
function Get-FileSha256([string]$FilePath) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $fs = [System.IO.File]::OpenRead($FilePath)
  try { return ([BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-', '').ToLower() }
  finally { $fs.Dispose(); $sha.Dispose() }
}

# ---------- 配置目录定位 ----------
function Join-ConfigPath([string[]]$Parts) {
  # 跨平台拼接(Windows 反斜杠 / macOS 调试时正斜杠),生产环境始终运行在 Windows
  return [string]::Join([string][System.IO.Path]::DirectorySeparatorChar, $Parts)
}
function Get-UserHome {
  $p = [Environment]::GetFolderPath('UserProfile')
  if (-not $p) { $p = $HOME }
  return $p
}
function Get-CandidateDirs {
  $h = Get-UserHome
  return @(
    (Join-ConfigPath @($h, 'Saved Games', 'Respawn', 'Apex', 'local')),
    (Join-ConfigPath @($h, 'Documents', 'Respawn', 'Apex', 'local')),
    (Join-ConfigPath @($h, 'OneDrive', 'Documents', 'Respawn', 'Apex', 'local'))
  )
}
function Resolve-ApexDir {
  param([string]$Explicit, [bool]$CreateDir)
  if ($Explicit) {
    $full = [System.IO.Path]::GetFullPath(($Explicit -replace '^~', (Get-UserHome)))
    if ($CreateDir) { [void][System.IO.Directory]::CreateDirectory($full) }
    if (-not [System.IO.Directory]::Exists($full)) { throw ("目录不存在: {0}" -f $full) }
    return $full
  }
  $dirs = Get-CandidateDirs
  $found = @($dirs | Where-Object { [System.IO.Directory]::Exists($_) })
  if ($found.Count -gt 0) { return $found[0] }
  if ($CreateDir) {
    $d = $dirs[0]
    [void][System.IO.Directory]::CreateDirectory($d)
    Write-Info ("未找到现有配置目录, 已新建: {0}" -f $d)
    return $d
  }
  throw ("未找到 Apex 配置目录,已尝试:`n  {0}`n请用 -Dir 手动指定" -f (($dirs -join "`n  ")))
}
function Get-BackupsDir {
  param([string]$LocalDir, [string]$OutDir, [bool]$CreateDir)
  $target = if ($OutDir) { $OutDir } else { Join-Path (Split-Path -Parent $LocalDir) 'apex-backups' }
  $full = [System.IO.Path]::GetFullPath($target)
  if ($CreateDir) { [void][System.IO.Directory]::CreateDirectory($full) }
  return $full
}

# ---------- 快照与指纹 ----------
function Get-ConfigFiles([string]$DirPath) {
  $list = @()
  Get-ChildItem -LiteralPath $DirPath -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
    $suffix = [System.IO.Path]::GetExtension($_.Name).ToLower()
    if ($script:IncludeSuffix -contains $suffix) {
      if ($_.Length -gt $script:MaxFileBytes) {
        Write-Warnline ("警告: 跳过过大文件({0}): {1}" -f (Format-Size $_.Length), $_.Name)
      } else {
        $list += $_.FullName
      }
    }
  }
  return ($list | Sort-Object)
}
function New-Snapshot([string]$DirPath) {
  $fullDir = [System.IO.Path]::GetFullPath($DirPath)
  $items = @()
  $total = 0
  foreach ($path in (Get-ConfigFiles $fullDir)) {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $total += $bytes.Length
    if ($total -gt $script:MaxTotalBytes) { throw ("配置文件总体积超过上限 {0}" -f (Format-Size $script:MaxTotalBytes)) }
    $rel = $path.Substring($fullDir.Length).TrimStart('\', '/').Replace('\', '/')
    $items += [pscustomobject]@{ name = $rel; data = $bytes; size = $bytes.Length; sha256 = (Get-Sha256OfBytes $bytes) }
  }
  return , $items
}
function Get-Fingerprint($Items) {
  $lines = ($Items | Sort-Object name | ForEach-Object { "{0}:{1}" -f $_.name, $_.sha256 }) -join "`n"
  return Get-Sha256OfBytes ([System.Text.Encoding]::UTF8.GetBytes($lines))
}
function New-Manifest([string]$Kind, $Items, [string]$Fingerprint) {
  $files = @()
  foreach ($it in $Items) { $files += [ordered]@{ name = $it.name; size = $it.size; sha256 = $it.sha256 } }
  return [ordered]@{
    kind = $Kind
    tool_version = $script:ToolVersion
    created_at = Get-UtcIso
    fingerprint = $Fingerprint
    files = $files
  }
}

# ---------- 备份 zip ----------
function Write-BackupZip {
  param([string]$ZipPath, $Items, $Manifest)
  $tmp = "$ZipPath.tmp"
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
  $zip = [System.IO.Compression.ZipFile]::Open($tmp, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    $entry = $zip.CreateEntry($script:ManifestName)
    $sw = New-Object System.IO.StreamWriter($entry.Open(), (New-Object System.Text.UTF8Encoding($false)))
    try { $sw.Write(($Manifest | ConvertTo-Json -Depth 8)) } finally { $sw.Dispose() }
    foreach ($it in $Items) {
      $fileEntry = $zip.CreateEntry($script:EntryPrefix + $it.name, [System.IO.Compression.CompressionLevel]::Optimal)
      $es = $fileEntry.Open()
      try { $es.Write($it.data, 0, $it.data.Length) } finally { $es.Dispose() }
    }
  }
  finally { $zip.Dispose() }
  Move-Item -LiteralPath $tmp -Destination $ZipPath -Force
}
function Read-ZipManifest([string]$ZipPath) {
  if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) { throw ("文件不存在: {0}" -f $ZipPath) }
  $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    $entry = $zip.GetEntry($script:ManifestName)
    if (-not $entry) { throw '不是本工具生成的备份包(缺少 manifest.json)' }
    $sr = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
    try { $json = $sr.ReadToEnd() } finally { $sr.Dispose() }
  }
  finally { $zip.Dispose() }
  $manifest = $null
  try { $manifest = $json | ConvertFrom-Json } catch { throw ("manifest.json 解析失败: {0}" -f $_.Exception.Message) }
  if ($null -eq $manifest.files) { throw 'manifest.json 缺少 files 字段, 备份可能来自其他工具' }
  return $manifest
}
function Get-NewestBackup([string]$BackupDir) {
  $zips = @(Get-ChildItem -LiteralPath $BackupDir -Filter ($script:BackupPrefix + '*.zip') -File -ErrorAction SilentlyContinue)
  if ($zips.Count -eq 0) { return $null }
  return ($zips | Sort-Object LastWriteTime | Select-Object -Last 1)
}
function Remove-OldBackups {
  param([string]$BackupDir, [int]$Keep)
  $zips = @(Get-ChildItem -LiteralPath $BackupDir -Filter ($script:BackupPrefix + '*.zip') -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)
  $removed = 0
  if ($zips.Count -gt $Keep) {
    foreach ($old in ($zips | Select-Object -First ($zips.Count - $Keep))) {
      Remove-Item -LiteralPath $old.FullName -Force
      $removed++
    }
  }
  return $removed
}
function New-SafetyBackup {
  param([string]$DirPath, [string]$BackupDir, [string]$Tag)
  $items = New-Snapshot $DirPath
  if ($items.Count -eq 0) { return $null }
  $dest = Join-Path $BackupDir ("{0}-{1}.zip" -f $Tag, (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Write-BackupZip -ZipPath $dest -Items $items -Manifest (New-Manifest ("safety:{0}" -f $Tag) $items (Get-Fingerprint $items))
  return $dest
}

# ---------- 安全校验 ----------
function Test-ConfigName([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
  if ($Name -match '\x00') { return $false }
  if ($Name.StartsWith('/') -or $Name.StartsWith('\')) { return $false }
  $parts = @($Name -split '[\\/]')
  if ($parts.Count -gt 4) { return $false }
  foreach ($p in $parts) { if (-not $p -or $p -eq '.' -or $p -eq '..') { return $false } }
  $suffix = [System.IO.Path]::GetExtension($Name).ToLower()
  return ($script:IncludeSuffix -contains $suffix)
}
function ConvertFrom-ShareFiles($FilesObj) {
  if (-not $FilesObj) { throw '分享文件中没有任何配置文件内容' }
  $names = @($FilesObj.PSObject.Properties.Name)
  if ($names.Count -eq 0) { throw '分享文件中没有任何配置文件内容' }
  if ($names.Count -gt $script:MaxFiles) { throw ("文件数量超过上限 {0}" -f $script:MaxFiles) }
  $items = @()
  $total = 0
  foreach ($name in $names) {
    if (-not (Test-ConfigName $name)) { throw ("非法文件名(路径穿越或后缀不在白名单): {0}" -f $name) }
    $meta = $FilesObj.PSObject.Properties[$name].Value
    if (-not $meta -or -not $meta.b64) { throw ("文件 {0} 缺少 b64 内容" -f $name) }
    $bytes = $null
    try { $bytes = [Convert]::FromBase64String([string]$meta.b64) } catch { throw ("文件 {0} 的 base64 内容无效" -f $name) }
    if ($bytes.Length -gt $script:MaxFileBytes) { throw ("文件 {0} 超过单文件上限 {1}" -f $name, (Format-Size $script:MaxFileBytes)) }
    $total += $bytes.Length
    if ($total -gt $script:MaxTotalBytes) { throw ("解码后总体积超过上限 {0}" -f (Format-Size $script:MaxTotalBytes)) }
    $actual = Get-Sha256OfBytes $bytes
    if ($meta.sha256 -and ([string]$meta.sha256).ToLower() -ne $actual) { throw ("文件 {0} 校验失败: hash 与内容不一致" -f $name) }
    $items += [pscustomobject]@{ name = $name; data = $bytes; size = $bytes.Length; sha256 = $actual }
  }
  return , $items
}
function Read-ShareFile([string]$SharePath) {
  if (-not (Test-Path -LiteralPath $SharePath -PathType Leaf)) { throw ("文件不存在: {0}" -f $SharePath) }
  $json = [System.IO.File]::ReadAllText($SharePath, [System.Text.Encoding]::UTF8)
  $share = $null
  try { $share = $json | ConvertFrom-Json } catch { throw ("分享文件不是有效 JSON: {0}" -f $_.Exception.Message) }
  if ($share.kind -ne 'apexcfg' -or $share.format -ne $script:FormatVersion) { throw '不支持的分享格式(kind/format 不符), 请让对方更新工具后重新导出' }
  return $share
}
function Write-SnapshotTo {
  param([string]$DirPath, $Items)
  $written = @()
  $identical = @()
  foreach ($it in $Items) {
    $dest = Join-Path $DirPath ($it.name -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($dest))
    $needWrite = $true
    if ([System.IO.File]::Exists($dest)) {
      $fi = Get-Item -LiteralPath $dest
      if ($fi.Length -eq $it.size -and ((Get-FileSha256 $dest) -eq $it.sha256)) { $needWrite = $false }
    }
    if (-not $needWrite) { $identical += $it.name; continue }
    $tmp = "$dest.tmp-apex"
    [System.IO.File]::WriteAllBytes($tmp, $it.data)
    Move-Item -LiteralPath $tmp -Destination $dest -Force
    if ((Get-FileSha256 $dest) -ne $it.sha256) { throw ("写入后校验失败, 文件可能异常: {0}" -f $dest) }
    $written += $it.name
  }
  return @{ written = $written; identical = $identical }
}

# ---------- 宽容解析(仅用于预览) ----------
function Get-FilePairs([string]$Text) {
  # 兼容三种键值风格: "key" "value" / key value / bind xx → 也识别;按出现顺序,后值覆盖前值
  $pairs = [ordered]@{}
  foreach ($m in [regex]::Matches($Text, '"([^"\r\n]+)"\s+"([^"\r\n]*)"')) {
    $pairs[$m.Groups[1].Value.Trim()] = $m.Groups[2].Value.Trim()
  }
  foreach ($line in ($Text -split "`r?`n")) {
    if ($line -match '^\s*([A-Za-z0-9_.-]+)\s+(-?[A-Za-z0-9_.]+)\s*$') {
      $k = $Matches[1].Trim()
      if (-not $pairs.Contains($k)) { $pairs[$k] = $Matches[2].Trim() }
    }
  }
  return $pairs
}
function New-Preview($Items) {
  $sensitivity = [ordered]@{}
  $video = [ordered]@{}
  $binds = 0
  $filePairs = @()
  foreach ($it in $Items) {
    $text = [System.Text.Encoding]::UTF8.GetString($it.data)
    $pairs = Get-FilePairs $text
    $rows = @()
    foreach ($k in $pairs.Keys) {
      $low = $k.ToLower()
      if ($low.Contains('bind') -and $low -ne 'bind') { $binds++ }
      if ($low.Contains('sens')) { $sensitivity[$low] = [string]$pairs[$k] }
      if ($low.Contains('defaultres') -or @('setting.fullscreen', 'aspectratiowithletterbox') -contains $low) { $video[$low] = [string]$pairs[$k] }
      if ($rows.Count -lt 800) {
        $rows += , @($k.Substring(0, [Math]::Min(80, $k.Length)), ([string]$pairs[$k]).Substring(0, [Math]::Min(120, ([string]$pairs[$k]).Length)))
      }
    }
    # 裸 bind 命令行(如: bind w +forward)按行计数,键会收敛为同一个 'bind'
    $binds += ([regex]::Matches($text, '(?im)^\s*bind\b')).Count
    $filePairs += [ordered]@{ name = $it.name; rows = $rows }
  }
  $fileNames = @($Items | ForEach-Object { $_.name })
  return [pscustomobject]@{
    sensitivity = [pscustomobject]$sensitivity
    video = [pscustomobject]$video
    binds_count = $binds
    files = $fileNames
    file_pairs = $filePairs
  }
}
function Show-Preview($Preview) {
  $sensProps = @($Preview.sensitivity.PSObject.Properties)
  if ($sensProps.Count -gt 0) {
    Write-Info '灵敏度相关:'
    foreach ($p in $sensProps) { Write-Info ("  {0} = {1}" -f $p.Name, $p.Value) }
  }
  $videoProps = @($Preview.video.PSObject.Properties)
  if ($videoProps.Count -gt 0) {
    Write-Info '画质/分辨率相关:'
    foreach ($p in $videoProps) { Write-Info ("  {0} = {1}" -f $p.Name, $p.Value) }
  }
  Write-Info ("键位(binds)条目: {0}" -f $Preview.binds_count)
}
function Show-DetailRows {
  param([string]$Title, $Rows, [string]$Filter)
  if ($Rows.Count -eq 0) { return }
  $shown = @()
  foreach ($r in $Rows) {
    if ($Filter -and -not (($r[0] -like "*$Filter*") -or ($r[1] -like "*$Filter*"))) { continue }
    $shown += , $r
  }
  if ($shown.Count -eq 0) {
    if ($Filter) { return }   # 筛选模式下隐藏无匹配的分组, 输出更干净
    Write-Info ("{0}: (空)" -f $Title)
    return
  }
  Write-Info ("{0} ({1} 项):" -f $Title, $shown.Count)
  foreach ($r in $shown) { Write-Info ("  {0} = {1}" -f $r[0], $r[1]) }
}
function Show-VerbosePreview {
  param($Items, [string]$Filter)
  foreach ($it in $Items) {
    $text = [System.Text.Encoding]::UTF8.GetString($it.data)
    $pairs = Get-FilePairs $text
    $isVideo = ($it.name -match 'videoconfig')
    $bindRows = @(); $sensRows = @(); $restRows = @(); $allRows = @()
    foreach ($k in $pairs.Keys) {
      $low = $k.ToLower()
      $row = @([string]$k, [string]$pairs[$k])
      if ($isVideo) { $allRows += , $row; continue }
      if ($low.Contains('bind')) { $bindRows += , $row }
      elseif ($low.Contains('sens')) { $sensRows += , $row }
      else { $restRows += , $row }
    }
    if ($isVideo) {
      Write-Head ("画质 / 视频设置 — {0}" -f $it.name)
      Show-DetailRows -Title '全部设置' -Rows $allRows -Filter $Filter
    }
    else {
      Write-Head ("配置明细 — {0}" -f $it.name)
      Show-DetailRows -Title '键位 / 绑定(bind)' -Rows $bindRows -Filter $Filter
      Show-DetailRows -Title '灵敏度' -Rows $sensRows -Filter $Filter
      Show-DetailRows -Title '其他设置' -Rows $restRows -Filter $Filter
    }
  }
}

# ---------- 各命令 ----------
function Invoke-Scan([string]$Dir) {
  Write-Head '候选配置目录'
  $selected = $null
  foreach ($c in (Get-CandidateDirs)) {
    $mark = if ([System.IO.Directory]::Exists($c)) { '√' } else { '×' }
    Write-Info (" [{0}] {1}" -f $mark, $c)
    if ($mark -eq '√' -and -not $selected) { $selected = $c }
  }
  Write-Head '选择结果'
  if (-not $selected -and $Dir) { $selected = (Resolve-ApexDir -Explicit $Dir -CreateDir $false) }
  if (-not $selected) { Write-Info '未找到, 请用 -Dir 指定'; return }
  $items = New-Snapshot $selected
  $total = 0
  foreach ($it in $items) { $total += $it.size }
  Write-Info ("当前使用: {0}" -f $selected)
  foreach ($it in $items) { Write-Info ("  {0}  {1}" -f $it.name.PadRight(28), (Format-Size $it.size)) }
  Write-Info ("合计 {0} 个文件, {1}" -f $items.Count, (Format-Size $total))
}
function Invoke-Show {
  param([string]$Dir, [string]$Filter)
  $dirPath = Resolve-ApexDir -Explicit $Dir -CreateDir $false
  $items = New-Snapshot $dirPath
  if ($items.Count -eq 0) { throw ("目录中没有可识别的配置文件({0}): {1}" -f ($script:IncludeSuffix -join '/'), $dirPath) }
  Write-Head ("当前配置概览 {0}" -f $dirPath)
  Show-Preview (New-Preview $items)
  if ($Filter) { Write-Info ("(关键字筛选: {0})" -f $Filter) }
  Write-Info ''
  Show-VerbosePreview -Items $items -Filter $Filter
}
function Invoke-Backup {
  param([string]$Dir, [string]$OutDir, [int]$Keep, [bool]$ForceFlag)
  $dirPath = Resolve-ApexDir -Explicit $Dir -CreateDir $false
  $items = New-Snapshot $dirPath
  if ($items.Count -eq 0) { throw ("目录中没有可识别的配置文件: {0}" -f $dirPath) }
  Write-Head '备份当前配置'

  $backupDir = Get-BackupsDir -LocalDir $dirPath -OutDir $OutDir -CreateDir $true
  $fingerprint = Get-Fingerprint $items
  $newest = Get-NewestBackup $backupDir
  if ($newest -and -not $ForceFlag) {
    $manifest = Read-ZipManifest $newest.FullName
    if ([string]$manifest.fingerprint -eq $fingerprint) {
      Write-Done ("配置无变化, 跳过备份(与 {0} 相同)! 需强制请加 -Force" -f $newest.Name)
      return
    }
  }
  $dest = Join-Path $backupDir (($script:BackupPrefix) + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
  $serial = 2
  while (Test-Path -LiteralPath $dest) {
    $dest = Join-Path $backupDir ("{0}{1}-{2}.zip" -f $script:BackupPrefix, (Get-Date -Format 'yyyyMMdd-HHmmss'), $serial)
    $serial++
  }
  Write-BackupZip -ZipPath $dest -Items $items -Manifest (New-Manifest 'backup' $items $fingerprint)
  $removed = Remove-OldBackups -BackupDir $backupDir -Keep $Keep
  $raw = 0
  foreach ($it in $items) { $raw += $it.size }
  Write-Done ("备份完成: {0}" -f $dest)
  Write-Info ("  文件 {0} 个, 原始 {1}" -f $items.Count, (Format-Size $raw))
  Write-Info ("  指纹 {0}  轮转清理 {1} 份旧备份" -f $fingerprint.Substring(0, 12), $removed)
}
function Invoke-List([string]$Dir) {
  $dirPath = Resolve-ApexDir -Explicit $Dir -CreateDir $false
  $backupDir = Get-BackupsDir -LocalDir $dirPath -OutDir $null -CreateDir $false
  $zips = @(Get-ChildItem -LiteralPath $backupDir -Filter '*.zip' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)
  if ($zips.Count -eq 0) { Write-Info ("暂无备份: {0}" -f $backupDir); return }
  Write-Head ("备份列表 {0}" -f $backupDir)
  $i = 0
  foreach ($zp in $zips) {
    $i++
    try {
      $m = Read-ZipManifest $zp.FullName
      $count = @($m.files).Count
      $created = $m.created_at
      if ($created -is [datetime]) { $created = ('{0:yyyy-MM-dd HH:mm:ss}' -f $created) } else { $created = ([string]$created).Replace('T', ' ') }
      Write-Info (" [{0}] {1}" -f $i, $zp.Name)
      Write-Info ("      {0} · {1} 个文件 · {2} · {3}" -f $created, $count, (Format-Size $zp.Length), $m.kind)
    }
    catch {
      Write-Info (" [{0}] {1}  <无法解析>" -f $i, $zp.Name)
      Write-Info ("      {0}" -f $_.Exception.Message)
    }
  }
}
function Invoke-Restore {
  param([string]$ZipPath, [string]$Dir, [bool]$AssumeYes)
  if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) { throw ("文件不存在: {0}" -f $ZipPath) }
  $manifest = Read-ZipManifest $ZipPath
  $files = @($manifest.files)
  Write-Head ("恢复预览 {0} ({1} 个文件)" -f [System.IO.Path]::GetFileName($ZipPath), $files.Count)
  foreach ($f in $files) { Write-Info ("  {0}  {1}" -f $f.name, (Format-Size ([int64]$f.size))) }
  if ($files.Count -eq 0) { Write-Info '备份内容为空, 无需恢复'; return }
  if (-not $AssumeYes) {
    $answer = Read-Host '确认恢复到当前配置目录? (y/N)'
    if ($answer -notmatch '^[yY]') { Write-Info '已取消'; return }
  }
  $dirPath = Resolve-ApexDir -Explicit $Dir -CreateDir ([bool]$Dir)
  $backupDir = Get-BackupsDir -LocalDir $dirPath -OutDir $null -CreateDir $true

  # 逐条目读取并校验(manifest 为准, 忽略未知条目)
  $items = @()
  $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    foreach ($f in $files) {
      if (-not (Test-ConfigName $f.name)) { throw ("备份内出现非法文件名: {0}" -f $f.name) }
      $entry = $zip.GetEntry($script:EntryPrefix + $f.name)
      if (-not $entry) { throw ("备份损坏: 缺少文件 {0}" -f $f.name) }
      $ms = New-Object System.IO.MemoryStream
      $es = $entry.Open()
      try { $es.CopyTo($ms) } finally { $es.Dispose() }
      $bytes = $ms.ToArray()
      $ms.Dispose()
      $actual = Get-Sha256OfBytes $bytes
      if ($f.sha256 -and $actual -ne ([string]$f.sha256).ToLower()) { throw ("备份校验失败: {0}" -f $f.name) }
      $items += [pscustomobject]@{ name = $f.name; data = $bytes; size = $bytes.Length; sha256 = $actual }
    }
  }
  finally { $zip.Dispose() }

  $safety = New-SafetyBackup -DirPath $dirPath -BackupDir $backupDir -Tag 'pre-restore'
  if ($safety) { Write-Info ("已生成安全包: {0}" -f $safety) } else { Write-Info '当前目录为空, 无需安全包' }

  $result = Write-SnapshotTo -DirPath $dirPath -Items $items
  Write-Done ("恢复完成: 覆盖 {0} 个文件, 未变化 {1} 个" -f @($result.written).Count, @($result.identical).Count)
  Write-Info '提示: 如需回滚, 用 list 找到刚才的安全包再执行 restore'
}
function Invoke-Export {
  param([string]$Dir, [string]$OutFile, [string]$Label, [string]$Note)
  $dirPath = Resolve-ApexDir -Explicit $Dir -CreateDir $false
  $items = New-Snapshot $dirPath
  if ($items.Count -eq 0) { throw ("目录中没有可识别的配置文件: {0}" -f $dirPath) }
  Write-Head '导出分享文件'

  $files = [ordered]@{}
  foreach ($it in $items) {
    $files[$it.name] = [ordered]@{ b64 = [Convert]::ToBase64String($it.data); sha256 = $it.sha256 }
  }
  if (-not $OutFile) { $OutFile = "apex-export-{0}.apexcfg" -f (Get-Date -Format 'yyyyMMdd-HHmmss') }
  if (-not $Label) { $Label = "Apex 配置 {0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss') }
  $payload = [ordered]@{
    kind = 'apexcfg'
    format = $script:FormatVersion
    tool_version = $script:ToolVersion
    game = 'Apex Legends'
    created_at = Get-UtcIso
    label = $Label
    note = $Note
    preview = (New-Preview $items)
    files = $files
  }
  $json = $payload | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($OutFile, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
  $full = [System.IO.Path]::GetFullPath($OutFile)
  Write-Done ("{0}  ({1})" -f $full, (Format-Size ([System.IO.FileInfo]::new($full).Length)))
  Write-Info ("  标签: {0}" -f $Label)
  Show-Preview (New-Preview $items)
  Write-Info '分享方式: 直接把该文件发给朋友, 或在网页「Apex 配置」面板发布到分享广场'
}
function Invoke-Import {
  param([string]$SharePath, [string]$Dir, [bool]$AssumeYes)
  $share = Read-ShareFile $SharePath
  $items = ConvertFrom-ShareFiles $share.files

  Write-Head ("导入预览 {0}" -f [System.IO.Path]::GetFileName($SharePath))
  Write-Info ("标签: {0}  来源时间: {1}" -f ([string]$share.label), ([string]$share.created_at))
  if ([string]$share.note) { Write-Info ("备注: {0}" -f ([string]$share.note)) }
  if ($share.preview) { Show-Preview $share.preview } else { Show-Preview (New-Preview $items) }
  if (-not $AssumeYes) {
    $answer = Read-Host '确认应用该配置? (y/N)'
    if ($answer -notmatch '^[yY]') { Write-Info '已取消'; return }
  }

  $dirPath = Resolve-ApexDir -Explicit $Dir -CreateDir $true
  $backupDir = Get-BackupsDir -LocalDir $dirPath -OutDir $null -CreateDir $true
  $safety = New-SafetyBackup -DirPath $dirPath -BackupDir $backupDir -Tag 'pre-import'
  if ($safety) { Write-Info ("已生成安全包: {0}" -f $safety) } else { Write-Info '原目录为空, 无需安全包' }

  $result = Write-SnapshotTo -DirPath $dirPath -Items $items
  Write-Done ("应用完成: 写入 {0} 个文件, 已一致 {1} 个" -f @($result.written).Count, @($result.identical).Count)
  Write-Info '提示: 重启 Apex 生效; 回滚请用 list 找到上面的安全包执行 restore'
}
function Show-Menu {
  param([string]$Dir, [string]$OutDir, [int]$Keep, [bool]$ForceFlag)
  while ($true) {
    Write-Host ''
    Write-Host ('======== Apex 配置工具 v{0} ========' -f $script:ToolVersion) -ForegroundColor Cyan
    Write-Info ' [1] 备份当前配置        [2] 查看备份列表'
    Write-Info ' [3] 恢复备份            [4] 导出分享文件(.apexcfg)'
    Write-Info ' [5] 导入分享文件        [6] 查看当前设置'
    Write-Info ' [7] 重新扫描配置目录    [0] 退出'
    $choice = Read-Host '请选择'
    try {
      switch ($choice) {
        '1' { Invoke-Backup -Dir $Dir -OutDir $OutDir -Keep $Keep -ForceFlag $ForceFlag }
        '2' { Invoke-List -Dir $Dir }
        '3' { $zp = Read-Host '备份包路径'; Invoke-Restore -ZipPath $zp -Dir $Dir -AssumeYes $false }
        '4' { $lb = Read-Host '标签(可回车)'; $nt = Read-Host '备注(可回车)'; Invoke-Export -Dir $Dir -OutFile '' -Label $lb -Note $nt }
        '5' { $sp = Read-Host '分享文件路径'; Invoke-Import -SharePath $sp -Dir $Dir -AssumeYes $false }
        '6' { $kw = Read-Host '筛选关键字(可回车看全部)'; Invoke-Show -Dir $Dir -Filter $kw }
        '7' { Invoke-Scan -Dir $Dir }
        '0' { return }
        default { Write-Info '无效选择' }
      }
    }
    catch { Write-Errline ("错误: {0}" -f $_.Exception.Message) }
  }
}

# ---------- 入口 ----------

try {
  $cmd = $Action.ToLower()
  switch ($cmd) {
    'menu'    { Show-Menu -Dir $Dir -OutDir $Out -Keep $Keep -ForceFlag ([bool]$Force) }
    'backup'  { Invoke-Backup -Dir $Dir -OutDir $Out -Keep $Keep -ForceFlag ([bool]$Force) }
    'list'    { Invoke-List -Dir $Dir }
    'restore' {
      if (-not $Path) { throw 'restore 需要 -Path 备份包路径' }
      Invoke-Restore -ZipPath $Path -Dir $Dir -AssumeYes ([bool]$Yes)
    }
    'export'  { Invoke-Export -Dir $Dir -OutFile $Out -Label $Label -Note $Note }
    'import'  {
      if (-not $Path) { throw 'import 需要 -Path 分享文件路径' }
      Invoke-Import -SharePath $Path -Dir $Dir -AssumeYes ([bool]$Yes)
    }
    'show'    { Invoke-Show -Dir $Dir -Filter $Filter }
    'scan'    { Invoke-Scan -Dir $Dir }
    default   { throw ("未知 -Action: {0}" -f $Action) }
  }
}
catch {
  Write-Errline ("错误: {0}" -f $_.Exception.Message)
  exit 1
}
