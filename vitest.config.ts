import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The hyperswarm integration test drives real UDP sockets via udx-native,
    // which misbehave inside worker_threads — run that file as a child process.
    poolMatchGlobs: [
      ['**/p2p.integration.test.ts', 'forks'],
      ['**/live.integration.test.ts', 'forks'],
      ['**/media.integration.test.ts', 'forks'],
      ['**/signal.integration.test.ts', 'forks'],
      ['**/webrtc.integration.test.ts', 'forks'],
    ],
  },
});
