import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);

// Exercise the verification CLI as a separate process: a wrong runtime must be
// rejected BEFORE any case POST, and incomplete seed data must never pass.
for (const remote of [true, false]) {
  test(`fixture verifier refuses ${remote ? 'remote inference' : 'incomplete canonical orders'}`, async () => {
    let posts = 0;
    const server = createServer((req, res) => {
      if (req.method === 'POST') posts++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/health'
        ? { ok: true, aiMode: remote ? 'vllm' : 'fixture', remoteModel: remote, paymentGateway: 'simulated' }
        : { store: { data: 'synthetic', payments: 'simulated' }, orders: Array.from({ length: 4 }, () => ({ orderId: '48291' })) }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      await assert.rejects(run(process.execPath, ['scripts/verify-demo.mjs', '--fixture', `http://127.0.0.1:${address.port}`]),
        (error: unknown) => {
          const e = error as Error & { code: number; stdout: string };
          assert.equal(e.code, 1);
          assert.match(e.stdout, remote ? /FAIL.*fixture runtime/ : /FAIL.*all four canonical orders/);
          return true;
        });
      assert.equal(posts, 0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}
