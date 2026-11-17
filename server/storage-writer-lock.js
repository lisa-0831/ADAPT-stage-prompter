'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

// One canonical library directory has one kernel flock. The lock is held by
// a helper process whose stdin is this process, so the kernel releases it
// when this process dies. The helper is never told to delete the lock file,
// and a PID inside that file is never consulted. A second process fails
// closed with writer-locked before it opens writable storage. The in-process
// count lets startup and a nested save share the helper; it is not a
// substitute for the kernel lock.

const LOCK_NAME = '.writer.lock';
const WORKER = path.join(__dirname, 'storage-writer-lock-worker.js');
const PERL = String.raw`
use strict;
use Fcntl qw(:flock O_RDWR O_CREAT O_NOFOLLOW);
my $path = $ARGV[0];
sysopen(my $fh, $path, O_RDWR | O_CREAT | O_NOFOLLOW, 0600) or do {
  if ($!{ELOOP}) { print "SYMLINK\n"; exit 3; }
  if ($!{ENOTSUP} || $!{EOPNOTSUPP}) { print "UNSUPPORTED\n"; exit 4; }
  print "ERROR\n";
  exit 1;
};
unless (flock($fh, LOCK_EX | LOCK_NB)) {
  if ($!{EWOULDBLOCK} || $!{EAGAIN}) { print "BUSY\n"; exit 2; }
  if ($!{ENOTSUP} || $!{EOPNOTSUPP}) { print "UNSUPPORTED\n"; exit 4; }
  print "ERROR\n";
  exit 1;
}
my @opened = stat($fh);
my @named = lstat($path);
if (!@named || -l $path || $opened[0] != $named[0] || $opened[1] != $named[1]) {
  print "STOLEN\n";
  exit 5;
}
select STDOUT;
$| = 1;
print "READY\n";
while (1) {
  my $n = sysread(STDIN, my $buf, 4096);
  exit 0 if !defined($n) || $n == 0;
}
`;
const holders = new Map();

class StorageWriterLockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StorageWriterLockError';
    this.code = code;
  }
}

function fail(code, message) {
  return new StorageWriterLockError(code, message);
}

function resolveLibrary(libraryDir) {
  if (typeof libraryDir !== 'string' || libraryDir.length === 0 || libraryDir.includes('\0') || !path.isAbsolute(libraryDir)) {
    throw fail('unsafe-lock', 'The storage lock needs the library directory as an absolute path.');
  }
  const lexical = path.resolve(libraryDir);
  let stat;
  try {
    stat = fs.lstatSync(lexical);
  } catch (err) {
    stat = null;
  }
  if (!stat) throw fail('unsafe-lock', 'The storage lock needs a real library directory.');
  let libraryReal;
  try {
    libraryReal = fs.realpathSync(lexical);
  } catch (err) {
    throw fail('unsafe-lock', 'The library directory could not be resolved.');
  }
  let realStat;
  try {
    realStat = fs.lstatSync(libraryReal);
  } catch (err) {
    throw fail('unsafe-lock', 'The library directory could not be resolved.');
  }
  if (!realStat.isDirectory() || realStat.isSymbolicLink()) {
    throw fail('unsafe-lock', 'The storage lock needs a real library directory.');
  }
  const lockPath = path.join(libraryReal, LOCK_NAME);
  const relative = path.relative(libraryReal, lockPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw fail('unsafe-lock', 'The storage lock path escapes the library directory.');
  }
  let lockStat = null;
  try {
    lockStat = fs.lstatSync(lockPath);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw fail('unsafe-lock', 'The storage lock path could not be read.');
  }
  if (lockStat && (lockStat.isSymbolicLink() || !lockStat.isFile())) {
    throw fail('unsafe-lock', 'The storage lock must be a regular file. It was not replaced or removed.');
  }
  return { libraryReal, lockPath };
}

function waitFor(status, index, expected, timeoutMs) {
  if (Atomics.load(status, index) !== expected) return Atomics.load(status, index);
  const result = Atomics.wait(status, index, expected, timeoutMs);
  const value = Atomics.load(status, index);
  if (result === 'timed-out' && value === expected) return null;
  return value;
}

function releaseHolder(libraryReal) {
  const holder = holders.get(libraryReal);
  if (!holder) return;
  holder.count -= 1;
  if (holder.count > 0) return;
  holders.delete(libraryReal);
  if (Atomics.load(holder.status, 1) !== 1) {
    try {
      holder.worker.postMessage('release');
    } catch (err) {
      holder.worker.terminate();
    }
    waitFor(holder.status, 1, 0, 5000);
  }
  holder.worker.terminate();
}

function acquireStorageWriter(libraryDir) {
  const located = resolveLibrary(libraryDir);
  const existing = holders.get(located.libraryReal);
  if (existing) {
    if (existing.lost || Atomics.load(existing.status, 1) === 1) {
      existing.lost = true;
      holders.delete(located.libraryReal);
      throw fail('writer-lock-lost', 'The storage writer lock closed before the operation finished.');
    }
    existing.count += 1;
    let released = false;
    return {
      libraryReal: located.libraryReal,
      release() {
        if (released) return;
        released = true;
        releaseHolder(located.libraryReal);
      },
    };
  }
  const statusBuffer = new SharedArrayBuffer(8);
  const status = new Int32Array(statusBuffer);
  const worker = new Worker(WORKER, {
    workerData: { script: PERL, lockPath: located.lockPath, status: statusBuffer },
  });
  worker.unref();
  const code = waitFor(status, 0, 0, 5000);
  if (code !== 1) {
    worker.terminate();
    if (code === 2) {
      throw fail('writer-locked', 'Another process already owns this storage root.');
    }
    if (code === 3 || code === 5) {
      throw fail('unsafe-lock', 'The storage lock must be a regular file. It was not replaced or removed.');
    }
    throw fail('lock-unsupported', 'This filesystem cannot provide an exclusive storage lock.');
  }
  const holder = { count: 1, status, worker, lost: false };
  holders.set(located.libraryReal, holder);
  let released = false;
  return {
    libraryReal: located.libraryReal,
    release() {
      if (released) return;
      released = true;
      releaseHolder(located.libraryReal);
    },
  };
}

function lockAround(libraryDir, fn) {
  let hold;
  try {
    hold = acquireStorageWriter(libraryDir);
  } catch (err) {
    if (err instanceof StorageWriterLockError) {
      return { ok: false, status: 'refused', code: err.code, error: err.message };
    }
    throw err;
  }
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then((value) => {
        hold.release();
        hold = null;
        return value;
      }, (err) => {
        if (hold) hold.release();
        hold = null;
        throw err;
      });
    }
    hold.release();
    hold = null;
    return result;
  } catch (err) {
    if (hold) hold.release();
    throw err;
  }
}

module.exports = {
  LOCK_NAME,
  StorageWriterLockError,
  acquireStorageWriter,
  lockAround,
};
