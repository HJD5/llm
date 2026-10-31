param(
    [Parameter(Mandatory=$true)][string]$Source,
    [Parameter(Mandatory=$true)][string]$Target
)
$ErrorActionPreference = 'Stop'
$flutterCommand = Get-Command flutter -ErrorAction SilentlyContinue
if (-not $flutterCommand) { throw 'Flutter SDK is not available in PATH. Install/configure Flutter, then rerun this command. No validation has been performed.' }
$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$targetPath = (Resolve-Path -LiteralPath $Target).Path
# Keep a separate reproducible validation project; never edit input files.
$checkRoot = Join-Path $PSScriptRoot ('platform\private-data\flutter-check-' + [guid]::NewGuid().ToString('N'))
$arbDir = Join-Path $checkRoot 'lib\l10n'
New-Item -ItemType Directory -Force -Path $arbDir | Out-Null
Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $arbDir 'intl_ru.arb')
Copy-Item -LiteralPath $targetPath -Destination (Join-Path $arbDir 'intl_kk.arb')
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $checkRoot 'pubspec.yaml'), @'
name: locqa_export_validation
publish_to: none
environment:
  sdk: '>=3.0.0 <4.0.0'
dependencies:
  flutter:
    sdk: flutter
  flutter_localizations:
    sdk: flutter
flutter:
  generate: true
'@, $utf8)
[IO.File]::WriteAllText((Join-Path $checkRoot 'l10n.yaml'), @'
arb-dir: lib/l10n
template-arb-file: intl_ru.arb
output-localization-file: app_localizations.dart
output-dir: lib/generated
'@, $utf8)
Push-Location $checkRoot
try {
    & $flutterCommand.Source --version
    if ($LASTEXITCODE -ne 0) { throw 'Flutter SDK failed to start.' }
    & $flutterCommand.Source pub get
    if ($LASTEXITCODE -ne 0) { throw 'flutter pub get failed; gen-l10n has not been validated.' }
    & $flutterCommand.Source gen-l10n
    if ($LASTEXITCODE -ne 0) { throw 'flutter gen-l10n failed. Inspect the diagnostics and retained validation project.' }
    if (-not (Test-Path -LiteralPath 'lib/generated/app_localizations.dart')) { throw 'Expected localization output was not generated.' }
    Write-Host ('PASS: flutter gen-l10n. Validation project: ' + $checkRoot)
} finally { Pop-Location }
