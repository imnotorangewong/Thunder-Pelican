'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {mkdtemp,rm}=require('node:fs/promises');
const os=require('node:os'),path=require('node:path');
const {createApp}=require('../app');

test('账号点星领取绑定同一授权，区分已点星、未点星和接口错误',async t=>{
  let expectedChallenge,starStatus=204;
  const dir=await mkdtemp(path.join(os.tmpdir(),'tp-dragon-'));
  const callback='https://game.example/assets/dragon/callback.html';
  const app=createApp({
    dataFile:path.join(dir,'board.json'),quiet:true,submitPerHour:500,
    dragonClientId:'test-client',dragonClientSecret:'test-secret',dragonCallback:callback,
    async githubFetch(url,options) {
      if (url==='https://github.com/login/oauth/access_token') {
        assert.equal(options.body.get('redirect_uri'),callback);
        assert.equal(createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'),expectedChallenge);
        return Response.json({access_token:'test-only'});
      }
      assert.equal(url,'https://api.github.com/user/starred/imnotorangewong/Thunder-Pelican');
      assert.equal(options.headers.Authorization,'Bearer test-only');
      return new Response(null,{status:starStatus});
    }
  });
  await app.ready;
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+app.server.address().port+'/api/dragon/';
  function post(action,body,origin='https://game.example'){
    return fetch(base+action,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  }
  assert.equal((await post('start',{},'https://other.example')).status,403);
  for(const status of [204,404,403]){
    starStatus=status;
    const {url,state,ticket}=await (await post('start',{})).json();
    expectedChallenge=new URL(url).searchParams.get('code_challenge');
    const payload={state,ticket,code:'fixture-code'};
    if(status===204)assert.equal((await post('verify',{...payload,state:'incorrect'})).status,400);
    const result=await post('verify',payload);
    if(status===403)assert.equal(result.status,502);
    else assert.deepEqual(await result.json(),{starred:status===204});
    if(status===204)assert.equal((await post('verify',payload)).status,400);
  }
});
