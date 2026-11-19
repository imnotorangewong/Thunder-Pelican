function createDragonEvent(game) {
  const $ = id => document.getElementById(id);
  const dialog = $("dragon-case"), stage = dialog.querySelector(".case-stage");
  const badge = $("dragon-badge"), account = $("dragon-account"), authorize = $("dragon-authorize");
  const star = $("dragon-star"), equip = $("dragon-equip"), report = $("dragon-report");
  const terms = $("dragon-terms").textContent;
  const initialMessage = report.textContent;
  const accountLabel = account.textContent;
  let rotation, wasPaused, attempt, message = initialMessage;

  function showForm(form) {
    stage.dataset.form = form;
    for (const button of stage.querySelectorAll("button"))
      button.setAttribute("aria-pressed", String(button.dataset.dragonForm === form));
    for (const image of stage.querySelectorAll("img"))
      image.setAttribute("aria-hidden", String(!image.classList.contains("case-" + form)));
  }
  function display() {
    const owned = game.owns();
    $("dragon-condition").textContent = owned ? "已收藏" : "获取条件";
    $("dragon-terms").textContent = owned ? "选择喜欢的形态，即可装备昼夜双龙进入霓虹港。" : terms;
    star.hidden = owned;
    account.hidden = owned;
    account.textContent = attempt?.kind === "oauth" ? "取消本次授权" : accountLabel;
    authorize.hidden = owned || !attempt?.link;
    if (authorize.hidden) authorize.removeAttribute("href");
    else authorize.href = attempt.link;
    equip.hidden = !owned;
    report.textContent = owned && message === initialMessage ? "皮肤库可选常态。雷霆二档期间会变为另一形态，结束后恢复。" : message;
  }
  function say(text) { message=text; display(); }
  function clearAttempt() {
    if (attempt) {
      attempt.controller.abort();
      attempt.channel?.close();
      clearTimeout(attempt.expiry);
      attempt=null;
    }
  }
  function reset() { clearAttempt(); message=initialMessage; }
  function open() {
    if (dialog.open) return;
    wasPaused=game.pause();
    showForm(game.form());
    display();
    dialog.showModal();
    badge.setAttribute("aria-expanded","true");
    if (!game.reduceMotion) rotation=setInterval(() => {
      if (!document.hidden) showForm(stage.dataset.form === "dark" ? "light" : "dark");
    },3300);
  }
  function grant(current, text) {
    if (attempt !== current || game.owner() !== current.owner) return;
    game.grant();
    clearAttempt();
    say(text);
    if (dialog.open) equip.focus({preventScroll:true});
    else game.notify(text);
  }
  function begin(kind) {
    const current={kind, controller:new AbortController(), owner:game.owner()};
    attempt=current;
    return current;
  }
  function failed(current, err) {
    if (attempt !== current) return;
    clearAttempt();
    say(err instanceof TypeError || err.name === "AbortError"
      ? "连接失败或超时，请检查网络后重试。" : err.message);
  }
  stage.addEventListener("click", e => {
    const button=e.target.closest("[data-dragon-form]");
    if (button) { clearInterval(rotation); showForm(button.dataset.dragonForm); }
  });
  const keepModalKeys = e => { if (dialog.open) e.stopPropagation(); };
  dialog.addEventListener("keydown", keepModalKeys);
  dialog.addEventListener("keyup", keepModalKeys);
  function resumeRide() {
    if (dialog.open || wasPaused === undefined) return;
    clearInterval(rotation);
    game.resume(wasPaused);
    wasPaused = undefined;
    badge.setAttribute("aria-expanded","false");
  }
  function close() {
    dialog.close();
    // Accept a gear key on the very next input, before the queued close event.
    resumeRide();
  }
  dialog.addEventListener("close", resumeRide);
  $("dragon-dismiss").addEventListener("click", close);
  $("dragon-locker").addEventListener("click", open);
  equip.addEventListener("click", () => {
    if (game.owns()) { game.equip(stage.dataset.form); close(); }
  });
  dockDragonBadge($("dragon-dock"),badge,game.storageKey,open);

  async function stars(current) {
    const timer=setTimeout(()=>current.controller.abort(),9000);
    try {
      const r=await fetch("https://api.github.com/repos/imnotorangewong/Thunder-Pelican?_="+Date.now(),
        {cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",signal:current.controller.signal});
      if ([403,429].includes(r.status)) throw new Error("GitHub 暂时限制了查询，请稍后重试。");
      if (!r.ok) throw new Error("未能读取仓库星数，请稍后重试。");
      const {stargazers_count:n}=await r.json();
      if (!Number.isSafeInteger(n)||n<0) throw new Error("仓库星数暂不可用。");
      return n;
    } finally { clearTimeout(timer); }
  }
  star.addEventListener("click", async () => {
    if (attempt || game.owns()) return;
    const current=begin("stars"), checkAt=performance.now()+60_000;
    say("正在读取仓库星数，点击后 1 分钟复查…");
    try {
      const before=await stars(current);
      if (attempt!==current) return;
      say("起始星数为 "+before+"。可以先去骑行，1 分钟后自动复查。");
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,checkAt-performance.now())));
      if (attempt!==current) return;
      const after=await stars(current);
      if (attempt!==current) return;
      const result="仓库星数 "+before+" → "+after+"。";
      if (after>before) grant(current,result+"已解锁昼夜双龙。");
      else failed(current,new Error(result+"本次未检测到净增长，可以重试或验证本人账号。"));
    } catch(err) { failed(current,err); }
  });

  // Use the operator-configured API only; URL parameters cannot override the OAuth service.
  const configured=document.querySelector('meta[name="tp-leaderboard-api"]').content.trim();
  const base=(configured || "/api").replace(/\/+$/,"");
  async function oauthRequest(path, body, current) {
    const timer=setTimeout(()=>current.controller.abort(),20000);
    try {
      const res=await fetch(base+"/dragon/"+path,{
        method:"POST",cache:"no-store",credentials:"omit",headers:{"Content-Type":"application/json"},
        body:JSON.stringify(body),signal:current.controller.signal
      });
      if (res.status===429) throw new Error("验证过于频繁，请稍后重试。");
      if (res.status===503 || res.status===404 && path==="start" || !res.headers.get("content-type")?.includes("application/json"))
        throw new Error("本站暂未连接 GitHub 账号验证服务，可使用上方的一分钟点星领取。");
      if (!res.ok) throw new Error("本次授权已过期或未完成，请重新验证。");
      return await res.json();
    } finally { clearTimeout(timer); }
  }
  account.addEventListener("click", async () => {
    if (game.owns()) return;
    if (attempt?.kind === "oauth") {
      failed(attempt,new Error("已取消 GitHub 授权，可重新验证。"));
      return;
    }
    if (attempt) { say("当前验证正在进行，可以继续骑行并稍后查看结果。"); return; }
    if (!/^https?:$/.test(location.protocol) || !window.BroadcastChannel) {
      say("请在支持账号验证的游戏网站打开此功能。当前可使用上方的一分钟点星领取。"); return;
    }
    const current=begin("oauth");
    say("正在连接 GitHub 账号验证服务…");
    try {
      const auth=await oauthRequest("start",{},current);
      if (attempt!==current) return;
      const link=new URL(auth.url);
      if (link.origin!=="https://github.com" || link.pathname!=="/login/oauth/authorize" ||
          new URL(link.searchParams.get("redirect_uri")).origin!==location.origin)
        throw new Error("账号验证回调与本站地址不匹配。请使用一分钟点星领取。");
      current.channel=new BroadcastChannel("tp-dragon-"+auth.state);
      current.link=link.href;
      current.expiry=setTimeout(()=>failed(current,new Error("授权已过期，请重试。")),600000);
      current.channel.onmessage=async ({data})=>{
        if (attempt!==current || current.redeeming || data?.state!==auth.state) return;
        current.redeeming=true;
        current.channel.postMessage({received:true});
        if (!data.code) { failed(current,new Error("已取消 GitHub 授权，可重新验证。")); return; }
        try {
          const answer=await oauthRequest("verify",{ticket:auth.ticket,state:auth.state,code:data.code},current);
          if (answer.starred===true) grant(current,"已确认当前 GitHub 账号的点星记录，昼夜双龙已解锁。");
          else failed(current,new Error("当前 GitHub 账号尚未给仓库点星。"));
        } catch(err) { failed(current,err); }
      };
      say("请点击授权链接，完成后回到游戏查看结果。");
    } catch(err) { failed(current,err); }
  });
  return {open, reset};
}
