# Installs the Vultr Serverless Inference API key on the ProofOps VM without it touching chat, Git, shell
# history, the command line, or the browser worker.
#
# Run this yourself in PowerShell on your PC:
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

$secure = Read-Host -Prompt "Vultr Serverless Inference API key (hidden)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ([string]::IsNullOrWhiteSpace($plain) -or $plain -match '\s') { throw "The key is empty or contains whitespace." }

  # The remote side reads one line from stdin. Nothing is echoed, and the key is never part of a command line.
  $remote = 'set -eu; umask 077; install -d -m 750 -o root -g proofops /etc/proofops; ' +
            'IFS= read -r k; printf "PROOFOPS_INFERENCE_API_KEY=%s\n" "$k" > /etc/proofops/inference.env.tmp; ' +
            'chown proofops:proofops /etc/proofops/inference.env.tmp; mv /etc/proofops/inference.env.tmp /etc/proofops/inference.env; ' +
            'stat -c "%U %a %s bytes" /etc/proofops/inference.env'
  $plain | & ssh -i $KeyFile -o IdentitiesOnly=yes "$User@$VmHost" $remote
  if ($LASTEXITCODE -ne 0) { throw "ssh failed with exit code $LASTEXITCODE" }
  Write-Host "Key installed. Nothing was printed or stored on this PC."
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable plain -ErrorAction SilentlyContinue
}
