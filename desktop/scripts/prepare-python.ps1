param(
  [string]$PythonVersion = "3.12.10",
  [string]$OpenpyxlVersion = "3.1.5",
  [string]$PythonZipSha256 = "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3"
)

$ErrorActionPreference = "Stop"
$DesktopDir = Split-Path -Parent $PSScriptRoot
$ResourceDir = Join-Path $DesktopDir "resources"
$PythonDir = Join-Path $ResourceDir "python"
$Marker = Join-Path $PythonDir ".prepared"
$Requirements = Join-Path (Split-Path -Parent $DesktopDir) "deploy\python-requirements.txt"

function Get-Sha256([string]$FilePath) {
  $stream = [System.IO.File]::OpenRead($FilePath)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace "-", "").ToLowerInvariant()
    }
    finally { $sha.Dispose() }
  }
  finally { $stream.Dispose() }
}

if (-not (Test-Path -LiteralPath $Requirements)) {
  throw "Locked Python requirements not found: $Requirements"
}
$RequirementsHash = Get-Sha256 $Requirements
$MarkerValue = "$PythonVersion/$PythonZipSha256/$RequirementsHash"

if (Test-Path -LiteralPath $Marker) {
  $current = Get-Content -LiteralPath $Marker -Raw
  if ($current.Trim() -eq $MarkerValue) {
    Write-Host "Python runtime already prepared: $PythonDir"
    exit 0
  }
}

$TempDir = Join-Path $env:TEMP ("quote-python-" + [guid]::NewGuid().ToString("N"))
$ZipPath = Join-Path $TempDir "python-embed.zip"
$ExtractDir = Join-Path $TempDir "python"

New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
try {
  $Url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing
  $ActualZipHash = Get-Sha256 $ZipPath
  if ($ActualZipHash -ne $PythonZipSha256.ToLowerInvariant()) {
    throw "Python ZIP SHA256 mismatch: expected $PythonZipSha256, got $ActualZipHash"
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $ExtractDir)

  $Pth = Get-ChildItem -LiteralPath $ExtractDir -Filter "python*._pth" | Select-Object -First 1
  if (-not $Pth) { throw "Python embeddable ._pth file not found" }
  $Lines = Get-Content -LiteralPath $Pth.FullName
  $Lines = $Lines | ForEach-Object {
    if ($_ -eq "#import site") { "import site" }
    elseif ($_ -eq "#Lib\site-packages") { "Lib\site-packages" }
    else { $_ }
  }
  if ($Lines -notcontains "Lib\site-packages") { $Lines += "Lib\site-packages" }
  Set-Content -LiteralPath $Pth.FullName -Value $Lines -Encoding ASCII

  $SitePackages = Join-Path $ExtractDir "Lib\site-packages"
  New-Item -ItemType Directory -Force -Path $SitePackages | Out-Null
  & python -m pip install --disable-pip-version-check --no-warn-script-location `
    --only-binary=:all: --no-deps --require-hashes --target $SitePackages `
    -r $Requirements
  if ($LASTEXITCODE -ne 0) { throw "pip install locked Python dependencies failed" }

  $Installed = & (Join-Path $ExtractDir "python.exe") -c "import openpyxl, defusedxml; print(openpyxl.__version__)"
  if ($LASTEXITCODE -ne 0 -or $Installed.Trim() -ne $OpenpyxlVersion) {
    throw "Bundled Python must import openpyxl $OpenpyxlVersion (got $Installed)"
  }

  if (Test-Path -LiteralPath $PythonDir) {
    Remove-Item -LiteralPath $PythonDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $ResourceDir | Out-Null
  Copy-Item -LiteralPath $ExtractDir -Destination $PythonDir -Recurse
  Set-Content -LiteralPath (Join-Path $PythonDir ".prepared") `
    -Value $MarkerValue -Encoding ASCII
  Write-Host "Prepared Python runtime: $PythonDir"
}
finally {
  if (Test-Path -LiteralPath $TempDir) {
    Remove-Item -LiteralPath $TempDir -Recurse -Force
  }
}
