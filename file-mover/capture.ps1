$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# 노드랩 파일 이동기 v1.3 화면 캡처. server.js(capture.js)가 환경변수로 일을 시키고 JSON 한 줄을 돌려받는다.
#   CAP_MODE=info : 모니터 목록과 전체 화면 크기를 출력
#   CAP_MODE=shot : CAP_X, CAP_Y, CAP_W, CAP_H(바탕화면 절대 픽셀)를 CAP_OUT 에 PNG로 저장
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class NlDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
'@
[void][NlDpi]::SetProcessDPIAware()

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
else { throw 'bad mode' }
