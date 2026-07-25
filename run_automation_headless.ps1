param(
  [switch]$ShowProgress,
  [switch]$StopActiveRun
)

$ErrorActionPreference = "Stop"

$repoDir = "H:\Github Repositories\AIVideoMaker"
$automationLogPath = Join-Path $repoDir "automation.log"
$automationStatePath = Join-Path $repoDir "automation_state.json"
$maxAttempts = 10
$authFailureExitCode = 23
$youtubeAccountEmail = "tanishqbaweja16@gmail.com"
if ([string]::IsNullOrWhiteSpace($env:VGEN_RUN_PUBLISH_AFTER_UPLOAD)) {
  $env:VGEN_RUN_PUBLISH_AFTER_UPLOAD = "true"
}
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$mutexName = "Local\AIVideoMakerRunAutomationHeadless"
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$hasMutex = $false

[Console]::OutputEncoding = $utf8NoBom
Set-Location $repoDir

function Write-HeadlessLog {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message,

    [switch]$Reset
  )

  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $line = "[$timestamp] $Message"

  if ($ShowProgress) {
    Write-Host $line
  }

  if ($Reset) {
    [System.IO.File]::WriteAllText($automationLogPath, $line + [Environment]::NewLine, $utf8NoBom)
    return
  }

  [System.IO.File]::AppendAllText($automationLogPath, $line + [Environment]::NewLine, $utf8NoBom)
}

function Set-AutomationState {
  $state = [ordered]@{
    wrapperPid = $PID
    startedAt = (Get-Date).ToString("o")
    repoDir = $repoDir
    logPath = $automationLogPath
  }

  [System.IO.File]::WriteAllText(
    $automationStatePath,
    ($state | ConvertTo-Json -Depth 3),
    $utf8NoBom
  )
}

function Clear-AutomationState {
  Remove-Item $automationStatePath -Force -ErrorAction SilentlyContinue
}

function Test-AutomationRunActive {
  $probeMutex = $null
  try {
    $probeMutex = New-Object System.Threading.Mutex($false, $mutexName)
    try {
      $acquired = $probeMutex.WaitOne(0, $false)
    } catch [System.Threading.AbandonedMutexException] {
      $acquired = $true
    }

    if ($acquired) {
      $probeMutex.ReleaseMutex()
      return $false
    }

    return $true
  } finally {
    if ($probeMutex) {
      $probeMutex.Dispose()
    }
  }
}

function Show-ActiveAutomationProgress {
  $byteOffset = 0L
  $inactivePolls = 0
  $sawOutput = $false

  Write-Host "Streaming automation.log for the active run. Press Ctrl+C to stop viewing."

  while ($true) {
    $wroteNewContent = $false

    if (Test-Path $automationLogPath) {
      $fileInfo = Get-Item $automationLogPath -ErrorAction SilentlyContinue
      if ($fileInfo) {
        if ($fileInfo.Length -lt $byteOffset) {
          Write-Host ""
          Write-Host "----- automation.log reset for a new attempt -----"
          $byteOffset = 0L
        }

        if ($fileInfo.Length -gt $byteOffset) {
          $stream = [System.IO.File]::Open($automationLogPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
          try {
            $stream.Seek($byteOffset, [System.IO.SeekOrigin]::Begin) | Out-Null
            $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8, $true, 1024, $true)
            try {
              $text = $reader.ReadToEnd()
              $byteOffset = $stream.Position
            } finally {
              $reader.Dispose()
            }
          } finally {
            $stream.Dispose()
          }

          if ($text) {
            Write-Host -NoNewline $text
            $wroteNewContent = $true
            $sawOutput = $true
          }
        }
      }
    }

    $runIsActive = Test-AutomationRunActive
    if (-not $runIsActive -and -not $wroteNewContent) {
      $inactivePolls += 1
    } else {
      $inactivePolls = 0
    }

    if (-not $runIsActive -and $inactivePolls -ge 2) {
      if (-not $sawOutput) {
        Write-Host "No active automation run is writing to automation.log."
      }
      break
    }

    Start-Sleep -Milliseconds 500
  }
}

function Stop-ActiveAutomation {
  if (-not (Test-Path $automationStatePath)) {
    if ($ShowProgress) {
      Write-Host "No active automation state file was found."
    }
    return 0
  }

  try {
    $state = Get-Content $automationStatePath -Raw | ConvertFrom-Json
  } catch {
    Remove-Item $automationStatePath -Force -ErrorAction SilentlyContinue
    if ($ShowProgress) {
      Write-Host "Automation state file was invalid and has been removed."
    }
    return 0
  }

  $wrapperPid = 0
  if ($state.wrapperPid) {
    $wrapperPid = [int]$state.wrapperPid
  }

  if ($wrapperPid -le 0) {
    Remove-Item $automationStatePath -Force -ErrorAction SilentlyContinue
    if ($ShowProgress) {
      Write-Host "Automation state file did not contain a valid process id."
    }
    return 0
  }

  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $stopLine = "[$timestamp] Stop requested. Terminating active automation process tree (PID $wrapperPid)."
  if (Test-Path $automationLogPath) {
    [System.IO.File]::AppendAllText($automationLogPath, $stopLine + [Environment]::NewLine, $utf8NoBom)
  } else {
    [System.IO.File]::WriteAllText($automationLogPath, $stopLine + [Environment]::NewLine, $utf8NoBom)
  }

  $taskkillPath = Join-Path $env:SystemRoot "System32\taskkill.exe"
  $taskkill = Start-Process -FilePath $taskkillPath -ArgumentList "/T", "/F", "/PID", "$wrapperPid" -PassThru -Wait -WindowStyle Hidden
  Remove-Item $automationStatePath -Force -ErrorAction SilentlyContinue

  if ($ShowProgress) {
    if ($taskkill.ExitCode -eq 0) {
      Write-Host "Stopped automation process tree rooted at PID $wrapperPid."
    } else {
      Write-Host "taskkill exited with code $($taskkill.ExitCode) while stopping PID $wrapperPid."
    }
  }

  return $taskkill.ExitCode
}

