Option Explicit

Dim shell, repoDir, powerShellExe, scriptPath, quote, command, exitCode
Dim showProgress, stopActiveRun, argumentValue, i, windowStyle

repoDir = "H:\Github Repositories\AIVideoMaker\India"
powerShellExe = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
scriptPath = repoDir & "\run_automation_headless.ps1"
quote = Chr(34)
showProgress = False
stopActiveRun = False

For i = 0 To WScript.Arguments.Count - 1
  argumentValue = LCase(Trim(WScript.Arguments(i)))
  If argumentValue = "show" Or argumentValue = "visible" Or argumentValue = "progress" Then
    showProgress = True
  End If
  If argumentValue = "stop" Then
    stopActiveRun = True
  End If
Next

windowStyle = 0
command = quote & powerShellExe & quote & " -NoProfile -ExecutionPolicy Bypass"
If stopActiveRun Then
  command = command & " -File " & quote & scriptPath & quote & " -StopActiveRun"
ElseIf showProgress Then
  windowStyle = 1
  command = command & " -File " & quote & scriptPath & quote & " -ShowProgress"
Else
  command = command & " -WindowStyle Hidden -File " & quote & scriptPath & quote
End If

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = repoDir

' Window style 0 keeps the PowerShell host hidden unless progress was requested.
exitCode = shell.Run(command, windowStyle, True)
WScript.Quit exitCode
