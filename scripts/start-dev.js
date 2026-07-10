import { spawn } from 'node:child_process';
import process from 'node:process';

const processes = [];
const commands = [
  { name: 'backend', cmd: 'node', args: ['server.js'] },
  { name: 'frontend', cmd: process.platform === 'win32' ? 'cmd.exe' : 'npm', args: process.platform === 'win32' ? ['/c', 'npm', 'run', 'dev'] : ['run', 'dev'] }
];

function createProcess({ name, cmd, args }) {
  const child = spawn(cmd, args, {
    stdio: ['inherit', 'inherit', 'inherit'],
    shell: false,
    cwd: process.cwd()
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      console.log(`${name} exited with signal ${signal}`);
    } else {
      console.log(`${name} exited with code ${code}`);
    }
    shutdown();
  });

  child.on('error', (err) => {
    console.error(`${name} failed to start:`, err);
    shutdown(1);
  });

  return child;
}

function shutdown(exitCode = 0) {
  processes.forEach((proc) => {
    if (!proc.killed) {
      proc.kill('SIGTERM');
    }
  });
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

for (const command of commands) {
  processes.push(createProcess(command));
}

console.log('Started backend and frontend. Press Ctrl+C to stop.');
