param(
  [switch]$ShowProgress,
  [switch]$StopActiveRun,
  [switch]$SingleVideo,
  [switch]$PdfOnly
)

$ErrorActionPreference = "Stop"

$repoDir = "H:\Github Repositories\AIVideoMaker"
$automationLogPath = Join-Path $repoDir "automation.log"
$automationStatePath = Join-Path $repoDir "automation_state.json"
$maxAttempts = 10
$authFailureExitCode = 23
$youtubeAccountEmail = "tanishqbaweja16@gmail.com"
$projectLabel = "Main"
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

    [Parameter(Mandatory = $true)]
    [string]$SlotLabel,

    [string[]]$PythonArguments = @()
  )

  Write-HeadlessLog `
    -Message "$SlotLabel generation attempt $Attempt of $maxAttempts starting."

  $fullArguments = @("scripts/automate.py") + $PythonArguments
  $env:VGEN_SHOW_PRE_RENDER_ALERT = "0"
  $env:VGEN_SHOW_DESKTOP_ALERTS = "0"
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
  Write-HeadlessLog -Message "$SlotLabel attempt $Attempt finished with exit code $exitCode."
  return $exitCode
}

function Invoke-PdfOmniUpload {
  param(
    [string]$PublishAt
  )

  if ([string]::IsNullOrWhiteSpace($PublishAt)) {
    Write-HeadlessLog -Message "Uploading the next PDFomni rotation video for the next 8:00 PM IST."
    $cmdLine = "python `"scripts/upload_pdf_video.py`" 2>&1"
  } else {
    Write-HeadlessLog `
      -Message "Uploading the next PDFomni rotation video for 8:00 PM IST ($PublishAt)."
    $cmdLine = "python `"scripts/upload_pdf_video.py`" --publish-at `"$PublishAt`" 2>&1"
  }

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
  Write-HeadlessLog -Message "PDFomni upload finished with exit code $exitCode."
  return $exitCode
}

function Invoke-YouTubeAuthCheck {
  Write-HeadlessLog -Message "Checking YouTube authentication before starting the daily batch."
  $authOutput = & cmd.exe /d /c "python upload.py --check-auth 2>&1"
  $authExitCode = $LASTEXITCODE
  $authOutput | ForEach-Object {
    if ($ShowProgress) {
      Write-Host $_.ToString()
    }
    [System.IO.File]::AppendAllText(
      $automationLogPath,
      $_.ToString() + [Environment]::NewLine,
      $utf8NoBom
    )
  }
  if ($authExitCode -eq 0) {
    Write-HeadlessLog -Message "YouTube authentication is ready."
    return 0
  }
  Write-HeadlessLog -Message "YouTube authentication check failed with exit code $authExitCode."
  return $authFailureExitCode
}

function Show-SlotFailure {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SlotLabel,

    [Parameter(Mandatory = $true)]
    [string]$Detail
  )

  Write-HeadlessLog -Message "$SlotLabel failed: $Detail"
  $popup = New-Object -ComObject WScript.Shell
  $message = "$SlotLabel failed.`n`n$Detail`n`nCheck automation.log for the complete output."
  $popup.Popup(
    $message,
    0,
    "V-GEN $projectLabel Daily Batch Failure",
    0 + 16 + 4096
  ) | Out-Null
}

function Get-IstPublishAt {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Hour,

    [Parameter(Mandatory = $true)]
    [int]$DayOffset,

    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $ist = [System.TimeZoneInfo]::FindSystemTimeZoneById("India Standard Time")
  $nowUtc = [DateTime]::UtcNow
  $nowIst = [System.TimeZoneInfo]::ConvertTimeFromUtc($nowUtc, $ist)
  $localTarget = [DateTime]::SpecifyKind(
    $nowIst.Date.AddDays($DayOffset).AddHours($Hour),
    [DateTimeKind]::Unspecified
  )
  $targetUtc = [System.TimeZoneInfo]::ConvertTimeToUtc($localTarget, $ist)
  if ($targetUtc -le $nowUtc) {
    throw "$Label has already passed. Run the daily batch earlier in the day."
  }
  return $targetUtc.ToString("yyyy-MM-ddTHH:mm:ssZ")
}

