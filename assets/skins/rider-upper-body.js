(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const limit = (value, low, high) => Math.min(high, Math.max(low, value));
  function ease(value) {
    const t = limit(value, 0, 1);
    return t * t * (3 - 2 * t);
  }

  function grid(size, spacing, landmarks, fixed) {
    const points = [...new Set([0, size, ...fixed.map(value => limit(value, 0, size))])];
    const add = value => {
      if (value > 6 && value < size - 6 && points.every(point => Math.abs(point - value) > 8)) points.push(value);
    };
    for (let value = spacing; value < size; value += spacing) add(value);
    for (const value of landmarks) add(value);
    return points.sort((a, b) => a - b);
  }

  function photoPixels(base, height) {
    try {
      return base.getContext('2d').getImageData(0, 0, base.width, height).data;
    } catch {
      return null;
    }
  }

  function hasArtwork(data, stride, x, y, width, height) {
    if (!data) return true;
    for (let row = y; row < y + height; row += 2) {
      for (let column = x; column < x + width; column += 2) {
        if (data[4 * (row * stride + column) + 3] > 30) return true;
      }
    }
    return false;
  }

  function pixelPalette(base, data, [cx, cy, rx, ry], preferSkin) {
    if (!data) return null;
    const samples = [];
    const minX = Math.max(0, Math.round(cx - rx - 4));
    const maxX = Math.min(base.width - 1, Math.round(cx + rx + 4));
    const minY = Math.max(0, Math.round(cy - ry - 5));
    const maxY = Math.round(cy + ry + 5);
    for (let y = minY; y <= maxY; y += 2) {
      for (let x = minX; x <= maxX; x += 2) {
        const off = 4 * (y * base.width + x);
        if (!(data[off + 3] > 205)) continue;
        const [r, g, b] = data.subarray(off, off + 3);
        const warm = r >= g * .96 && r > b * 1.035;
        if (preferSkin && (!warm || r + g + b < 365)) continue;
        samples.push({ color: `rgb(${r},${g},${b})`, score: r + 2 * g + b });
      }
    }
    samples.sort((a, b) => a.score - b.score);
    return samples[Math.floor(samples.length * (preferSkin ? .62 : .14))]?.color ?? null;
  }

  function facePatch(base, data, spec, isEye) {
    if (!spec) return null;
    const [cx, cy, rx, ry] = spec;
    const width = Math.ceil(rx * 2 + 4);
    const height = Math.ceil(ry * 2 + 4);
    const left = Math.round(cx - width / 2);
    const top = Math.round(cy - height / 2);
    const texture = document.createElement('canvas');
    texture.width = width;
    texture.height = height;
    const paint = texture.getContext('2d');
    if (isEye) {
      const skin = pixelPalette(base, data, spec, true);
      const lash = pixelPalette(base, data, spec, false);
      if (skin) {
        paint.fillStyle = skin;
        paint.fillRect(0, 0, width, height);
      } else {
        const skinY = Math.max(0, Math.round(cy + ry + 1));
        paint.drawImage(base, left, skinY, width, 3, 0, 0, width, height);
      }
      paint.lineCap = 'round';
      paint.lineWidth = limit(ry * .19, .9, 1.9);
      paint.strokeStyle = lash || 'rgba(72,47,48,.82)';
      paint.beginPath();
      paint.moveTo(width * .15, height * .53);
      paint.quadraticCurveTo(width * .50, height * .66, width * .83, height * .49);
      paint.stroke();
    } else {
      paint.drawImage(base, left, top, width, height, 0, -height * .12, width, height * 1.24);
    }
    paint.globalCompositeOperation = 'destination-in';
    paint.translate(width / 2, height / 2);
    paint.scale(width / 2, height / 2);
    const matte = paint.createRadialGradient(0, 0, .52, 0, 0, 1);
    matte.addColorStop(0, '#000');
    matte.addColorStop(.78, 'rgba(0,0,0,.92)');
    matte.addColorStop(1, 'transparent');
    paint.fillStyle = matte;
    paint.fillRect(-1, -1, 2, 2);
    return { texture, cx, cy, left, top };
  }

  function create(config, base) {
    const profile = config.upper;
    if (!profile) return null;
    const { head, neck, elbow, hand } = profile;
    const gripRegions = [
      [hand[0] - 34, hand[1] - 29, hand[0] + 34, hand[1] + 24],
      ...(profile.grips ?? [])
    ];
    const stop = Math.min(base.height - 4, Math.max(
      ...gripRegions.map(([, , , bottom]) => bottom + 3), elbow[1] + 43,
      ...config.legs.map(leg => (leg.pivot ?? leg.hip)[1])
    ));
    // A fixed zone must end on a mesh edge. A nearby free vertex would let
    // the arm motion interpolate into brake hoods and the opposite grip.
    const columns = grid(base.width, 156, [head[0], neck[0], elbow[0]],
      gripRegions.flatMap(([left, , right]) => [left, right]));
    const rows = grid(stop, 65, [head[1], neck[1], elbow[1]],
      gripRegions.flatMap(([, top, , bottom]) => [top, bottom]));
    const data = photoPixels(base, stop);
    const polygons = [];
    for (let row = 0; row < rows.length - 1; row++) {
      for (let col = 0; col < columns.length - 1; col++) {
        const x = columns[col];
        const y = rows[row];
        const width = columns[col + 1] - x;
        const height = rows[row + 1] - y;
        if (hasArtwork(data, base.width, x, y, width, height)) polygons.push({ row, col, x, y, width, height });
      }
    }
    const eyes = [profile.eye, profile.secondEye].map(eye => facePatch(base, data, eye, true)).filter(Boolean);
    const mouth = facePatch(base, data, profile.mouth, false);
    return { base, profile, stop, columns, rows, polygons, eyes, mouth, gripRegions };
  }

  function ellipse(x, y, cx, cy, width, height) {
    return 1 - ease(Math.hypot((x - cx) / width, (y - cy) / height));
  }

  function deform(rig, x, y, clock, angle, effort, tuck = 0) {
    if (y === rig.stop || x === 0 || x === rig.base.width) return [x, y];
    const { head, neck, shoulder, elbow } = rig.profile;
    const [hx, hy, rx, ry] = head;
    let gripDistance = 32;
    for (const [left, top, right, bottom] of rig.gripRegions) {
      const distanceToGrip = Math.hypot(Math.max(left - x, x - right, 0), Math.max(top - y, y - bottom, 0));
      gripDistance = Math.min(gripDistance, distanceToGrip);
    }
    if (!gripDistance) return [x, y];
    const grip = ease(gripDistance / 32);
    const hip = ease((rig.stop - y) / 53);
    const lobe = ellipse(x, y, hx, hy, rx * 1.55, ry * 1.53);
    const spine = ellipse(x, y, shoulder[0], shoulder[1], 150, 115);
    const arm = ellipse(x, y, elbow[0], elbow[1], 85, 67);
    const hair = ellipse(x, y, hx - rx * .92, hy + ry * .45, rx * 1.8, ry * 1.65)
      * ease((hx - x - 6) / 115);
    const stroke = Math.sin(angle * 2 - .52);
    const breathing = Math.sin(clock * 2.5);
    const nod = .038 * Math.sin(angle + .3) + .022 * effort * Math.sin(clock * 5.2);
    const horizontal = (neck[1] - y) * nod * lobe
      + spine * (stroke * 2.6 + effort * 5.0)
      + arm * (stroke * 3.8 + effort * 2.6)
      + tuck * (lobe * 13 + spine * 9 - arm * 1.8);
    const vertical = (x - neck[0]) * nod * lobe + lobe * (Math.sin(angle + .58) * 3.4 + breathing * 1.3)
      + spine * (stroke * 4.3 + breathing * 2.2)
      + arm * (stroke * 3.2 + effort * 3.2)
      + hair * Math.sin(clock * (4.2 + effort * 2.6) + x * .054) * (4 + effort * 4.1)
      + tuck * (lobe * 14 + spine * 9 + arm * 4.8 + hair * 2.2);
    return [x + horizontal * grip * hip, y + vertical * grip * hip];
  }

  function drawTriangle(context, base, tile, origin, xCorner, yCorner, reverse) {
    const { x, y, width, height } = tile;
    const ax = reverse ? x + width : x;
    const ay = reverse ? y + height : y;
    const side = reverse ? -1 : 1;
    const scaleX = (xCorner[0] - origin[0]) / (width * side);
    const shearY = (xCorner[1] - origin[1]) / (width * side);
    const shearX = (yCorner[0] - origin[0]) / (height * side);
    const scaleY = (yCorner[1] - origin[1]) / (height * side);
    const vertices = [origin, xCorner, yCorner];
    const normals = vertices.map(([px, py], i) => {
      const [nx, ny] = vertices[(i + 1) % vertices.length];
      const length = Math.hypot(nx - px, ny - py);
      return [(ny - py) / length, (px - nx) / length];
    });
    // Overlap by a constant distance perpendicular to each edge. An expansion
    // from the centroid leaves a subpixel gap along the longest diagonal.
    const clip = vertices.map(([px, py], i) => {
      const prev = normals[(i + vertices.length - 1) % vertices.length];
      const next = normals[i];
      const normal = [prev[0] + next[0], prev[1] + next[1]];
      const scale = 1.25 / Math.max(.16, 1 + prev[0] * next[0] + prev[1] * next[1]);
      return [px + normal[0] * scale, py + normal[1] * scale];
    });
    context.save();
    context.beginPath();
    context.moveTo(...clip[0]);
    context.lineTo(...clip[1]);
    context.lineTo(...clip[2]);
    context.closePath();
    context.clip();
    context.transform(scaleX, shearY, shearX, scaleY, origin[0] - scaleX * ax - shearX * ay,
      origin[1] - shearY * ax - scaleY * ay);
    const sx = Math.max(0, x - 3), sy = Math.max(0, y - 3);
    const sw = Math.min(base.width - sx, x + width + 3 - sx);
    const sh = Math.min(base.height - sy, y + height + 3 - sy);
    context.drawImage(base, sx, sy, sw, sh, sx, sy, sw, sh);
    context.restore();
  }

  function mapPoint(rig, nodes, x, y) {
    const col = Math.max(0, rig.columns.findIndex(value => value > x) - 1);
    const row = Math.max(0, rig.rows.findIndex(value => value > y) - 1);
    const h = (x - rig.columns[col]) / (rig.columns[col + 1] - rig.columns[col]);
    const v = (y - rig.rows[row]) / (rig.rows[row + 1] - rig.rows[row]);
    const tl = nodes[row][col], tr = nodes[row][col + 1];
    const bl = nodes[row + 1][col], br = nodes[row + 1][col + 1];
    if (h + v <= 1) return [tl[0] + h * (tr[0] - tl[0]) + v * (bl[0] - tl[0]),
      tl[1] + h * (tr[1] - tl[1]) + v * (bl[1] - tl[1])];
    return [br[0] + (1 - h) * (bl[0] - br[0]) + (1 - v) * (tr[0] - br[0]),
      br[1] + (1 - h) * (bl[1] - br[1]) + (1 - v) * (tr[1] - br[1])];
  }

  function drawFeature(context, rig, nodes, feature, alpha) {
    const origin = mapPoint(rig, nodes, feature.cx, feature.cy);
    const across = mapPoint(rig, nodes, feature.cx + 6, feature.cy);
    const slope = Math.atan2(across[1] - origin[1], across[0] - origin[0]);
    context.save();
    context.globalAlpha *= alpha;
    context.translate(...origin);
    context.rotate(slope);
    context.drawImage(feature.texture, feature.left - feature.cx, feature.top - feature.cy);
    context.restore();
  }

  function draw(context, rig, crankAngle, motion) {
    const clock = motion?.time ?? crankAngle / 1.6;
    const effort = limit(motion?.effort ?? 0, 0, 1);
    const tuck = limit(motion?.tuck ?? 0, 0, 1);
    const { base, stop, rows, columns, polygons } = rig;
    const nodes = rows.map(y => columns.map(x => deform(rig, x, y, clock, crankAngle, effort, tuck)));
    const lower = base.height - stop;
    context.drawImage(base, 0, stop, base.width, lower, 0, stop, base.width, lower);
    for (const tile of polygons) {
      const { row, col } = tile;
      const a = nodes[row][col], b = nodes[row][col + 1];
      const c = nodes[row + 1][col], d = nodes[row + 1][col + 1];
      drawTriangle(context, base, tile, a, b, c, false);
      drawTriangle(context, base, tile, d, c, b, true);
    }

    const period = 4.0 + (rig.profile.head[0] % 11) * .12;
    const blinkTime = (clock + period - .81) % period;
    if (blinkTime >= 0 && blinkTime < .18) {
      const closed = Math.pow(Math.sin(blinkTime / .18 * Math.PI), .6);
      for (const eye of rig.eyes) drawFeature(context, rig, nodes, eye, closed);
    }
    if (rig.mouth && effort > .13) {
      const effortBreath = effort * (.26 + Math.sin(clock * TAU * .88) * .075);
      drawFeature(context, rig, nodes, rig.mouth, effortBreath);
    }
  }

  globalThis.RiderUpperBody = { create, draw };
})();
