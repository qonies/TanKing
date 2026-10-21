# M5：TanKing 局域网防火墙放行（需管理员权限运行）
# 用法：npm run firewall（或管理员 PowerShell: powershell -ExecutionPolicy Bypass -File scripts/firewall.ps1）
$port = if ($env:PORT) { $env:PORT } else { 3000 }
$rule = "TanKing Game Server"

$existing = netsh advfirewall firewall show rule name="$rule" 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "防火墙规则 '$rule' 已存在，跳过"
} else {
    netsh advfirewall firewall add rule name="$rule" dir=in action=allow protocol=TCP localport=$port
    if ($LASTEXITCODE -eq 0) {
        Write-Host "已放行 TCP $port（规则名 '$rule'）"
    } else {
        Write-Error "放行失败：请以管理员身份运行"
        exit 1
    }
}