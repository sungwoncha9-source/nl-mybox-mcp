$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# nodelab file-mover v1.5 screen capture. capture.js passes work via env vars and reads one JSON line back. ASCII only on purpose (run with -File).
#   CAP_MODE=info     : print monitor list and virtual screen size
#   CAP_MODE=shot     : save CAP_X,CAP_Y,CAP_W,CAP_H (absolute desktop px) to CAP_OUT as PNG
#   CAP_MODE=win_list : print visible top-level windows (front first)
#   CAP_MODE=win_shot : save window CAP_HWND to CAP_OUT as PNG (PrintWindow for occluded ones; minimized only restored when CAP_RESTORE=1)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NlDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
public static class NlWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  public static string Title(IntPtr h) {
    int n = GetWindowTextLengthW(h);
    if (n <= 0) return "";
    StringBuilder sb = new StringBuilder(n + 2);
    GetWindowTextW(h, sb, sb.Capacity);
    return sb.ToString();
  }
}
'@

$isWinMode = ($env:CAP_MODE -eq 'win_list') -or ($env:CAP_MODE -eq 'win_shot')
if ($isWinMode) {
  # per-monitor DPI awareness so window rects are real pixels (falls back to system-aware)
  $ok = $false
  try { $ok = [NlWin]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch { }
  if (-not $ok) { [void][NlDpi]::SetProcessDPIAware() }
  # window titles can be non-ASCII: force UTF-8 stdout (default is the OEM code page)
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
}
else { [void][NlDpi]::SetProcessDPIAware() }

function Out-NlJson($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 6)) }

#region NlRegion
# region inside a window; same rules as planRegion in capture.js (cross-checked by tests).
# units: 'px' or ratio. Window top-left is 0. Returns x,y,w,h or $null (outside the window).
function Get-NlRegion($W, $H, $units, $rx, $ry, $rw, $rh) {
  if ($units -eq 'px') { $fx = $rx; $fy = $ry; $fw = $rw; $fh = $rh }
  else { $fx = $rx * $W; $fy = $ry * $H; $fw = $rw * $W; $fh = $rh * $H }
  $mp = [MidpointRounding]::AwayFromZero
  $x0 = [Math]::Max(0, [Math]::Round($fx, $mp)); $y0 = [Math]::Max(0, [Math]::Round($fy, $mp))
  $x1 = [Math]::Min($W, [Math]::Round($fx + $fw, $mp)); $y1 = [Math]::Min($H, [Math]::Round($fy + $fh, $mp))
  if (($x1 - $x0) -lt 1 -or ($y1 - $y0) -lt 1) { return $null }
  return @{ x = [int]$x0; y = [int]$y0; w = [int]($x1 - $x0); h = [int]($y1 - $y0) }
}
#endregion

