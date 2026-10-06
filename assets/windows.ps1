$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.action -eq 'protect' -or $request.action -eq 'unprotect') {
        Add-Type -AssemblyName System.Security
        $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        if ($request.action -eq 'protect') {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$request.value)
            $protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
            [Console]::Out.Write([Convert]::ToBase64String($protected))
        } else {
            $bytes = [Convert]::FromBase64String([string]$request.value)
            $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)
            [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))
        }
        exit 0
    }
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        if ($request.action -eq 'voices') {
            $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
                @{ name = $_.VoiceInfo.Name; language = $_.VoiceInfo.Culture.Name }
            })
            [Console]::Out.Write((ConvertTo-Json -InputObject $voices -Compress))
        } elseif ($request.action -eq 'speak') {
            if ($request.voice) { $synth.SelectVoice([string]$request.voice) }
            else {
                $ru = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'ru-RU' } | Select-Object -First 1
                if ($ru) { $synth.SelectVoice($ru.VoiceInfo.Name) }
            }
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
    if ($request.action -eq 'unprotect') { [Console]::Error.WriteLine('DVOICE_UNPROTECT_FAILED') }
    else { [Console]::Error.WriteLine('Windows service request failed.') }
    exit 1
}
