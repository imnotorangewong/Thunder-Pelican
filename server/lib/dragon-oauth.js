'use strict';

const {randomBytes,createHash} = require('node:crypto');
const {sendJson,readJson} = require('./http');
const MAX_AGE = 10 * 60 * 1000;
const REPO = 'imnotorangewong/Thunder-Pelican';

function dragonOAuth(config, request = fetch) {
  const pending = new Map();
  const {dragonClientId, dragonClientSecret, dragonCallback} = config;
  return async function handle(req, res, action) {
    if (req.method !== 'POST') return sendJson(res,405,{ok:false},{Allow:'POST'});
    if (!dragonClientId || !dragonClientSecret || !dragonCallback) return sendJson(res,503,{ok:false});
    const now = Date.now();
    for (const [key, record] of pending) if (record.until <= now) pending.delete(key);
    const callback = new URL(dragonCallback);
    if (req.headers.origin && req.headers.origin !== callback.origin) return sendJson(res,403,{ok:false});
    const input = await readJson(req,4096);
    if (!input.ok || !input.value) return sendJson(res,400,{ok:false});
    if (action === 'start') {
      if (pending.size >= 2048) return sendJson(res,429,{ok:false});
      const state = randomBytes(24).toString('hex');
      const ticket = randomBytes(32).toString('hex');
      const verifier = randomBytes(48).toString('base64url');
      pending.set(ticket,{state,verifier,until:now+MAX_AGE});
      const url = new URL('https://github.com/login/oauth/authorize');
      url.search = new URLSearchParams({
        client_id:dragonClientId, redirect_uri:callback.href, state,
        code_challenge:createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method:'S256'
      }).toString();
      return sendJson(res,200,{state,ticket,url:url.href});
    }
    if (action !== 'verify') return sendJson(res,404,{ok:false});
    const {ticket,state,code} = input.value;
    const record = pending.get(ticket);
    if (!record || record.state !== state || typeof code !== 'string' || !code || code.length>512)
      return sendJson(res,400,{ok:false});
    // Consume before awaiting the exchange: a ticket belongs to exactly one attempt.
    pending.delete(ticket);
    const tokenReply = await request('https://github.com/login/oauth/access_token',{
      method:'POST', headers:{Accept:'application/json'}, signal:AbortSignal.timeout(8000),
      body:new URLSearchParams({client_id:dragonClientId,client_secret:dragonClientSecret,
        code,redirect_uri:callback.href,code_verifier:record.verifier})
    });
    if (!tokenReply.ok) return sendJson(res,502,{ok:false});
    const token = (await tokenReply.json()).access_token;
    if (!token) return sendJson(res,401,{ok:false});
    const check = await request('https://api.github.com/user/starred/'+REPO,{
      headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'Thunder-Pelican'},
      signal:AbortSignal.timeout(8000),redirect:'error'
    });
    if (![204,404].includes(check.status)) return sendJson(res,502,{ok:false});
    sendJson(res,200,{starred:check.status===204});
  };
}

module.exports = {dragonOAuth};
