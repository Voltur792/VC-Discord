$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.IO.Compression.FileSystem
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$archivePath = [System.IO.Path]::GetFullPath([string]$request.archive)
$destination = [System.IO.Path]::GetFullPath([string]$request.destination)
$jobRoot = [System.IO.Path]::GetDirectoryName($archivePath)
if ($destination -ne [System.IO.Path]::Combine($jobRoot, 'unpacked')) { throw 'Invalid destination' }
[System.IO.Directory]::CreateDirectory($destination) | Out-Null
$zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    $programs = @($zip.Entries | Where-Object { $_.FullName -match '^[^/]+/bin/ffmpeg\.exe$' })
    $licenses = @($zip.Entries | Where-Object { $_.FullName -match '^[^/]+/LICENSE$' })
    if ($programs.Count -ne 1 -or $licenses.Count -ne 1) { throw 'Invalid FFmpeg archive' }
    if ($programs[0].Length -gt 350000000 -or $licenses[0].Length -gt 1000000) { throw 'Archive entry too large' }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($licenses[0], [System.IO.Path]::Combine($destination, 'LICENSE.txt'))
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($programs[0], [System.IO.Path]::Combine($destination, 'ffmpeg.exe'))
    $readme = @($zip.Entries | Where-Object { $_.FullName -match '^[^/]+/README\.txt$' })
    if ($readme.Count -eq 1 -and $readme[0].Length -le 1000000) {
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($readme[0], [System.IO.Path]::Combine($destination, 'README.txt'))
    }
} finally { $zip.Dispose() }
