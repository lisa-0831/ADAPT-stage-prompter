'use strict';

const { parentPort, workerData } = require('worker_threads');
const { spawn } = require('child_process');

const status = new Int32Array(workerData.status);
const child = spawn('perl', ['-e', workerData.script, workerData.lockPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buffer = '';
let ready = false;

function publish(code) {
  Atomics.store(status, 0, code);
  Atomics.notify(status, 0);
}

function noteExit() {
  Atomics.store(status, 1, 1);
  Atomics.notify(status, 1);
}

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  if (ready) return;
  buffer += chunk;
  const newline = buffer.indexOf('\n');
  if (newline < 0) return;
  ready = true;
  const line = buffer.slice(0, newline).trim();
  const codes = { READY: 1, BUSY: 2, SYMLINK: 3, UNSUPPORTED: 4, STOLEN: 5 };
  publish(codes[line] || 6);
});
child.on('error', () => {
  if (!ready) publish(7);
  noteExit();
});
child.on('exit', () => {
  if (!ready) publish(7);
  noteExit();
});
parentPort.on('message', (message) => {
  if (message !== 'release') return;
  try {
    child.stdin.end();
  } catch (err) {
    child.kill('SIGKILL');
  }
});
parentPort.on('close', () => {
  child.kill('SIGKILL');
});
