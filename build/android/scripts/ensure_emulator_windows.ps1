param(
    [Parameter(Mandatory = $true)]
    [string]$SdkRoot
)

$ErrorActionPreference = "Stop"
$adb = Join-Path $SdkRoot "platform-tools\adb.exe"
$emulator = Join-Path $SdkRoot "emulator\emulator.exe"

if (-not (Test-Path $adb)) {
    throw "adb not found: $adb"
}
if (-not (Test-Path $emulator)) {
    throw "Android Emulator not found: $emulator"
}

$devices = (& $adb devices) -join "`n"
if ($devices -match "(?m)^emulator-\d+\s+device\s*$") {
    Write-Host "Emulator already running"
    exit 0
}

$avds = @(& $emulator -list-avds | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($avds.Count -eq 0) {
    throw "No Android Virtual Device found. Create one in Android Studio Device Manager."
}

$avd = $avds[0].Trim()
Write-Host "Starting emulator: $avd"
Start-Process -FilePath $emulator -ArgumentList @("-avd", $avd, "-no-snapshot-load") | Out-Null

& $adb wait-for-device
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

for ($i = 0; $i -lt 120; $i++) {
    $bootCompleted = (& $adb shell getprop sys.boot_completed 2>$null | Out-String).Trim()
    if ($bootCompleted -eq "1") {
        Write-Host "Emulator booted successfully"
        exit 0
    }
    Start-Sleep -Seconds 1
}

throw "Emulator boot timeout"
