param(
  [string]$PythonVersion = "3.12.10",
  [string]$OpenpyxlVersion = "3.1.5"
)

$ErrorActionPreference = "Stop"
$DesktopDir = Split-Path -Parent $PSScriptRoot
$ResourceDir = Join-Path $DesktopDir "resources"
$PythonDir = Join-Path $ResourceDir "python"
$Marker = Join-Path $PythonDir ".prepared"

if (Test-Path -LiteralPath $Marker) {
  $current = Get-Content -LiteralPath $Marker -Raw
  if ($current -match [regex]::Escape("$PythonVersion/$OpenpyxlVersion")) {
    Write-Host "Python runtime already prepared: $PythonDir"
    exit 0
  }
}

$TempDir = Join-Path $env:TEMP ("quote-python-" + [guid]::NewGuid().ToString("N"))
$ZipPath = Join-Path $TempDir "python-embed.zip"
$ExtractDir = Join-Path $TempDir "python"

New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
try {
  $Url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractDir -Force

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
    --target $SitePackages "openpyxl==$OpenpyxlVersion"
  if ($LASTEXITCODE -ne 0) { throw "pip install openpyxl failed" }

  & (Join-Path $ExtractDir "python.exe") -c "import openpyxl; print(openpyxl.__version__)"
  if ($LASTEXITCODE -ne 0) { throw "Bundled Python cannot import openpyxl" }

  if (Test-Path -LiteralPath $PythonDir) {
    Remove-Item -LiteralPath $PythonDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $ResourceDir | Out-Null
  Copy-Item -LiteralPath $ExtractDir -Destination $PythonDir -Recurse
  Set-Content -LiteralPath (Join-Path $PythonDir ".prepared") `
    -Value "$PythonVersion/$OpenpyxlVersion" -Encoding ASCII
  Write-Host "Prepared Python runtime: $PythonDir"
}
finally {
  if (Test-Path -LiteralPath $TempDir) {
    Remove-Item -LiteralPath $TempDir -Recurse -Force
  }
}
