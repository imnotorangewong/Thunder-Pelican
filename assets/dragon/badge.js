// Position is kept as a side and a vertical fraction, so it survives screen rotation.
function dockDragonBadge(dock, button, storageKey, open) {
  let side = "right", height = .43;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved && ["left","right"].includes(saved.side) && Number.isFinite(saved.height)) {
      side = saved.side;
      height = Math.max(0, Math.min(1, saved.height));
    }
  } catch { /* Storage is optional. */ }
  function bounds() {
    const x = Math.max(0, dock.clientWidth - button.offsetWidth);
    const bottom = Math.max(0, dock.clientHeight - button.offsetHeight);
    const telemetry = document.getElementById("telemetry").getBoundingClientRect();
    const top = Math.min(bottom, Math.max(0, telemetry.bottom - dock.getBoundingClientRect().top + 8));
    return {x, bottom, top:side === "left" ? top : 0};
  }
  function place() {
    const {x, top, bottom} = bounds();
    button.style.left = (side === "right" ? x : 0) + "px";
    button.style.top = Math.max(top, bottom * height) + "px";
  }
  function save() {
    place();
    try { localStorage.setItem(storageKey, JSON.stringify({side, height})); } catch {}
  }
  let drag = null, suppressClick = false;
  button.addEventListener("pointerdown", e => {
    if (!e.isPrimary || e.button !== 0) return;
    suppressClick = false;
    drag = {id:e.pointerId, x:e.clientX, y:e.clientY, left:button.offsetLeft, top:button.offsetTop};
    button.setPointerCapture(e.pointerId);
  });
  button.addEventListener("pointermove", e => {
    e.stopPropagation();
    if (!drag || drag.id !== e.pointerId) return;
    const dx=e.clientX-drag.x, dy=e.clientY-drag.y;
    if (!suppressClick && Math.hypot(dx,dy)<6) return;
    suppressClick = true;
    const {x,bottom}=bounds();
    button.style.left=Math.max(0,Math.min(x,drag.left+dx))+"px";
    button.style.top=Math.max(0,Math.min(bottom,drag.top+dy))+"px";
  });
  button.addEventListener("pointerup", e => {
    if (!drag || drag.id !== e.pointerId) return;
    drag=null;
    if (!suppressClick) return;
    const {x,bottom}=bounds();
    side=button.offsetLeft < x/2 ? "left" : "right";
    height=button.offsetTop/Math.max(1,bottom);
    save();
  });
  button.addEventListener("lostpointercapture", () => {
    if (drag) { drag=null; suppressClick=true; place(); }
  });
  button.addEventListener("keydown", e => {
    if (["Enter"," "].includes(e.key)) { suppressClick=false; e.stopPropagation(); }
    if (!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key==="ArrowLeft") side="left";
    if (e.key==="ArrowRight") side="right";
    if (e.key==="ArrowUp") height=Math.max(0,height-.1);
    if (e.key==="ArrowDown") height=Math.min(1,height+.1);
    save();
  });
  button.addEventListener("click", e => { e.stopPropagation(); if (!suppressClick || e.detail===0) open(); });
  window.addEventListener("resize", place);
  new ResizeObserver(place).observe(document.getElementById("telemetry"));
  place();
}
