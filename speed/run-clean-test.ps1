# Clean speed test on a dedicated Windows machine (works in Windows PowerShell 5.1 and PowerShell 7).
#
# Usage, from llm-lab\speed:
#   powershell -ExecutionPolicy Bypass -File .\run-clean-test.ps1
#   powershell -ExecutionPolicy Bypass -File .\run-clean-test.ps1 -Label pc-1stick -Runs 3 -TryMoE
#
# What it does:
#   1. Checks the machine is clean: on mains power, Ollama up with no model loaded, no Docker
#      container running, CPU idle. Lists the 5 programs using the most CPU and RAM.
#   2. Records the hardware and computes the theoretical bandwidth (channels x 8 bytes x MT/s).
#   3. Runs speed-test.mjs once per model, sampling CPU load and free RAM every 2 s.
#   4. Writes everything to results\clean-<label>-<time>\ and zips it. The computer name is never
#      recorded: -Label is the only name in the files.
#
# gpt-oss:20b needs about 14 GB. Below 24 GB of RAM it is skipped unless -TryMoE is given.

param(
  [int]$Runs = 3,
  [string[]]$Models = @('llama3.2:1b', 'qwen2.5:3b', 'llama3.2:3b', 'llama3.1:8b', 'gpt-oss:20b'),
  [double]$Bandwidth = 0,      # GB/s; 0 = computed from the RAM modules
  [switch]$TryMoE,             # run gpt-oss:20b even with less than 24 GB of RAM
  [switch]$Force,              # continue even if a check fails
  [switch]$Pause,              # wait for Enter before each model (time to open Task Manager)
  [string]$Label = 'pc'        # name used in the result folder, instead of the computer name
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ollama = if ($env:OLLAMA_URL) { $env:OLLAMA_URL } else { 'http://localhost:11434' }
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$outDir = Join-Path $here "results\clean-$Label-$stamp"
New-Item -ItemType Directory -Force $outDir | Out-Null
$log = Join-Path $outDir 'preflight.txt'
$problems = New-Object System.Collections.Generic.List[string]

function Say([string]$text) { Write-Host $text; Add-Content -Path $log -Value $text }
function Problem([string]$text) { $problems.Add($text); Say "  [!] $text" }

# ---------------------------------------------------------------- 1. preflight
Say "Clean speed test, $stamp, $Label"
Say ''
Say '1. Is the machine clean?'

$battery = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue
if ($battery -and (@(1, 4, 5) -contains [int]$battery.BatteryStatus)) {
  Problem 'On battery. Plug the laptop in: Windows slows the CPU on battery.'
} else { Say '  power: mains (or no battery)' }

try { $version = (Invoke-RestMethod "$ollama/api/version").version; Say "  ollama: $version" }
catch { Problem "Ollama does not answer on $ollama. Start it, then run again."; $version = $null }

if ($version) {
  $loaded = @((Invoke-RestMethod "$ollama/api/ps").models)
  foreach ($m in $loaded) {
    Say "  unloading $($m.name)"
    $body = @{ model = $m.name; keep_alive = 0 } | ConvertTo-Json
    Invoke-RestMethod "$ollama/api/generate" -Method Post -Body $body -ContentType 'application/json' | Out-Null
  }
  $installed = @((Invoke-RestMethod "$ollama/api/tags").models | ForEach-Object { $_.name })
  foreach ($m in $Models) { if ($installed -notcontains $m) { Problem "Model not installed: $m (ollama pull $m)" } }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { Say "  node: $(& node --version)" } else { Problem 'Node.js not found (version 18 or later needed).' }

$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($docker) {
  $running = @(& docker ps -q 2>$null)
  if ($running.Count -gt 0) { Problem "$($running.Count) Docker container(s) running. Stop them: docker stop `$(docker ps -q)" }
  else { Say '  docker: no container running' }
}

# CPU time used per process over 5 s, independent of the Windows language.
$before = @{}
$watch = [Diagnostics.Stopwatch]::StartNew()
Get-Process | ForEach-Object { try { $before[$_.Id] = $_.TotalProcessorTime.TotalMilliseconds } catch {} }
$loads = @()
1..5 | ForEach-Object { $loads += (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average; Start-Sleep 1 }
$elapsedMs = $watch.Elapsed.TotalMilliseconds
$threads = [Environment]::ProcessorCount
$perProcess = Get-Process | ForEach-Object {
  $ms = 0
  try { if ($before.ContainsKey($_.Id)) { $ms = $_.TotalProcessorTime.TotalMilliseconds - $before[$_.Id] } } catch {}
  [pscustomobject]@{ Name = $_.ProcessName; Ms = $ms; Bytes = $_.WorkingSet64 }
}
# One line per program (all Edge or VS Code processes together).
$top = $perProcess | Where-Object { $_.Name -ne 'Idle' } | Group-Object Name | ForEach-Object {
  [pscustomobject]@{
    Name = "$($_.Name) (x$($_.Count))"
    CpuPct = [math]::Round(100 * ($_.Group | Measure-Object Ms -Sum).Sum / $elapsedMs / $threads, 1)
    RamMB = [math]::Round(($_.Group | Measure-Object Bytes -Sum).Sum / 1MB)
  }
}
$idle = [math]::Round(($loads | Measure-Object -Average).Average, 1)
Say "  CPU load at rest: $idle %"
if ($idle -gt 15) { Problem "CPU is busy at rest ($idle %). Close the programs below or wait for Windows Update / Defender." }
Say '  top 5 by CPU:'
$top | Sort-Object CpuPct -Descending | Select-Object -First 5 |
  ForEach-Object { Say ("    {0,-28} {1,6} % CPU {2,7} MB" -f $_.Name, $_.CpuPct, $_.RamMB) }
Say '  top 5 by RAM:'
$top | Sort-Object RamMB -Descending | Select-Object -First 5 |
  ForEach-Object { Say ("    {0,-28} {1,6} % CPU {2,7} MB" -f $_.Name, $_.CpuPct, $_.RamMB) }

$os = Get-CimInstance Win32_OperatingSystem
$totalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
$freeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
Say "  RAM: $freeGB GB free of $totalGB GB"

# ---------------------------------------------------------------- 2. hardware
Say ''
Say '2. Hardware'
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$sticks = @(Get-CimInstance Win32_PhysicalMemory)
$mts = ($sticks | Select-Object -First 1).ConfiguredClockSpeed
$channels = [math]::Min($sticks.Count, 2)   # one module = one channel; two modules in two slots = usually two
if ($Bandwidth -le 0) { $Bandwidth = $channels * 8 * $mts / 1000 }
Say "  CPU: $($cpu.Name.Trim()), $($cpu.NumberOfCores) cores, $($cpu.NumberOfLogicalProcessors) threads"
foreach ($s in $sticks) { Say "  RAM: $($s.DeviceLocator), $($s.Capacity / 1GB) GB, announced $($s.Speed), configured $($s.ConfiguredClockSpeed) MT/s" }
Say "  bandwidth used for the prediction: $channels channel(s) x 8 x $mts = $Bandwidth GB/s"
$gpu = (Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) -join ', '
Say "  graphics: $gpu"
$plan = (& powercfg /getactivescheme) -join ' '
Say "  power plan: $plan"

@{
  label = $Label; date = $stamp; cpu = $cpu.Name.Trim(); cores = $cpu.NumberOfCores
  threads = $cpu.NumberOfLogicalProcessors; ramGB = $totalGB; mts = $mts; channels = $channels
  bandwidthGBs = $Bandwidth; ollama = $version; graphics = $gpu; idleCpuPct = $idle
  modules = @($sticks | ForEach-Object { @{ slot = $_.DeviceLocator; gb = $_.Capacity / 1GB; speed = $_.Speed; configured = $_.ConfiguredClockSpeed } })
} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $outDir 'hardware.json')

if ($totalGB -lt 24 -and -not $TryMoE -and $Models -contains 'gpt-oss:20b') {
  Say '  less than 24 GB of RAM: gpt-oss:20b skipped (add -TryMoE to try anyway)'
  $Models = @($Models | Where-Object { $_ -ne 'gpt-oss:20b' })
}

if ($problems.Count -gt 0 -and -not $Force) {
  Say ''
  Say "Stopped: $($problems.Count) problem(s) above. Fix them, or run again with -Force."
  exit 1
}

# ---------------------------------------------------------------- 3. measure
Say ''
Say '3. Measuring'
$env:BANDWIDTH_GBS = "$Bandwidth"
$resultsDir = Join-Path $here 'results'
$cpuCsv = Join-Path $outDir 'cpu.csv'
$summary = @()

foreach ($m in $Models) {
  if ($Pause) { Read-Host "Next: $m. Press Enter to start" | Out-Null }
  $sampler = Start-Job -ArgumentList $m -ScriptBlock {
    param($model)
    while ($true) {
      $load = (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average
      $free = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
      [pscustomobject]@{ time = (Get-Date).ToString('HH:mm:ss'); model = $model; cpuPct = $load; freeRamGB = [math]::Round($free / 1MB, 2) }
      Start-Sleep 2
    }
  }
  $started = Get-Date
  & node (Join-Path $here 'speed-test.mjs') $Runs $m 2>&1 | Tee-Object -FilePath (Join-Path $outDir 'speed-test.log') -Append
  $samples = @(Receive-Job $sampler)
  Stop-Job $sampler; Remove-Job $sampler
  $samples | Select-Object time, model, cpuPct, freeRamGB | Export-Csv $cpuCsv -NoTypeInformation -Append

  $json = Get-ChildItem $resultsDir -Filter '*.json' | Where-Object { $_.LastWriteTime -ge $started } |
    Sort-Object LastWriteTime | Select-Object -Last 1
  $row = [ordered]@{ model = $m }
  if ($json) {
    Copy-Item $json.FullName (Join-Path $outDir ($m.Replace(':', '_') + '.json'))
    $r = (Get-Content $json.FullName -Raw | ConvertFrom-Json).results[0]
    $row.predicted = $r.predictedMax
    $row.measured = $r.measuredEvalMedian
    $row.ratioPct = if ($r.predictedMax) { [math]::Round(100 * $r.measuredEvalMedian / $r.predictedMax) } else { $null }
    $row.memoryGB = $r.memoryGB
  }
  $busy = @($samples | Where-Object { $_.cpuPct -ne $null })
  if ($busy.Count) {
    $row.cpuAvgPct = [math]::Round(($busy | Measure-Object cpuPct -Average).Average)
    $row.minFreeRamGB = ($busy | Measure-Object freeRamGB -Minimum).Minimum
  }
  $summary += [pscustomobject]$row
}

# ---------------------------------------------------------------- 4. save
$summary | ConvertTo-Json | Set-Content (Join-Path $outDir 'summary.json')
Say ''
Say 'Summary (tokens/s; ratio = measured / predicted)'
($summary | Format-Table -AutoSize | Out-String).TrimEnd() | ForEach-Object { Say $_ }
$zip = "$outDir.zip"
Compress-Archive -Path "$outDir\*" -DestinationPath $zip -Force
Say ''
Say "Saved: $zip"
