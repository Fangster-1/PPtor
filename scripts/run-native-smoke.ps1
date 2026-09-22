param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$AppDirectory = '',
  [string]$FixtureDirectory = ''
)
$ErrorActionPreference = 'Stop'
$exePath = (Resolve-Path -LiteralPath $Executable).Path
$outPath = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outPath -Force | Out-Null
$reportPath = Join-Path $outPath 'report.json'
if (Test-Path -LiteralPath $reportPath) { throw 'Use a new output directory so stale reports cannot pass.' }
$env:ELECTRON_RUN_AS_NODE = $null
$env:PPTOR_DATA_DIR = Join-Path $outPath 'isolated-data'
$argList = @()
if ($AppDirectory) { $argList += '"' + [System.IO.Path]::GetFullPath($AppDirectory) + '"' }
$argList += '--smoke'
$argList += '--smoke-native'
$argList += '"--smoke-output=' + $outPath + '"'
if ($FixtureDirectory) { $argList += '"--smoke-fixture=' + [System.IO.Path]::GetFullPath($FixtureDirectory) + '"' }
$proc = Start-Process -FilePath $exePath -ArgumentList $argList -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $outPath 'stdout.log') -RedirectStandardError (Join-Path $outPath 'stderr.log')
if (-not $proc.WaitForExit(120000)) {
  $proc.Kill()
  throw 'Native smoke exceeded 120 seconds.'
}
if (-not (Test-Path -LiteralPath $reportPath)) { throw "Native smoke produced no report; exit code $($proc.ExitCode). See stderr.log." }
$report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
if (-not $report.ok -or $proc.ExitCode -ne 0) { throw "Native smoke failed; exit code $($proc.ExitCode). See report.json." }
[pscustomobject]@{ Executable = $exePath; Version = $report.version; Packaged = $report.packaged; Checks = $report.checks.Count; RendererReadyMs = $report.metrics.rendererReadyUptimeMs; Output = $outPath } | Format-List
