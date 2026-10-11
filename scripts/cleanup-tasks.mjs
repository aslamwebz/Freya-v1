import { execSync } from 'child_process';

try {
  const json = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = \'node.exe\'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"', { encoding: 'utf-8' });
  const data = JSON.parse(json);
  const list = Array.isArray(data) ? data : [data];
  let killed = 0;
  for (const proc of list) {
    if (proc && proc.CommandLine && proc.CommandLine.includes(' -e ') && proc.ProcessId !== process.pid) {
      try {
        process.kill(proc.ProcessId, 'SIGKILL');
        killed++;
      } catch (e) {
        // ignore
      }
    }
  }
  console.log(`Killed ${killed} lingering node scripts.`);
} catch (err) {
  console.error('Cleanup error:', err.message);
}
