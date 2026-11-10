# dsh-notification - Windows toast sender (Windows PowerShell 5.1 + WinRT).
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less script in the
# ANSI code page, while the UTF-16 process arguments carry any language's title
# and body safely.
#
# Prints "toast shown ..." only after ToastNotificationManager.Show() returned,
# so the host can tell a real delivery from a silent no-op. Any failure exits
# non-zero with the reason on stderr, which the host writes to
# %TEMP%\dsh-notification\notify.log.
#
# The AppUserModelId only decides identity (name and icon in Action Center); it
# does not gate delivery on Windows 11 26100 (measured). Toasts belong to the
# app that sends them, so the identity is taken from the desktop app itself:
# walk up to the ancestor process that owns a window AND runs the same
# executable as the dsh host (-HostExe), then read its Start Menu shortcut's
# System.AppUserModel.ID (e.g. electron.app.DeepSeek Harness).  When the host is
# not the desktop app - `dsh web` in a terminal - no ancestor matches, the
# shim's own identity is never adopted (a terminal or editor would brand the
# toast as itself), and the display title is used instead.
param(
  [string]$Title = 'DeepSeek Harness',
  [string]$Body = '',
  [string]$AppId = '',
  [string]$HostExe = ''
)

$ErrorActionPreference = 'Stop'
# The host reads this script's stdout/stderr as UTF-8, so both streams must be
# UTF-8 regardless of the machine's console code page (Chinese titles, etc.).
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Get-AncestorIds {
  $parents = @{}
  foreach ($proc in (Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId -ErrorAction SilentlyContinue)) {
    $parents[[int]$proc.ProcessId] = [int]$proc.ParentProcessId
  }
  $ids = New-Object System.Collections.Generic.List[int]
  $current = $PID
  for ($i = 0; $i -lt 12 -and $current -gt 0; $i++) {
    $ids.Add($current)
    if (-not $parents.ContainsKey($current)) { break }
    $current = $parents[$current]
  }
  return $ids
}

# The desktop app's window belongs to an ancestor of this PowerShell, and that
# ancestor runs the same executable as the dsh host, so both checks together
# identify it without a window handshake. A terminal or editor that merely
# launched `dsh web` never matches.
function Get-DesktopAppPath {
  if ($HostExe -eq '') { return '' }
  foreach ($id in (Get-AncestorIds)) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.MainWindowHandle -eq 0) { continue }
    try {
      if ($proc.Path -ieq $HostExe) { return $proc.Path }
    } catch { continue }
  }
  return ''
}

function Get-ShortcutAppId([string]$ExePath) {
  if ($ExePath -eq '') { return '' }
  $shell = New-Object -ComObject Shell.Application
  $shortcuts = New-Object -ComObject WScript.Shell
  $roots = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
  )
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($lnk in (Get-ChildItem $root -Recurse -Filter *.lnk -ErrorAction SilentlyContinue)) {
      try { $target = $shortcuts.CreateShortcut($lnk.FullName).TargetPath } catch { continue }
      if (-not $target -or $target -ine $ExePath) { continue }
      try {
        $item = $shell.Namespace($lnk.DirectoryName).ParseName($lnk.Name)
        $appId = $item.ExtendedProperty('System.AppUserModel.ID')
        if ($appId) { return [string]$appId }
      } catch { continue }
    }
  }
  return ''
}

function Resolve-AppId {
  if ($AppId -ne '') { return $AppId }
  try {
    $appExe = Get-DesktopAppPath
    if ($appExe -ne '') {
      $registered = Get-ShortcutAppId $appExe
      if ($registered -ne '') { return $registered }
    }
  } catch {
    # Identity detection is a nicety, never a reason to skip the notification.
  }
  return $Title
}

try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

  $toastXml = '<toast><visual><binding template="ToastGeneric"><text>' +
    [System.Security.SecurityElement]::Escape($Title) + '</text><text>' +
    [System.Security.SecurityElement]::Escape($Body) + '</text></binding></visual>' +
    '<audio src="ms-winsoundevent:Notification.Default"/></toast>'
  $document = New-Object Windows.Data.Xml.Dom.XmlDocument
  $document.LoadXml($toastXml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $document

  $resolved = Resolve-AppId
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($resolved).Show($toast)
  Write-Output ('toast shown appid=' + $resolved)
} catch {
  [Console]::Error.WriteLine('toast failed: ' + $_.Exception.Message)
  exit 1
}
