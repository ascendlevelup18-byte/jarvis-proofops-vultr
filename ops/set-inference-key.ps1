# Installs the Vultr Serverless Inference API key on the ProofOps VM without it touching chat, Git, shell
# history, the command line, or the browser worker.
#
# Run this yourself in PowerShell on your PC, after the VM's host key is in known_hosts (see ops/DAY1-RUNBOOK.md):
#   powershell -ExecutionPolicy Bypass -File ops\set-inference-key.ps1 -VmHost <vm-ip>
#
# The key is read with a hidden prompt, sent once over SSH on stdin, and written by the VM to
# /etc/proofops/inference.env (owner proofops, mode 600). Only the control-plane service reads that file;
# worker containers are started with an empty environment and never mount /etc/proofops.
param(
  [Parameter(Mandatory = $true)][string]$VmHost,
  [string]$KeyFile = "$env:USERPROFILE\.ssh\proofops_vultr_ed25519",
  [string]$User = "root"
)
$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 pipes text to native programs with $OutputEncoding, which can add a BOM, and appends CRLF.
# Use UTF-8 without BOM; the remote side also strips CR and BOM bytes.
$OutputEncoding = New-Object System.Text.UTF8Encoding $false

$secure = Read-Host -Prompt "Vultr Serverless Inference API key (hidden)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ($plain -notmatch '^[A-Za-z0-9._-]{16,256}$') { throw "Unexpected key format (expected 16-256 letters, digits, dot, dash or underscore). Nothing was sent." }

  # Windows PowerShell 5.1 strips double quotes from native-command arguments, so the remote command uses none.
  # The key is never part of a command line; it is read from stdin.
  # IFS is emptied so unquoted $k is never split into words (a key with spaces is rejected, not merged).
  $remote = 'set -euf; IFS=; umask 077;install -d -m 750 -o root -g proofops /etc/proofops; ' +
            'IFS= read -r k; k=$(printf %s $k | tr -d ''\r\357\273\277''); ' +
            'case $k in *[!A-Za-z0-9._-]*|'''') echo bad-key-format; exit 3;; esac; ' +
            'printf ''PROOFOPS_INFERENCE_API_KEY=%s\n'' $k > /etc/proofops/inference.env.tmp; ' +
            'chown proofops:proofops /etc/proofops/inference.env.tmp; mv /etc/proofops/inference.env.tmp /etc/proofops/inference.env; ' +
            'stat -c ''%U %a %s bytes'' /etc/proofops/inference.env'
  $plain | & ssh -i $KeyFile -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o BatchMode=yes "$User@$VmHost" $remote
  if ($LASTEXITCODE -ne 0) { throw "ssh failed with exit code $LASTEXITCODE (host key not yet trusted, wrong host, or bad key format)" }
  Write-Host "Key installed. Nothing was printed or stored on this PC."
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable plain -ErrorAction SilentlyContinue
}
