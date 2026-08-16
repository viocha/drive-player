param(
    [ValidateSet("arm64", "amd64", "x86_64")]
    [string]$Arch = "amd64",
    [string]$Production = "false"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
Set-Location $projectRoot

$sdkRoot = $env:ANDROID_HOME
if ([string]::IsNullOrWhiteSpace($sdkRoot)) {
    $sdkRoot = $env:ANDROID_SDK_ROOT
}
if ([string]::IsNullOrWhiteSpace($sdkRoot) -or -not (Test-Path $sdkRoot)) {
    throw "Android SDK not found. Set ANDROID_HOME or ANDROID_SDK_ROOT."
}

$ndkRoot = $env:ANDROID_NDK_HOME
if ([string]::IsNullOrWhiteSpace($ndkRoot)) {
    $preferred = Join-Path $sdkRoot "ndk\26.3.11579264"
    if (Test-Path $preferred) {
        $ndkRoot = $preferred
    } else {
        $ndkRoot = Get-ChildItem (Join-Path $sdkRoot "ndk") -Directory -ErrorAction SilentlyContinue |
            Sort-Object { try { [version]$_.Name } catch { [version]"0.0" } } -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
}
if ([string]::IsNullOrWhiteSpace($ndkRoot) -or -not (Test-Path $ndkRoot)) {
    throw "Android NDK not found. Install NDK 26.3.11579264 or set ANDROID_NDK_HOME."
}

$toolchain = Join-Path $ndkRoot "toolchains\llvm\prebuilt\windows-x86_64"
if (-not (Test-Path $toolchain)) {
    throw "Windows Android NDK toolchain not found: $toolchain"
}

switch ($Arch) {
    "arm64" {
        $env:GOARCH = "arm64"
        $jniDir = "arm64-v8a"
        $compiler = "aarch64-linux-android21-clang.cmd"
        $compilerXX = "aarch64-linux-android21-clang++.cmd"
    }
    default {
        $env:GOARCH = "amd64"
        $jniDir = "x86_64"
        $compiler = "x86_64-linux-android21-clang.cmd"
        $compilerXX = "x86_64-linux-android21-clang++.cmd"
    }
}

$env:CC = Join-Path $toolchain "bin\$compiler"
$env:CXX = Join-Path $toolchain "bin\$compilerXX"
$env:CGO_ENABLED = "1"
$env:GOOS = "android"

$outputDir = Join-Path $projectRoot "build\android\app\src\main\jniLibs\$jniDir"
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$output = Join-Path $outputDir "libwails.so"

$arguments = @("build", "-buildmode=c-shared", "-overlay", "build/android/overlay.json", "-buildvcs=false")
if ($Production -eq "true") {
    $arguments += @("-tags", "production,android", "-trimpath", "-ldflags=-w -s")
} else {
    $arguments += @("-tags", "android,debug", "-gcflags=all=-l")
}
$arguments += @("-o", $output)

Write-Host "Building Android $Arch shared library with NDK $([IO.Path]::GetFileName($ndkRoot))..."
& go @arguments
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
Write-Host "Created $output"
