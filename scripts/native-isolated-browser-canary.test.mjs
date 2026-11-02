import assert from 'node:assert/strict';
import { it as test } from 'vitest';
import { createIsolationFixtures } from './native-isolated-browser-canary.mjs';

function requestFixture(fixtures, path) {
 const response = {
  status: 0, body: '', headers: {},
  writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
  end(body = '') { this.body = body; },
 };
 assert.equal(fixtures.handle({ url: path, headers: {} }, response), true);
 return response;
}

test('fixture roles reject injected HTML and script in both rendered pages', () => {
 const fixtures = createIsolationFixtures();
 for (const path of ['/isolation-page', '/isolation-alive']) {
  for (const attack of ['</title><script>alert(1)</script>', '</script><script>alert(1)</script>', '";alert(1);//', 'a'.repeat(256), '']) {
   const response = requestFixture(fixtures, `${path}?role=${encodeURIComponent(attack)}`);
   assert.equal(response.status, 400);
   assert.equal(response.body, 'Invalid fixture role.');
  }
  assert.equal(requestFixture(fixtures, `${path}?role=first&role=second`).status, 400);
  for (const role of ['user', 'first', 'second', 'first-next', 'first-key', 'orphan', 'recovered']) {
   assert.equal(requestFixture(fixtures, `${path}?role=${role}`).status, 200);
  }
 }
});
