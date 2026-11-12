# dsh-notification - bring the DSH window back to the foreground (Windows).
#
# Invoked by the host when a browser notification is clicked in the DSH Web UI.
# ASCII-only: Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page.
#
# The desktop app cannot be asked directly: the plugin runs in a child process of
# the Electron main process, which owns the window. So the window is found here:
#   1. walk up the process tree and take the first ancestor with a visible main
#      window THAT RUNS THE SAME EXECUTABLE AS THE DSH HOST (-HostExe). The
#      executable check is what keeps `dsh web` in a terminal from raising the
#      terminal: the Electron main process is the host's parent, a terminal is
#      only the host's ancestor when the host itself is not the app;
#   2. fall back to a visible window whose title contains -WindowTitle (the
#      desktop app's window title always ends with " - DeepSeek Harness").
# Then restore if minimized and force the foreground. SetForegroundWindow is
# refused while another app owns the foreground lock, so a synthetic ALT tap
# makes the next attempt succeed.
#
# Exit codes: 0 focused, 2 no DSH window on this desktop, 3 refused by Windows.
param(
  [string]$WindowTitle = 'DeepSeek Harness',
  [string]$HostExe = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -Namespace DshNotification -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'@

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

$hwnd = [IntPtr]::Zero
$ownerPid = 0
if ($HostExe -ne '') {
  foreach ($id in (Get-AncestorIds)) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.MainWindowHandle -eq 0) { continue }
    try {
      if ($proc.Path -ine $HostExe) { continue }
    } catch { continue }
    if ([DshNotification.Win]::IsWindowVisible($proc.MainWindowHandle)) {
      $hwnd = $proc.MainWindowHandle
      $ownerPid = $proc.Id
      break
    }
  }
}

if ($hwnd -eq [IntPtr]::Zero -and $WindowTitle -ne '') {
  $match = Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and $_.MainWindowTitle -like "*$WindowTitle*"
  } | Select-Object -First 1
  if ($match) {
    $hwnd = $match.MainWindowHandle
    $ownerPid = $match.Id
  }
}

if ($hwnd -eq [IntPtr]::Zero) {
  Write-Output 'focus skipped: no DSH window on this desktop'
  exit 2
}

[void][DshNotification.Win]::ShowWindow($hwnd, 9)  # SW_RESTORE

$attempts = 0
$focused = $false
while ($attempts -lt 4 -and -not $focused) {
  $attempts++
  if ([DshNotification.Win]::IsIconic($hwnd)) { [void][DshNotification.Win]::ShowWindow($hwnd, 9) }
  [void][DshNotification.Win]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 80
  if ([DshNotification.Win]::GetForegroundWindow() -eq $hwnd) {
    $focused = $true
    break
  }
  [DshNotification.Win]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [DshNotification.Win]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
}

if ($focused) {
  Write-Output ('focus ok hwnd=' + $hwnd.ToInt64() + ' pid=' + $ownerPid + ' attempts=' + $attempts)
} else {
  Write-Output ('focus refused hwnd=' + $hwnd.ToInt64() + ' pid=' + $ownerPid)
  exit 3
}
