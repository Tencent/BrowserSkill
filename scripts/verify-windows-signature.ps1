[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedSha256
)

$ErrorActionPreference = 'Stop'
$binary = (Resolve-Path -LiteralPath $Path).Path
$hash = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne $ExpectedSha256.ToLowerInvariant()) {
    throw "Signed binary SHA256 mismatch: $hash"
}

$signature = Get-AuthenticodeSignature -LiteralPath $binary
if ($signature.Status -ne 'Valid') {
    throw "Authenticode verification failed: $($signature.Status): $($signature.StatusMessage)"
}
$publisher = $signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
if ($publisher -cne 'Tencent Technology (Shenzhen) Company Limited') {
    throw "Unexpected Windows publisher: $publisher"
}
if (-not $signature.TimeStamperCertificate) {
    throw 'The Windows executable must have a trusted Authenticode timestamp'
}

$signTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" |
    Sort-Object { [version]$_.Directory.Parent.Name } -Descending |
    Select-Object -First 1
if (-not $signTool) {
    throw 'Windows SDK signtool.exe was not found'
}
& $signTool.FullName verify /pa /all /v /tw $binary
if ($LASTEXITCODE -ne 0) {
    throw "SignTool verification failed with exit code $LASTEXITCODE"
}

[ordered]@{
    sha256 = $hash
    status = $signature.Status.ToString()
    publisher = $publisher
    signer_thumbprint = $signature.SignerCertificate.Thumbprint
    timestamp_authority = $signature.TimeStamperCertificate.Subject
} | ConvertTo-Json
