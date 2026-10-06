$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$stage = 'REQUEST_FAILED'
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.action -eq 'protect' -or $request.action -eq 'unprotect' -or $request.action -eq 'diagnostics') {
        $stage = 'SECURITY_ASSEMBLY'
        Add-Type -AssemblyName System.Security
        $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        if ($request.action -eq 'diagnostics') {
            $stage = 'PROTECT_FAILED'
            $probe = [System.Text.Encoding]::UTF8.GetBytes('vc-discord-local-diagnostics')
            $cipher = [System.Security.Cryptography.ProtectedData]::Protect($probe, $null, $scope)
            $stage = 'UNPROTECT_FAILED'
            $restored = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, $scope)
            $ok = [Convert]::ToBase64String($probe) -eq [Convert]::ToBase64String($restored)
            [Array]::Clear($probe, 0, $probe.Length)
            [Array]::Clear($restored, 0, $restored.Length)
            [Console]::Out.Write((ConvertTo-Json -InputObject @{ encryption = $ok } -Compress))
        } elseif ($request.action -eq 'protect') {
            $stage = 'PROTECT_FAILED'
            $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$request.value)
            $protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
            [Console]::Out.Write([Convert]::ToBase64String($protected))
        } else {
            $stage = 'UNPROTECT_FAILED'
            $bytes = [Convert]::FromBase64String([string]$request.value)
            $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)
            [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))
        }
        exit 0
    }
    $stage = 'SPEECH_ASSEMBLY'
    Add-Type -AssemblyName System.Speech
    $stage = 'SPEECH_INIT'
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        if ($request.action -eq 'voices') {
            $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
                @{ name = $_.VoiceInfo.Name; language = $_.VoiceInfo.Culture.Name }
            })
            [Console]::Out.Write((ConvertTo-Json -InputObject $voices -Compress))
        } elseif ($request.action -eq 'speak') {
            $stage = 'VOICE_FAILED'
            if ($request.voice) { $synth.SelectVoice([string]$request.voice) }
            else {
                $ru = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'ru-RU' } | Select-Object -First 1
                if ($ru) { $synth.SelectVoice($ru.VoiceInfo.Name) }
            }
            $stage = 'SPEAK_FAILED'
            $synth.Rate = [Math]::Max(-5, [Math]::Min(5, [int]$request.rate))
            $stream = New-Object System.IO.MemoryStream
            try {
                $synth.SetOutputToWaveStream($stream)
                $synth.Speak([string]$request.text)
                $synth.SetOutputToNull()
                $bytes = $stream.ToArray()
                [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
            } finally { $stream.Dispose() }
        } else { throw 'Unknown request' }
    } finally { $synth.Dispose() }
} catch {
    [Console]::Error.WriteLine(('DVOICE_' + $stage))
    if ($_.FullyQualifiedErrorId -match 'ConstrainedLanguage|CannotDefineNewType') { [Console]::Error.WriteLine('DVOICE_ConstrainedLanguage') }
    exit 1
}
