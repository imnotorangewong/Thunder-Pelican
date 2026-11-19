'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const eventDir = path.join(__dirname, '../../assets/dragon');
const eventSource = readFileSync(path.join(eventDir, 'event.js'), 'utf8');
const callback = readFileSync(path.join(eventDir, 'callback.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const origin = 'https://game.example';

function setup() {
  const requests = [];
  const channels = new Set();
  let owned = false;
  let verdict = { starred: false };
  let owner = 'rider-1';

  class Channel {
    constructor(name) {
      this.name = name;
      channels.add(this);
    }
    postMessage(data) {
      for (const peer of channels) {
        if (peer !== this && peer.name === this.name) {
          queueMicrotask(() => { if (channels.has(peer)) peer.onmessage?.({ data }); });
        }
      }
    }
    close() { channels.delete(this); }
  }

  const elements = new Map();
  function get(id) {
    if (!elements.has(id)) {
      const listeners = new Map();
      elements.set(id, {
        textContent: id === 'dragon-account' ? '验证本人账号' : '',
        dataset: {},
        focus() {},
        setAttribute() {},
        removeAttribute(name) { delete this[name]; },
        querySelector: get,
        querySelectorAll() { return []; },
        addEventListener(name, listener) { listeners.set(name, listener); },
        click() {
          assert.equal(this.hidden, false, id + ' is unavailable');
          return listeners.get('click')();
        },
        showModal() { this.open = true; }
      });
    }
    return elements.get(id);
  }

  const env = {
    AbortController,
    BroadcastChannel: Channel,
    URL,
    URLSearchParams,
    location: { origin, protocol: 'https:' },
    window: { BroadcastChannel: Channel },
    document: { getElementById: get, querySelector: () => ({ content: origin + '/api' }) },
    setTimeout: () => 0,
    clearTimeout() {},
    dockDragonBadge() {},
    async fetch(url, options) {
      const action = new URL(url).pathname.split('/').pop();
      requests.push({ action, data: JSON.parse(options.body) });
      if (action === 'verify') return Response.json(verdict);
      const state = String(requests.length).padStart(48, '0');
      const redirect = encodeURIComponent(origin + '/assets/dragon/callback.html');
      return Response.json({ state, ticket: 'ticket-' + state,
        url: `https://github.com/login/oauth/authorize?state=${state}&redirect_uri=${redirect}` });
    }
  };
  const game = {
    owns: () => owned,
    owner: () => owner,
    grant() { owned = true; },
    form: () => 'dark',
    pause: () => false,
    reduceMotion: true
  };
  vm.runInNewContext(eventSource + '\ncreateDragonEvent(game).open();', { ...env, game });

  const account = get('dragon-account');
  const authorize = get('dragon-authorize');
  async function start() {
    await account.click();
    assert.equal(authorize.hidden, false);
    return new URL(authorize.href).searchParams.get('state');
  }
  async function complete(state, result) {
    const query = new URLSearchParams({ state, ...result });
    vm.runInNewContext(callback, {
      ...env,
      location: { search: '?' + query, pathname: '/assets/dragon/callback.html' },
      history: { replaceState() {} },
      document: { getElementById: () => ({ textContent: '' }) },
      setInterval: () => 0,
      clearInterval() {}
    });
    await new Promise(resolve => setImmediate(resolve));
  }
  return {
    account, authorize, requests, start, complete,
    report: get('dragon-report'),
    equip: get('dragon-equip'),
    setVerdict(next) { verdict = next; },
    switchRider() { owner = 'rider-2'; },
    checks() { return requests.filter(request => request.action === 'verify'); }
  };
}

test('GitHub cancellation leaves the skin locked and a new authorization rejects an unstarred account', async () => {
  const qa = setup();
  const canceled = await qa.start();
  await qa.complete(canceled, { error: 'access_denied' });
  assert.match(qa.report.textContent, /已取消.*可重新验证/);
  assert.equal(qa.equip.hidden, true);
  assert.equal(qa.checks().length, 0);
  const retried = await qa.start();
  assert.notEqual(retried, canceled);
  await qa.complete(canceled, { code: 'stale-code' });
  assert.equal(qa.checks().length, 0);
  await qa.complete(retried, { code: 'unstarred-code' });
  assert.match(qa.report.textContent, /尚未.*点星/);
  assert.equal(qa.equip.hidden, true);
  assert.equal(qa.account.hidden, false);
  assert.equal(qa.checks().length, 1);
});

test('closing the GitHub tab leaves a way to cancel the pending attempt and retry', async () => {
  const qa = setup();
  const abandoned = await qa.start();
  assert.equal(qa.account.hidden, false, 'A closed authorization tab cannot report a cancellation');
  assert.match(qa.account.textContent, /取消/);
  await qa.account.click();
  assert.equal(qa.equip.hidden, true);
  assert.equal(qa.authorize.hidden, true);
  assert.match(qa.report.textContent, /已取消/);
  const retried = await qa.start();
  assert.notEqual(retried, abandoned);
  await qa.complete(abandoned, { code: 'old-tab-code' });
  assert.equal(qa.checks().length, 0);
  qa.setVerdict({ starred: true });
  await qa.complete(retried, { code: 'starred-code' });
  assert.equal(qa.equip.hidden, false);
});

test('only an explicit positive result can grant the skin, and only to the rider who started authorization', async () => {
  const qa = setup();
  qa.setVerdict({ starred: 'true' });
  await qa.complete(await qa.start(), { code: 'malformed-result' });
  assert.equal(qa.equip.hidden, true);
  qa.setVerdict({ starred: true });
  const state = await qa.start();
  qa.switchRider();
  await qa.complete(state, { code: 'wrong-rider' });
  assert.equal(qa.equip.hidden, true);
});
