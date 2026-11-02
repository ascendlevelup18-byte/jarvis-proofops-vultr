"""Run a PowerShell script under a pseudo-terminal and type a secret at its Read-Host prompt,
the way a person would (Read-Host -AsSecureString ignores piped stdin). Answers the terminal's
cursor-position queries. Prints JSON {"code": int, "output": str}. Test helper only."""
import json, os, pty, sys, time

pwsh, prompt, secret, *args = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(pwsh, [pwsh, "-NoProfile", *args])
out, sent, start = b"", False, time.time()
while time.time() - start < 90:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    for _ in range(chunk.count(b"\x1b[6n")):
        os.write(fd, b"\x1b[1;1R")
    if not sent and prompt.encode() in out:
        time.sleep(0.2)
        os.write(fd, secret.encode() + b"\r")
        sent = True
_, status = os.waitpid(pid, 0)
text = out.decode(errors="replace").replace("\x1b[6n", "")
for seq in ("\x1b[39;49m", "\x1b[31;1m", "\x1b[0m", "\x1b[91m", "\x1b[31m", "\x1b[?1h", "\x1b[?1l"):
    text = text.replace(seq, "")
print(json.dumps({"code": os.waitstatus_to_exitcode(status), "output": text}))
