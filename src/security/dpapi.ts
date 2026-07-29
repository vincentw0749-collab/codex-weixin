import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INPUT_ENV = "CODEX_WEIXIN_DPAPI_INPUT";

export interface SecretProtector {
  protect(secret: string): Promise<string>;
  unprotect(ciphertext: string): Promise<string>;
}

export class WindowsDpapiProtector implements SecretProtector {
  async protect(secret: string): Promise<string> {
    if (!secret) throw new Error("API key cannot be empty");
    return runDpapi(
      "Add-Type -AssemblyName System.Security;" +
      "$bytes=[Text.Encoding]::UTF8.GetBytes($env:CODEX_WEIXIN_DPAPI_INPUT);" +
      "$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
      "[Console]::Out.Write([Convert]::ToBase64String($protected))",
      secret,
      "Unable to encrypt API key"
    );
  }

  async unprotect(ciphertext: string): Promise<string> {
    if (!ciphertext) throw new Error("Unable to decrypt API key");
    return runDpapi(
      "Add-Type -AssemblyName System.Security;" +
      "$bytes=[Convert]::FromBase64String($env:CODEX_WEIXIN_DPAPI_INPUT);" +
      "$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
      "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))",
      ciphertext,
      "Unable to decrypt API key"
    );
  }
}

async function runDpapi(script: string, input: string, failureMessage: string): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error(`${failureMessage}: Windows DPAPI is unavailable`);
  }
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script
    ], {
      encoding: "utf8",
      env: { ...process.env, [INPUT_ENV]: input },
      maxBuffer: 64 * 1024,
      timeout: 15_000,
      windowsHide: true
    });
    const result = stdout.trim();
    if (!result) throw new Error("empty result");
    return result;
  } catch {
    throw new Error(failureMessage);
  }
}
