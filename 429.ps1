param(
  [Parameter(Mandatory = $false)]
  [string] $BaseUrl = "https://app-sre-demo-cxd6gteufsb6hwa2.japanwest-01.azurewebsites.net",

  [Parameter(Mandatory = $false)]
  [int] $Seconds = 90,

  [Parameter(Mandatory = $false)]
  [int] $Parallel = 100,

  [Parameter(Mandatory = $false)]
  [int] $Items = 200,

  [Parameter(Mandatory = $false)]
  [ValidateSet('hot', 'spread')]
  [string] $Mode = 'hot',

  [Parameter(Mandatory = $false)]
  [string] $Pk = 'hot-1',

  [Parameter(Mandatory = $false)]
  [int] $RequestTimeoutSec = 10

  ,
  [Parameter(Mandatory = $false)]
  [switch] $UseIpWorkaround
)

$end = (Get-Date).AddSeconds($Seconds)
$counts = @{}

while ((Get-Date) -lt $end) {
  $baseUri = [Uri]$BaseUrl
  $hostName = $baseUri.Host
  $scheme = $baseUri.Scheme

  $targetHostOrIp = $hostName
  if ($UseIpWorkaround) {
    $ip = (Resolve-DnsName $hostName | Where-Object { $_.QueryType -eq 'A' } | Select-Object -First 1 -ExpandProperty IP4Address)
    if (-not $ip) { throw "Failed to resolve A record for host: $hostName" }
    $targetHostOrIp = $ip
  }

  $url = "${scheme}://$targetHostOrIp/burst?mode=$Mode&pk=$Pk&items=$Items"

  $jobs = 1..$Parallel | ForEach-Object {
    Start-Job -ScriptBlock {
      param($u, $timeoutSec, $sendHostHeader, $hostHeaderValue, $insecure)
      # Return HTTP status code only (e.g., 200/429/500)
      $nullDevice = if ($IsWindows) { 'NUL' } else { '/dev/null' }

      $args = @('-s', '-o', $nullDevice, '-w', '%{http_code}', '--max-time', [string]$timeoutSec)
      if ($insecure) { $args += '-k' }
      if ($sendHostHeader) { $args += @('-H', "Host: $hostHeaderValue") }
      $args += $u

      $code = & curl.exe @args
      if ($LASTEXITCODE -ne 0) {
        return "curl_exit_$LASTEXITCODE"
      }
      return [string]$code
    } -ArgumentList $url, $RequestTimeoutSec, [bool]$UseIpWorkaround, $hostName, [bool]$UseIpWorkaround
  }

  $statuses = $jobs | Wait-Job | Receive-Job
  $jobs | Remove-Job | Out-Null

  foreach ($s in $statuses) {
    $key = [string]$s
    if (-not $counts.ContainsKey($key)) { $counts[$key] = 0 }
    $counts[$key]++
  }

  $summary = $counts.GetEnumerator() | Sort-Object Name | ForEach-Object { "{0}:{1}" -f $_.Name, $_.Value }
  Write-Host ("[{0}] {1}" -f (Get-Date).ToString("HH:mm:ss"), ($summary -join ' '))
}