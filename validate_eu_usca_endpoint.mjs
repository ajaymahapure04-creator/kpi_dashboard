import { spawn } from 'child_process';
import http from 'http';

const serverProcess = spawn('node', ['server.js'], {
  cwd: 'c:\\Data\\Important\\kpi_dashboard',
  stdio: ['ignore', 'pipe', 'pipe'],
});

function waitForPort(port, timeout = 10000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.request({ hostname: 'localhost', port, path: '/', method: 'GET', timeout: 2000 }, () => {
        req.destroy();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error('Timed out waiting for server')); 
        } else {
          setTimeout(check, 200);
        }
      });
      req.end();
    };
    check();
  });
}

function killServer() {
  return new Promise((resolve) => {
    serverProcess.kill();
    serverProcess.on('exit', resolve);
    setTimeout(resolve, 2000);
  });
}

(async () => {
  try {
    await waitForPort(5001);
    const res = await fetch('http://localhost:5001/api/fact_main_eu_usca_combined?limit=5');
    const text = await res.text();
    console.log('status', res.status);
    console.log(text);
  } catch (err) {
    console.error('ERR', err.message);
    process.exitCode = 1;
  } finally {
    await killServer();
  }
})();
