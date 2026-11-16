import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const moduleUrl = file => pathToFileURL(path.join(process.cwd(), file)).href;
export const artifact = file => path.join(tmpdir(), file);
export function chromeOptions() {
  const candidates = process.platform === 'win32'
    ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map(base => path.join(base, 'Google/Chrome/Application/chrome.exe'))
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
  const executablePath = process.env.CHROME_EXECUTABLE || candidates.find(existsSync);
  if (!executablePath) throw new Error('Set CHROME_EXECUTABLE to your installed Chrome executable.');
  return { executablePath, headless: process.env.HEADED !== '1' };
}
