const { app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Odak yazı alanına geçince telefonda klavyeyi açabilmek için yardımcı süreç.
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$types = [System.Windows.Automation.ControlType]
$last = ''
while ($true) {
  $state = '0'
  try {
    $current = [System.Windows.Automation.AutomationElement]::FocusedElement.Current
    if ($current.ControlType -eq $types::Edit -or $current.ControlType -eq $types::ComboBox) { $state = '1' }
    elseif ($current.ControlType -eq $types::Document -and $current.ClassName -match 'RichEdit|_WwG|Scintilla') { $state = '1' }
  } catch { }
  if ($state -ne $last) {
    $last = $state
    [Console]::Out.WriteLine($state)
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 250
}
`;

function launch() {
  if (process.platform === 'win32') {
    const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
    return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  }
  const helper = app.isPackaged ? path.join(process.resourcesPath, 'focus-mac') : path.join(__dirname, '..', 'native', 'focus-mac');
  if (!fs.existsSync(helper)) return null;
  return spawn(helper, [], { stdio: ['ignore', 'pipe', 'ignore'] });
}

function createFocusWatcher(onChange) {
  let child = null;
  return {
    start() {
      if (child) return;
      child = launch();
      if (!child) return;
      child.on('error', (e) => console.error('focus:', e.message));
      child.stdout.on('data', (data) => {
        const state = String(data).trim().split(/\s+/).pop();
        if (state === '0' || state === '1') onChange(state === '1');
      });
    },
    stop() {
      child?.kill();
      child = null;
    },
  };
}

module.exports = { createFocusWatcher };