function Invoke-GenerationSlot {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SlotLabel,

    [string]$PublishAt
  )

  for ($attempt = 1; $attempt -le $maxAttempts; $attempt += 1) {
    $pythonArguments = @("--slot-label", $SlotLabel)
    if (-not [string]::IsNullOrWhiteSpace($PublishAt)) {
      $pythonArguments += @("--publish-at", $PublishAt)
    }
    if ($attempt -gt 1) {
      $pythonArguments += "--contingency-retry"
    }

    $exitCode = Invoke-AutomationAttempt `
      -Attempt $attempt `
      -SlotLabel $SlotLabel `
      -PythonArguments $pythonArguments

    if ($exitCode -eq 0) {
      Write-HeadlessLog -Message "$SlotLabel completed successfully."
      return 0
    }

    if ($exitCode -eq $authFailureExitCode) {
      if (Invoke-YouTubeAuthRecovery) {
        $attempt -= 1
        continue
      }
      Show-SlotFailure -SlotLabel $SlotLabel -Detail "YouTube authentication could not be restored."
      return $authFailureExitCode
    }

    if ($exitCode -ne 10) {
      Show-SlotFailure -SlotLabel $SlotLabel -Detail "The slot exited with code $exitCode."
      return $exitCode
    }

    if ($attempt -eq $maxAttempts) {
      Show-SlotFailure `
        -SlotLabel $SlotLabel `
        -Detail "Video generation failed after all $maxAttempts independent attempts."
      return 10
    }

    Write-HeadlessLog -Message "$SlotLabel will retry after pre-video generation failure."
  }

  return 10
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

  Write-HeadlessLog -Message "YouTube reauthentication succeeded. Resuming the daily batch."
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
  Write-HeadlessLog -Message "V-GEN $projectLabel automation starting." -Reset

  $authExitCode = Invoke-YouTubeAuthCheck
  if ($authExitCode -ne 0) {
    if (-not (Invoke-YouTubeAuthRecovery)) {
      exit $authFailureExitCode
    }
    $authExitCode = Invoke-YouTubeAuthCheck
    if ($authExitCode -ne 0) {
      exit $authFailureExitCode
    }
  }

  if ($SingleVideo) {
    $exitCode = Invoke-GenerationSlot -SlotLabel "Manual immediate video"
    exit $exitCode
  }

  if ($PdfOnly) {
    $exitCode = Invoke-PdfOmniUpload
    if ($exitCode -eq $authFailureExitCode) {
      if (Invoke-YouTubeAuthRecovery) {
        $exitCode = Invoke-PdfOmniUpload
      }
    }
    if ($exitCode -ne 0) {
      Show-SlotFailure `
        -SlotLabel "Manual PDFomni video" `
        -Detail "The PDFomni upload exited with code $exitCode."
    }
    exit $exitCode
  }

  $env:VGEN_RUN_PUBLISH_AFTER_UPLOAD = "true"
  $pdfPublishAt = Get-IstPublishAt `
    -Hour 20 `
    -DayOffset 0 `
    -Label "The 8:00 PM IST PDFomni publishing slot"
  $secondVideoPublishAt = Get-IstPublishAt `
    -Hour 4 `
    -DayOffset 1 `
    -Label "The next-day 4:00 AM IST generated-video publishing slot"

  $exitCode = Invoke-GenerationSlot -SlotLabel "Main video 1 (immediate)"
  if ($exitCode -ne 0) {
    exit $exitCode
  }

  $exitCode = Invoke-PdfOmniUpload -PublishAt $pdfPublishAt
  if ($exitCode -eq $authFailureExitCode) {
    if (Invoke-YouTubeAuthRecovery) {
      $exitCode = Invoke-PdfOmniUpload -PublishAt $pdfPublishAt
    }
  }
  if ($exitCode -ne 0) {
    Show-SlotFailure `
      -SlotLabel "Main PDFomni video (scheduled 8:00 PM IST)" `
      -Detail "The PDFomni upload exited with code $exitCode."
    exit $exitCode
  }

  $exitCode = Invoke-GenerationSlot `
    -SlotLabel "Main video 2 (scheduled 4:00 AM IST next day)" `
    -PublishAt $secondVideoPublishAt
  if ($exitCode -ne 0) {
    exit $exitCode
  }

  Write-HeadlessLog -Message "V-GEN Main daily batch completed successfully."
  exit $exitCode
} catch {
  Write-HeadlessLog -Message ("Headless wrapper failure: " + $_.Exception.Message)
  Show-SlotFailure -SlotLabel "Main daily batch setup" -Detail $_.Exception.Message
  exit 1
} finally {
  if ($hasMutex) {
    Clear-AutomationState
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}
