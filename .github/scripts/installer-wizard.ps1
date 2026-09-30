# Clicks through the Windows installer wizard (Enter = the default button on
# each page) and saves a screenshot of every page, so the wizard can be
# reviewed from CI. Usage: installer-wizard.ps1 <installer.exe> <out-dir>
param([string]$Installer, [string]$OutDir)
$ErrorActionPreference = "Stop"
$App = "$env:LOCALAPPDATA\Programs\Curvant\Curvant.exe"
$Proc = "Curvant"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$shell = New-Object -ComObject WScript.Shell

function Shot([string]$name) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save((Join-Path $OutDir "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

function Press([string]$keys) {
  if (-not $shell.AppActivate("Curvant Setup")) { throw "installer window not found" }
  Start-Sleep -Milliseconds 300
  [System.Windows.Forms.SendKeys]::SendWait($keys)
  Start-Sleep -Seconds 2
}

$p = Start-Process -FilePath $Installer -PassThru
for ($i = 0; $i -lt 60 -and -not $shell.AppActivate("Curvant Setup"); $i++) { Start-Sleep -Seconds 1 }
Start-Sleep -Seconds 2

Shot "1-welcome";  Press "{ENTER}"
Shot "2-location"; Press "{ENTER}"
Shot "3-options";  Press "{ENTER}"
Shot "4-ready";    Press "{ENTER}"
Start-Sleep -Milliseconds 500
Shot "5-installing"
# Wait for the finish page: the installer is done copying when the app exe exists and settles.
for ($i = 0; $i -lt 120 -and -not (Test-Path $App); $i++) { Start-Sleep -Seconds 1 }
Start-Sleep -Seconds 8
Shot "6-finished"
# Finish with "Launch Curvant" ticked, so this also checks the launch; then close the app.
Press "{ENTER}"
for ($i = 0; $i -lt 30 -and -not (Get-Process $Proc -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
Start-Sleep -Seconds 3
Shot "7-launched"
if (-not (Get-Process $Proc -ErrorAction SilentlyContinue)) { throw "Finish did not launch the app" }
Get-Process $Proc -ErrorAction SilentlyContinue | Stop-Process -Force
if (-not $p.HasExited) { $p | Wait-Process -Timeout 60 }
if (-not (Test-Path $App)) { throw "wizard install did not create the app" }
Write-Host "Wizard completed; screenshots in $OutDir"
