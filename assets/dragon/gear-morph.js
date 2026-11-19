// Composites two fully posed riders. Both passes use the game's current crank angle.
function createDragonGearMorph() {
  const width = 850, height = 567;
  const layers = [];
  let position = 0;
  let target = 0;

  function follow(form, gearOn, dt, reducedMotion) {
    const next = Number((form === "light") !== gearOn);
    target = next;
    const step = dt / (reducedMotion ? .32 : .96);
    position = next ? Math.min(1, position + step) : Math.max(0, position - step);
  }

  function layer(index) {
    if (!layers[index]) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      layers[index] = canvas.getContext("2d");
    }
    return layers[index];
  }

  // A feathered diagonal reveals the incoming silhouette. Complementary masks
  // preserve opacity where both bicycles overlap, including the wheel spokes.
  function blend(context, destination, drawForm, reducedMotion) {
    const mix = position * position * (3 - 2 * position);
    for (const [index, form] of ["dark", "light"].entries()) {
      const c = layer(index);
      c.clearRect(0, 0, width, height);
      drawForm(c, form, [0, 0, width, height]);
      c.save();
      c.globalCompositeOperation = index ? "destination-in" : "destination-out";
      if (reducedMotion) {
        c.fillStyle = 'rgba(255,255,255,' + mix + ')';
      } else {
        const feather = 175;
        const edge = -feather + (width + .30 * height + 2 * feather) * mix;
        const mask = c.createLinearGradient(edge, 0,
          edge + feather / 1.09, .30 * feather / 1.09);
        mask.addColorStop(0, "#fff");
        mask.addColorStop(1, "rgba(255,255,255,0)");
        c.fillStyle = mask;
      }
      c.fillRect(0, 0, width, height);
      c.restore();
    }
    const combined = layer(0);
    combined.save();
    combined.globalCompositeOperation = "lighter";
    combined.drawImage(layer(1).canvas, 0, 0);
    combined.restore();
    context.drawImage(combined.canvas, ...destination);
  }

  // The rear half of each orbit passes behind the rider, the near half in front.
  function drawOrbit(c, front, reducedMotion) {
    if (reducedMotion || position === 0 || position === 1) return;
    const envelope = Math.sin(Math.PI * position) ** 1.5;
    const travel = target ? position : 1 - position;
    const phase = (target ? 1 : -1) * travel * Math.PI * 1.32;
    const ink = target ? "#b7a7ff" : "#bd863c";
    const core = target ? "#f1f4ff" : "#ffdf9b";
    c.save();
    c.translate(-5, -259);
    c.rotate(-.25);
    c.globalCompositeOperation = "screen";
    c.lineCap = "round";
    if (!front) {
      // A silver corona opens toward daylight. The night form leaves a gilt crescent.
      c.save();
      c.translate(96, -135);
      const radius = 79 + 26 * envelope;
      const halo = c.createRadialGradient(0, 0, 8, 0, 0, radius * 1.5);
      halo.addColorStop(0, "rgba(0,0,0,0)");
      halo.addColorStop(.61, target ? "#8876da" : "#98652f");
      halo.addColorStop(1, "rgba(0,0,0,0)");
      c.globalAlpha = .42 * envelope;
      c.fillStyle = halo;
      c.fillRect(-radius * 1.5, -radius * 1.5, radius * 3, radius * 3);
      c.globalAlpha = .85 * envelope;
      c.strokeStyle = core;
      c.lineWidth = target ? 2 : 3.5;
      c.beginPath();
      c.arc(0, 0, radius, phase * .3 - 2.9, phase * .3 + (target ? 2.9 : 1.35));
      c.stroke();
      for (let ray = 0; ray < 12; ray++) {
        const angle = phase * .3 + ray * Math.PI / 6;
        if (!target && Math.sin(angle) > .36) continue;
        const length = ray % 3 ? 6 : 18;
        c.beginPath();
        c.moveTo(Math.cos(angle) * (radius + 4), Math.sin(angle) * (radius + 4));
        c.lineTo(Math.cos(angle) * (radius + 4 + length), Math.sin(angle) * (radius + 4 + length));
        c.lineWidth = ray % 3 ? 1.5 : 2.5;
        c.stroke();
      }
      c.restore();
    }
    const point = (angle, band) => [
      Math.cos(angle) * (333 + 32 * envelope - band * 22),
      Math.sin(angle) * (81 + band * 16) - band * 34
    ];
    for (let band = 0; band < 2; band++) {
      const start = front ? 0 : Math.PI;
      c.beginPath();
      c.ellipse(0, -band * 34, 333 + 32 * envelope - band * 22, 81 + band * 16, 0, start, start + Math.PI);
      c.globalAlpha = envelope * (front ? .52 : .34);
      c.lineWidth = band ? 1.6 : 2.6;
      c.strokeStyle = band ? core : ink;
      c.stroke();
      for (let i = 0; i < 9; i++) {
        const a = i * Math.PI * 2 / 9 + phase + band * .35;
        if ((Math.sin(a) > 0) !== front) continue;
        const [x, y] = point(a, band);
        c.save();
        c.translate(x, y);
        c.rotate(.25);
        const r = (i % 3 ? 3.5 : 7) * (.6 + .4 * envelope);
        c.fillStyle = i % 3 ? ink : core;
        c.globalAlpha = envelope * (.55 + .3 * Math.abs(Math.cos(a)));
        c.beginPath();
        if (!target && i % 3 === 0) {
          c.arc(0, 0, r, Math.PI * .5, Math.PI * 1.5);
          c.quadraticCurveTo(-r * .56, 0, 0, r);
        } else {
          c.moveTo(0, -r * 1.5);
          c.quadraticCurveTo(r * .16, -r * .16, r, 0);
          c.quadraticCurveTo(r * .16, r * .16, 0, r * 1.5);
          c.quadraticCurveTo(-r * .16, r * .16, -r, 0);
          c.quadraticCurveTo(-r * .16, -r * .16, 0, -r * 1.5);
        }
        c.closePath(); c.fill(); c.restore();
      }
    }
    c.restore();
  }

  return {
    reset(form) { position = target = Number(form === "light"); },
    get mix() { return position; },
    follow, blend, drawOrbit
  };
}