function Invoke-AutomationAttempt {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Attempt,

    [string[]]$PythonArguments = @()
  )

  Write-HeadlessLog -Message "Headless automation attempt $Attempt of $maxAttempts starting." -Reset

  $fullArguments = @("scripts/automate.py") + $PythonArguments
  $env:VGEN_SHOW_PRE_RENDER_ALERT = if ($Attempt -ge $maxAttempts) { "1" } else { "0" }
  $quotedArguments = $fullArguments | ForEach-Object {
    '"' + ($_.Replace('"', '\"')) + '"'
  }
  $cmdLine = "python " + ($quotedArguments -join " ") + " 2>&1"

  & cmd.exe /d /c $cmdLine | ForEach-Object {
    if ($ShowProgress) {
      Write-Host $_.ToString()
    }

    [System.IO.File]::AppendAllText(
      $automationLogPath,
      $_.ToString() + [Environment]::NewLine,
      $utf8NoBom
    )
  }

  $exitCode = $LASTEXITCODE
  Write-HeadlessLog -Message "Headless automation attempt $Attempt finished with exit code $exitCode."
  return $exitCode
}

function Invoke-YouTubeAuthRecovery {
  $popup = New-Object -ComObject WScript.Shell
  $message = "YouTube auth failed for $youtubeAccountEmail.`n`nRedo authentication now?"
  $response = $popup.Popup($message, 0, "V-GEN YouTube Authentication", 4 + 16 + 4096)
  if ($response -ne 6) {
    Write-HeadlessLog -Message "YouTube reauthentication declined for $youtubeAccountEmail."
    return $false
  }

  Write-HeadlessLog -Message "Launching interactive YouTube reauthentication for $youtubeAccountEmail."
  $escapedRepoDir = $repoDir.Replace("'", "''")
  $authScript = @"
Set-Location -LiteralPath '$escapedRepoDir'
python upload.py --reauth --check-auth
`$code = `$LASTEXITCODE
if (`$code -ne 0) {
  Write-Host ''
  Read-Host 'Reauthentication failed. Press Enter to close this window'
}
exit `$code
"@
  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($authScript))
  $authProcess = Start-Process `
    -FilePath "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encodedCommand `
    -WindowStyle Normal `
    -PassThru `
    -Wait

  if ($authProcess.ExitCode -ne 0) {
    Write-HeadlessLog -Message "Interactive YouTube reauthentication failed with exit code $($authProcess.ExitCode)."
    return $false
  }

  $verifyOutput = & cmd.exe /d /c "python upload.py --check-auth 2>&1"
  $verifyExitCode = $LASTEXITCODE
  $verifyOutput | ForEach-Object {
    [System.IO.File]::AppendAllText(
      $automationLogPath,
      $_.ToString() + [Environment]::NewLine,
      $utf8NoBom
    )
  }
  if ($verifyExitCode -ne 0) {
    Write-HeadlessLog -Message "YouTube auth verification failed after interactive reauthentication."
    return $false
  }

  Write-HeadlessLog -Message "YouTube reauthentication succeeded. Restarting the automation pipeline."
  return $true
}

try {
  if ($StopActiveRun) {
    exit (Stop-ActiveAutomation)
  }

  try {
    $hasMutex = $mutex.WaitOne(0, $false)
  } catch [System.Threading.AbandonedMutexException] {
    $hasMutex = $true
  }

  if (-not $hasMutex) {
    if ($ShowProgress) {
      Show-ActiveAutomationProgress
    }
    exit 0
  }

  Set-AutomationState

  $attempt = 1
  $exitCode = Invoke-AutomationAttempt -Attempt $attempt

  if ($exitCode -eq $authFailureExitCode) {
    if (-not (Invoke-YouTubeAuthRecovery)) {
      exit $authFailureExitCode
    }
    $attempt = 1
    $exitCode = Invoke-AutomationAttempt -Attempt $attempt
  }

  while ($exitCode -eq 10 -and $attempt -lt $maxAttempts) {
    $attempt += 1
    $exitCode = Invoke-AutomationAttempt -Attempt $attempt -PythonArguments @("--contingency-retry")
  }

  if ($exitCode -eq 10 -and $attempt -ge $maxAttempts) {
    Write-HeadlessLog -Message "Pre-video failure limit reached after $maxAttempts attempts."
    exit 10
  }

  exit $exitCode
} catch {
  Write-HeadlessLog -Message ("Headless wrapper failure: " + $_.Exception.Message)
  throw
} finally {
  if ($hasMutex) {
    Clear-AutomationState
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}
