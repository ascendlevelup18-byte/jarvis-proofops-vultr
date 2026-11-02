// Static guards for operator scripts that touch credentials or the live demo (PowerShell is not
// available in CI, so the smoke test is checked structurally; the demo verifier runs for real elsewhere).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const root = new URL("../../../", import.meta.url);
const ps = readFileSync(new URL("scripts/tokenfactory-smoke.ps1", root), "utf8");
const verify = readFileSync(new URL("scripts/verify-demo.mjs", root), "utf8");
const code = ps.replace(/<#[\s\S]*?#>/, "").replace(/^\s*#.*$/gm, "");

describe("tokenfactory-smoke.ps1", () => {
  test("reads the key as a SecureString and releases it in finally", () => {
    assert.match(code, /Read-Host[^\n]*-AsSecureString/);
    assert.match(code, /finally\s*\{[\s\S]*ZeroFreeBSTR\(\$bstr\)[\s\S]*Remove-Variable/);
  });

  test("never prints or writes the key, headers or bearer value", () => {
    for (const line of code.split("\n").filter((l) => /Write-(Host|Output)|Out-File|Set-Content|Add-Content|Export-|Tee-Object/.test(l))) {
      assert.doesNotMatch(line, /\$headers|\$secure|\$bstr|\$typed|Bearer|Authorization|PtrToStringBSTR/, line.trim());
      // The plain key may be described only by its length.
      assert.doesNotMatch(line.replace(/\$script:keyText\.Length/g, ""), /keyText/, line.trim());
    }
    assert.doesNotMatch(code, /Out-File|Set-Content|Add-Content|Export-Clixml|Tee-Object/);
    assert.doesNotMatch(code, /\$env:JARVIS_MODEL_API_KEY\s*=/);
  });

  test("hardcodes no endpoint host; the base URL is a mandatory parameter", () => {
    assert.match(code, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$BaseUrl/);
    assert.doesNotMatch(code, /https?:\/\/(?!\.\+|\(localhost)[a-z0-9-]+\.[a-z]/i);
  });

  test("OpenAI-compatible calls with timeouts, model discovery and TLS 1.2 on Windows PowerShell 5.1", () => {
    assert.match(code, /"\$BaseUrl\/models"/);
    assert.match(code, /"\$BaseUrl\/chat\/completions"/);
    assert.match(code, /"\$BaseUrl\/usage\?include_recent=true"/);
    assert.equal((code.match(/-TimeoutSec (\d+|\$ChatTimeoutSec)/g) ?? []).length, 4);
    assert.match(code, /-cnotcontains \$Model/);
    assert.match(code, /Tls12/);
    assert.doesNotMatch(code, /(?<!\{)\$Model:/, "a bare \"$Model:\" is a parse error in PowerShell; use ${Model}:");
  });

  test("checks the key shape before any authenticated call and uses distinct exit codes", () => {
    assert.match(code, /\$KeyPattern = '\^rc-\[0-9a-fA-F\]\{48\}\$'/);
    assert.ok(code.indexOf("$KeyPattern -and") < code.indexOf("$headers = @{"), "format check precedes the first use of the key");
    for (const n of [0, 2, 3, 4, 5, 6, 7, 8, 9, 10]) assert.match(code, new RegExp(`(exit|return) ${n}\\b`), `exit code ${n}`);
    assert.doesNotMatch(code, /exit 1\b/, "exit 1 is reserved for unexpected PowerShell errors");
  });

  test("source is ASCII, so Windows PowerShell 5.1 reads it the same as PowerShell 7", () => {
    assert.ok(/^[\x00-\x7f]*$/.test(ps));
  });
});

describe("tokenfactory-smoke.ps1: Windows PowerShell 5.1 compatibility (static)", () => {
  test("uses no PowerShell 7-only syntax or parameters", () => {
    const forbidden: [RegExp, string][] = [
      [/\?\?/, "null-coalescing ??"],
      [/\?\./, "null-conditional ?."],
      [/\s\?\s[^:]+\s:\s/, "ternary ? :"],
      [/&&|\|\|/, "pipeline chain && / ||"],
      [/-AsPlainText/, "ConvertFrom-SecureString -AsPlainText (PS 7)"],
      [/-Parallel/, "ForEach-Object -Parallel"],
      [/-SkipHttpErrorCheck|-StatusCodeVariable|-ResponseHeadersVariable/, "PS 7 web cmdlet parameters"],
      [/-AsHashtable/, "ConvertFrom-Json -AsHashtable"],
    ];
    for (const [re, what] of forbidden) assert.doesNotMatch(code, re, what);
  });

  test("web calls work on 5.1: basic parsing and explicit TLS 1.2 before the first request", () => {
    assert.match(code, /Invoke-WebRequest -UseBasicParsing/);
    assert.ok(code.indexOf("Tls12") < code.indexOf("Invoke-WebRequest"), "TLS must be set before the first request");
    assert.match(code, /\$PSVersionTable\.PSVersion\.Major -lt 6/);
  });

  test("empty model lists and malformed replies are handled explicitly", () => {
    assert.match(code, /\$ids\.Count -eq 0/);
    assert.match(code, /\$r\.choices -and \$r\.choices\[0\]\.message/);
    assert.match(code, /-not \$content -or -not \("" \+ \$content\)\.Trim\(\)/);
  });
});

describe("verify-demo.mjs", () => {
  test("never prints the bypass secret and only sends the public demo requests", () => {
    assert.doesNotMatch(verify, /console\.(log|error)\([^)]*(extra|BYPASS)/);
    assert.match(verify, /supportRequest\.message/);
    assert.doesNotMatch(verify, /JARVIS_CASES_TOKEN|Authorization/);
  });
});