if ($env:CAP_MODE -eq 'info') {
  $v = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $list = @()
  $i = 0
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $i++
    $list += [pscustomobject]@{ index = $i; x = $s.Bounds.X; y = $s.Bounds.Y; w = $s.Bounds.Width; h = $s.Bounds.Height; primary = [bool]$s.Primary }
  }
  $o = [pscustomobject]@{ virtual = [pscustomobject]@{ x = $v.X; y = $v.Y; w = $v.Width; h = $v.Height }; displays = @($list) }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 5))
}
elseif ($env:CAP_MODE -eq 'shot') {
  $x = [int]$env:CAP_X
  $y = [int]$env:CAP_Y
  $w = [int]$env:CAP_W
  $h = [int]$env:CAP_H
  if ($w -lt 1 -or $h -lt 1) { throw 'bad size' }
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      try {
        $op = [System.Drawing.CopyPixelOperation]::SourceCopy -bor [System.Drawing.CopyPixelOperation]::CaptureBlt
        $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size, $op)
      }
      catch {
        $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
      }
    }
    finally { $g.Dispose() }
    $bmp.Save($env:CAP_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
  }
  finally { $bmp.Dispose() }
  [Console]::Out.WriteLine('{"ok":true}')
}
elseif ($env:CAP_MODE -eq 'win_list') {
  $procNames = @{}
  $fg = [NlWin]::GetForegroundWindow()
  $out = New-Object System.Collections.ArrayList
  $h = [NlWin]::GetTopWindow([IntPtr]::Zero)
  $z = 0
  $guard = 0
  while ($h -ne [IntPtr]::Zero -and $guard -lt 5000) {
    $guard++
    if ([NlWin]::IsWindowVisible($h)) {
      $title = [NlWin]::Title($h)
      $ex = [NlWin]::GetWindowLongW($h, -20)
      $isTool = (($ex -band 0x80) -ne 0) -and (($ex -band 0x40000) -eq 0)   # skip tool windows
      if ($title.Length -gt 0 -and -not $isTool) {
        $z++
        $procId = [uint32]0
        [void][NlWin]::GetWindowThreadProcessId($h, [ref]$procId)
        if (-not $procNames.ContainsKey([int]$procId)) {
          $nm = ''
          try { $nm = (Get-Process -Id ([int]$procId) -ErrorAction Stop).ProcessName } catch { }
          $procNames[[int]$procId] = $nm
        }
        $r = New-Object 'NlWin+RECT'
        $okRect = $false
        if (-not [NlWin]::IsIconic($h)) { $okRect = ([NlWin]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -eq 0) }
        if (-not $okRect) { [void][NlWin]::GetWindowRect($h, [ref]$r) }
        $cl = 0
        [void][NlWin]::DwmGetWindowAttribute($h, 14, [ref]$cl, 4)
        $owner = [NlWin]::GetWindow($h, 4)
        [void]$out.Add([pscustomobject]@{
          hwnd = [string]([Int64]$h); title = $title; process = $procNames[[int]$procId]; pid = [int]$procId
          x = $r.Left; y = $r.Top; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top)
          minimized = [bool][NlWin]::IsIconic($h); cloaked = ($cl -ne 0); owned = ($owner -ne [IntPtr]::Zero)
          foreground = ($h -eq $fg); z = $z
        })
      }
    }
    $h = [NlWin]::GetWindow($h, 2)
  }
  Out-NlJson ([pscustomobject]@{ windows = @($out) })
}
elseif ($env:CAP_MODE -eq 'win_shot') {
  $hwnd = [IntPtr][Int64]$env:CAP_HWND
  $method = if ($env:CAP_METHOD) { $env:CAP_METHOD } else { 'auto' }
  $settle = if ($env:CAP_SETTLE) { [int]$env:CAP_SETTLE } else { 500 }
  $warn = New-Object System.Collections.ArrayList
  if (-not [NlWin]::IsWindow($hwnd)) { Out-NlJson @{ ok = $false; code = 'window_gone'; message = 'window no longer exists' }; exit 0 }
  $restored = $false; $activated = $false; $fallback = $false; $used = ''; $occ = $null
  try {
    if ([NlWin]::IsIconic($hwnd)) {
      if ($env:CAP_RESTORE -ne '1') { Out-NlJson @{ ok = $false; code = 'window_minimized'; message = 'window is minimized' }; exit 0 }
      [void][NlWin]::ShowWindow($hwnd, 4)          # SW_SHOWNOACTIVATE: restore without taking focus
      $restored = $true
      for ($i = 0; $i -lt 20 -and [NlWin]::IsIconic($hwnd); $i++) { Start-Sleep -Milliseconds 100 }
      if ([NlWin]::IsIconic($hwnd)) { Out-NlJson @{ ok = $false; code = 'window_minimized'; message = 'restore failed' }; exit 0 }
      Start-Sleep -Milliseconds $settle
    }
    if ($env:CAP_ACTIVATE -eq '1') {
      [void][NlWin]::SetForegroundWindow($hwnd)
      Start-Sleep -Milliseconds 300
      $activated = ([NlWin]::GetForegroundWindow() -eq $hwnd)
      if (-not $activated) { [void]$warn.Add('activate_failed') }
    }
    $wr = New-Object 'NlWin+RECT'
    [void][NlWin]::GetWindowRect($hwnd, [ref]$wr)
    $fr = New-Object 'NlWin+RECT'
    if ([NlWin]::DwmGetWindowAttribute($hwnd, 9, [ref]$fr, 16) -ne 0) { $fr = $wr }
    $area = $fr
    if ($env:CAP_CLIENT -eq '1') {
      $cr = New-Object 'NlWin+RECT'
      [void][NlWin]::GetClientRect($hwnd, [ref]$cr)
      $pt = New-Object 'NlWin+POINT'
      [void][NlWin]::ClientToScreen($hwnd, [ref]$pt)
      $area = New-Object 'NlWin+RECT'
      $area.Left = $pt.X; $area.Top = $pt.Y; $area.Right = $pt.X + ($cr.Right - $cr.Left); $area.Bottom = $pt.Y + ($cr.Bottom - $cr.Top)
    }
    $aw = $area.Right - $area.Left; $ah = $area.Bottom - $area.Top
    if ($aw -lt 2 -or $ah -lt 2) { Out-NlJson @{ ok = $false; code = 'window_empty'; message = 'window has no visible area' }; exit 0 }

    $img = $null
    if ($method -ne 'screen') {
      try {
        $fw = $wr.Right - $wr.Left; $fh = $wr.Bottom - $wr.Top
        $full = New-Object System.Drawing.Bitmap($fw, $fh, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        $g = [System.Drawing.Graphics]::FromImage($full)
        $hdc = $g.GetHdc()
        try { [void][NlWin]::PrintWindow($hwnd, $hdc, 2) } finally { $g.ReleaseHdc($hdc); $g.Dispose() }   # 2 = PW_RENDERFULLCONTENT
        $ox = [Math]::Max(0, $area.Left - $wr.Left); $oy = [Math]::Max(0, $area.Top - $wr.Top)
        $cw = [Math]::Min($aw, $fw - $ox); $ch = [Math]::Min($ah, $fh - $oy)
        $cand = $full.Clone((New-Object System.Drawing.Rectangle($ox, $oy, $cw, $ch)), $full.PixelFormat)
        $full.Dispose()
        # a single flat color means nothing was drawn
        $first = $cand.GetPixel(0, 0); $varied = $false
        for ($gy = 0; $gy -lt 12 -and -not $varied; $gy++) {
          for ($gx = 0; $gx -lt 12; $gx++) {
            if ($cand.GetPixel([int](($cw - 1) * $gx / 11), [int](($ch - 1) * $gy / 11)).ToArgb() -ne $first.ToArgb()) { $varied = $true; break }
          }
        }
        if ($varied) { $img = $cand; $used = 'print' }
        else {
          $cand.Dispose()
          if ($method -eq 'print') { Out-NlJson @{ ok = $false; code = 'window_blank'; message = 'PrintWindow returned an empty image' }; exit 0 }
          [void]$warn.Add('print_blank_fallback_screen'); $fallback = $true
        }
      }
      catch {
        if ($method -eq 'print') { throw }
        [void]$warn.Add('print_failed_fallback_screen'); $fallback = $true
      }
    }
    if (-not $img) {
      $img = New-Object System.Drawing.Bitmap($aw, $ah, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
      $g = [System.Drawing.Graphics]::FromImage($img)
      try {
        try { $g.CopyFromScreen($area.Left, $area.Top, 0, 0, $img.Size, ([System.Drawing.CopyPixelOperation]::SourceCopy -bor [System.Drawing.CopyPixelOperation]::CaptureBlt)) }
        catch { $g.CopyFromScreen($area.Left, $area.Top, 0, 0, $img.Size, [System.Drawing.CopyPixelOperation]::SourceCopy) }
      }
      finally { $g.Dispose() }
      $used = 'screen'
      $vis = 0; $tot = 0
      for ($gy = 0; $gy -lt 6; $gy++) {
        for ($gx = 0; $gx -lt 6; $gx++) {
          $p = New-Object 'NlWin+POINT'
          $p.X = [int]($area.Left + ($aw - 1) * ($gx + 0.5) / 6); $p.Y = [int]($area.Top + ($ah - 1) * ($gy + 0.5) / 6)
          $tot++
          $top = [NlWin]::GetAncestor([NlWin]::WindowFromPoint($p), 2)
          if ($top -eq $hwnd) { $vis++ }
        }
      }
      $occ = [Math]::Round($vis / $tot, 2)
      if ($occ -lt 0.97) { [void]$warn.Add('occluded') }
    }
    $iw = $img.Width; $ih = $img.Height
    $reg = $null
    if ($env:CAP_RW) {
      $reg = Get-NlRegion $iw $ih $env:CAP_RUNITS ([double]$env:CAP_RX) ([double]$env:CAP_RY) ([double]$env:CAP_RW) ([double]$env:CAP_RH)
      if ($null -eq $reg) { $img.Dispose(); Out-NlJson @{ ok = $false; code = 'region_outside'; message = 'region is outside the window'; area_w = $iw; area_h = $ih }; exit 0 }
      $cropped = $img.Clone((New-Object System.Drawing.Rectangle($reg.x, $reg.y, $reg.w, $reg.h)), $img.PixelFormat)
      $img.Dispose(); $img = $cropped
    }
    try { $img.Save($env:CAP_OUT, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $img.Dispose() }
    $regOut = if ($reg) { @{ x = $reg.x; y = $reg.y; w = $reg.w; h = $reg.h } } else { @{ x = 0; y = 0; w = $iw; h = $ih } }
    Out-NlJson @{ ok = $true; method = $used; fallback = $fallback; area_w = $iw; area_h = $ih; region = $regOut; occluded_ratio = $occ; restored = $restored; activated = $activated; warnings = @($warn) }
  }
  finally {
    if ($restored -and $env:CAP_BACK -eq '1') { [void][NlWin]::ShowWindow($hwnd, 7) }   # SW_SHOWMINNOACTIVE: minimize again
  }
}
else { throw 'bad mode' }
