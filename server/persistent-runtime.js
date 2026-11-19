'use strict';

const { authorizeVersionedPersistentRoot } = require('./persistent-authorization');

// The persistent launcher is the only startup path that reads a runtime
// authorization file. node server.js does not. The default bind is loopback.
// Listening on every interface is refused here.

class PersistentRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PersistentRuntimeError';
    this.code = code;
  }
}

function bindAddress(value) {
  if (value === undefined || value === null || value === '') return '127.0.0.1';
  if (typeof value !== 'string') {
    throw new PersistentRuntimeError('public-bind', 'The persistent runtime needs a specific bind address.');
  }
  const host = value.trim();
  if (host === '' || host === '0.0.0.0' || host === '::' || host === '*') {
    throw new PersistentRuntimeError(
      'public-bind',
      'The persistent runtime does not listen on every network interface.',
    );
  }
  return host;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

async function startPersistentRuntime(options) {
  const settings = options || {};
  const host = bindAddress(settings.bindAddress);
  const port = settings.port === undefined ? 0 : settings.port;
  const token = authorizeVersionedPersistentRoot({ configPath: settings.configPath });
  const { createPrompterServer } = require('../server');
  const created = await createPrompterServer({
    persistentRoot: token,
    scriptFile: token.scriptFile,
    previousFile: token.previousFile,
    libraryDir: token.libraryDir,
    journalDir: token.journalDir,
    staffToken: settings.staffToken,
  });
  await listen(created.server, port, host);
  return Object.assign(created, { host, token });
}

module.exports = {
  PersistentRuntimeError,
  bindAddress,
  startPersistentRuntime,
};
