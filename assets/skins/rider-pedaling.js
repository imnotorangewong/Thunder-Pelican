(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const distance = (start, end) => Math.hypot(end[0] - start[0], end[1] - start[1]);
  const angleOf = (start, end) => Math.atan2(end[1] - start[1], end[0] - start[0]);
  const phaseOf = (config) => config.phase ?? angleOf(config.crank, config.legs[1].sole);
  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

  function axis(start, end) {
    const length = distance(start, end);
    return [(end[0] - start[0]) / length, (end[1] - start[1]) / length];
  }

  function offset(point, direction, length) {
    return [point[0] + direction[0] * length, point[1] + direction[1] * length];
  }

  function pedalPosition(config, leg, angle) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const pedal = [
      config.crank[0] + config.radius * cosine,
      config.crank[1] + config.radius * sine
    ];
    // The heel eases down on the power stroke and rises gently on recovery.
    const pitch = (config.pitch ?? 0.04) + 0.108 * Math.sin(angle - .34) + .027 * Math.sin(angle * 2 - .4);
    const rotation = pitch - (leg.pitch ?? 0);
    const scale = leg.shoeScale ?? 1;
    const x = (leg.sole[0] - leg.ankle[0]) * scale;
    const y = (leg.sole[1] - leg.ankle[1]) * scale;
    const ankle = [
      pedal[0] - x * Math.cos(rotation) + y * Math.sin(rotation),
      pedal[1] - x * Math.sin(rotation) - y * Math.cos(rotation)
    ];
    return { pedal, pitch, ankle };
  }

  function limbLengths(config, leg) {
    const hip = leg.pivot ?? leg.hip;
    let [thigh, shin] = leg.lengths ?? [distance(leg.hip, leg.knee), distance(leg.knee, leg.ankle)];
    let farthest = 0;
    let nearest = Infinity;
    for (let step = 0; step < 96; step++) {
      const { ankle } = pedalPosition(config, leg, TAU * step / 96);
      const reach = distance(hip, ankle);
      farthest = Math.max(farthest, reach);
      nearest = Math.min(nearest, reach);
    }

    // Both contact points stay reachable with a slight bend at full extension.
    const total = Math.max(thigh + shin, farthest / 0.985);
    const difference = clamp((thigh - shin) * total / (thigh + shin), -nearest * 0.94, nearest * 0.94);
    return [(total + difference) / 2, (total - difference) / 2];
  }

  function solveLeg(config, leg, lengths, angle) {
    const hip = leg.pivot ?? leg.hip;
    const { pedal, pitch, ankle } = pedalPosition(config, leg, angle);
    const [thigh, shin] = lengths;
    const reach = Math.max(distance(hip, ankle), 1e-5);
    const x = (ankle[0] - hip[0]) / reach;
    const y = (ankle[1] - hip[1]) / reach;
    const along = (thigh * thigh - shin * shin + reach * reach) / (2 * reach);
    const bend = Math.sqrt(Math.max(thigh * thigh - along * along, 0));
    const knee = [hip[0] + along * x + bend * y, hip[1] + along * y - bend * x];
    return { hip, knee, ankle, pedal, pitch };
  }

  function solvePose(config, crankAngle, lengths = config.legs.map((leg) => limbLengths(config, leg))) {
    const angle = crankAngle + phaseOf(config);
    return config.legs.map((leg, index) => solveLeg(config, leg, lengths[index], angle + (1 - index) * Math.PI));
  }

  function canvas(width, height) {
    const layer = document.createElement('canvas');
    layer.width = width;
    layer.height = height;
    return layer;
  }

  function trace(context, points, closed) {
    context.beginPath();
    context.moveTo(...points[0]);
    for (let index = 1; index < points.length; index++) context.lineTo(...points[index]);
    if (closed) context.closePath();
  }

  function cutout(source, polygon, exclusions = [], tint = null) {
    const xs = polygon.map(([x]) => x);
    const ys = polygon.map(([, y]) => y);
    const x = Math.floor(Math.min(...xs)) - 1;
    const y = Math.floor(Math.min(...ys)) - 1;
    const width = Math.ceil(Math.max(...xs)) + 1 - x;
    const height = Math.ceil(Math.max(...ys)) + 1 - y;
    const layer = canvas(width, height);
    const context = layer.getContext('2d');
    context.translate(-x, -y);
    context.save();
    trace(context, polygon, true);
    context.clip();
    context.drawImage(source, 0, 0);
    context.restore();
    context.globalCompositeOperation = 'destination-out';
    for (const excluded of exclusions) {
      trace(context, excluded, true);
      context.fill();
    }
    if (tint) {
      context.globalCompositeOperation = 'source-atop';
      context.fillStyle = tint;
      context.fillRect(x, y, width, height);
    }
    return { layer, x, y };
  }

  function shinAtKnee(polygon, from, to, kneeContour) {
    const [ux, uy] = axis(from, to);
    const longitudinal = ([x, y]) => (x - from[0]) * ux + (y - from[1]) * uy;
    const sideways = ([x, y]) => (y - from[1]) * ux - (x - from[0]) * uy;
    const vertices = polygon.map(point => ({
      point, length: longitudinal(point), width: sideways(point)
    }));
    function spanAt(depth) {
      const crossings = [];
      for (const [index, end] of vertices.entries()) {
        const start = vertices[(index + vertices.length - 1) % vertices.length];
        if ((start.length >= depth) === (end.length >= depth)) continue;
        const t = (depth - start.length) / (end.length - start.length);
        crossings.push(start.width + (end.width - start.width) * t);
      }
      return crossings.length > 1 ? [Math.min(...crossings), Math.max(...crossings)] : [0, 0];
    }
    // The pointed end of the source calf was drawn into the bent knee.
    // Start at the first usable cross-section so it can follow a new angle.
    const limit = Math.min(28, distance(from, to) * .23);
    const [left, right] = spanAt(limit);
    let startAt = 0;
    let [startLeft, startRight] = spanAt(startAt);
    while (startAt < limit && startRight - startLeft < Math.max(10, (right - left) * .74)) {
      startAt = Math.min(limit, startAt + 2);
      [startLeft, startRight] = spanAt(startAt);
    }
    const result = [];
    for (const [index, end] of vertices.entries()) {
      const start = vertices[(index + vertices.length - 1) % vertices.length];
      if ((start.length >= startAt) !== (end.length >= startAt)) {
        const t = (startAt - start.length) / (end.length - start.length);
        result.push(offset(start.point, [end.point[0] - start.point[0], end.point[1] - start.point[1]], t));
      }
      if (end.length >= startAt) result.push(end.point);
    }
    const roundedEnds = [];
    if (kneeContour) {
      const radius = Math.min(8, (startRight - startLeft) * .24);
      const depths = [0, .12, .34, .65, 1];
      const cutAt = (depth, width) => offset(offset(from, [ux, uy], depth), [-uy, ux], width);
      for (const side of [0, 1]) {
        const direction = side === 0 ? 1 : -1;
        const points = depths.map(progress => {
          const depth = startAt + radius * progress;
          const inset = radius * (1 - Math.sqrt(1 - (1 - progress) ** 2));
          return cutAt(depth, spanAt(depth)[side] + direction * inset);
        });
        roundedEnds.push([
          cutAt(startAt - 1, spanAt(startAt)[side] - direction * 50),
          ...points,
          cutAt(startAt + radius, spanAt(startAt + radius)[side] - direction * 50)
        ]);
      }
    }
    return {
      roundedEnds,
      polygon: result,
      from: offset(offset(from, [ux, uy], startAt), [-uy, ux], (startLeft + startRight) * .4),
      overlap: clamp((startRight - startLeft) * .21, 5, 11)
    };
  }

  function featherKnee(thigh, from, knee) {
    const direction = axis(from, knee);
    const start = offset(knee, direction, 1);
    const end = offset(knee, direction, 19);
    const context = thigh.layer.getContext('2d');
    const fade = context.createLinearGradient(...start, ...end);
    fade.addColorStop(0, 'transparent');
    fade.addColorStop(.58, 'rgba(0,0,0,.46)');
    fade.addColorStop(1, '#000');
    context.globalCompositeOperation = 'destination-out';
    context.fillStyle = fade;
    context.fillRect(thigh.x, thigh.y, thigh.layer.width, thigh.layer.height);
  }

  function prepareKneecap(thigh, from, knee, overlap) {
    const heading = angleOf(from, knee);
    const sample = offset(knee, axis(from, knee), -12);
    const halfWidth = clamp(overlap * 2.1, 13, 24);
    const halfHeight = clamp(overlap * 2.4, 14, 23);
    const layer = canvas(60, 62);
    const context = layer.getContext('2d');
    context.translate(30, 31);
    context.save();
    context.rotate(-heading);
    context.translate(-sample[0], -sample[1]);
    drawCutout(context, thigh);
    context.restore();
    context.scale(halfHeight, halfWidth);
    const edge = context.createRadialGradient(0, 0, .25, 0, 0, 1);
    edge.addColorStop(0, 'rgba(0,0,0,.82)');
    edge.addColorStop(.61, 'rgba(0,0,0,.53)');
    edge.addColorStop(1, 'transparent');
    context.globalCompositeOperation = 'destination-in';
    context.fillStyle = edge;
    context.fillRect(-30 / halfHeight, -31 / halfWidth, 60 / halfHeight, 62 / halfWidth);
    return layer;
  }

  function prepareLeg(config, source, leg) {
    const thighFrom = leg.thighFrom ?? leg.hip;
    const thighKnee = leg.thighKnee ?? leg.knee;
    const thigh = cutout(source, leg.thigh, leg.exclude, leg.thighTint);
    const shinEnd = leg.shinTo ?? leg.ankle;
    const shin = shinAtKnee(leg.shin, leg.shinFrom ?? leg.knee, shinEnd, leg.kneeContour);
    const kneecap = prepareKneecap(thigh, thighFrom, thighKnee, shin.overlap);
    if (!leg.kneeContour) featherKnee(thigh, thighFrom, thighKnee);
    return {
      lengths: limbLengths(config, leg),
      thigh, thighFrom, thighKnee,
      shin: cutout(source, shin.polygon, [...(leg.exclude ?? []), ...shin.roundedEnds], leg.shinTint),
      shinFrom: shin.from, shinEnd, kneeOverlap: shin.overlap, kneecap,
      shoe: cutout(source, leg.shoe, leg.exclude, leg.shoeTint)
    };
  }

  function paintRepairs(paint, source, patches) {
    for (const patch of patches) {
      trace(paint, patch.points, Boolean(patch.fill || patch.copy));
      if (patch.copy) {
        paint.save();
        paint.clip();
        paint.translate(...patch.copy.center);
        paint.rotate(patch.copy.angle);
        paint.translate(-patch.copy.center[0], -patch.copy.center[1]);
        paint.drawImage(source, 0, 0);
        paint.restore();
      }
      if (patch.fill) {
        paint.fillStyle = patch.fill;
        paint.fill();
      }
      if (patch.stroke) {
        paint.strokeStyle = patch.stroke;
        paint.lineWidth = patch.width;
        paint.stroke();
      }
    }
  }

  function rearRimPolygon(config) {
    if (!config.rearRimFrontArc) return null;
    const [start, end] = config.rearRimFrontArc;
    const [x, y, rx, ry = rx] = config.wheels.rear;
    const steps = Math.ceil((end - start) / .07);
    const point = (angle, radius) => [x + Math.cos(angle) * rx * radius, y + Math.sin(angle) * ry * radius];
    const edges = Array.from({length: steps + 1}, (_, step) => start + (end - start) * step / steps);
    // Restore only the original rim on the far-leg foreground. Empty
    // spaces between spokes stay clear, and the near leg is painted on top.
    return [
      ...edges.map(angle => point(angle, 1.025)),
      ...edges.reverse().map(angle => point(angle, .84))
    ];
  }

  function prepareForeground(config, source) {
    const rim = rearRimPolygon(config);
    const polygons = [...(config.foreground ?? [])];
    if (rim) polygons.push(rim);
    if (!polygons.length) return [];
    const points = polygons.flat();
    const x = Math.floor(Math.min(...points.map(point => point[0]))) - 1;
    const y = Math.floor(Math.min(...points.map(point => point[1]))) - 1;
    const width = Math.ceil(Math.max(...points.map(point => point[0]))) - x + 1;
    const height = Math.ceil(Math.max(...points.map(point => point[1]))) - y + 1;
    const layer = canvas(width, height);
    const context = layer.getContext('2d');
    context.translate(-x, -y);
    for (const polygon of polygons) {
      trace(context, polygon, true);
      context.fill();
    }
    // Sample each source pixel once even where a rim and a frame mask meet.
    context.globalCompositeOperation = 'source-in';
    context.drawImage(source, 0, 0);
    return [{ layer, x, y }];
  }

  function prepare(config, source, cleanImage) {
    const base = canvas(source.naturalWidth, source.naturalHeight);
    const context = base.getContext('2d');
    context.drawImage(cleanImage ?? source, 0, 0);
    if (!cleanImage) {
      const mask = canvas(base.width, base.height);
      const maskContext = mask.getContext('2d');
      for (const polygon of config.erase ?? []) {
        trace(maskContext, polygon, true);
        maskContext.fill();
      }
      context.globalCompositeOperation = 'destination-out';
      context.drawImage(mask, 0, 0);
      context.globalCompositeOperation = 'source-over';
      if (config.restore?.length) {
        const repair = canvas(base.width, base.height);
        const paint = repair.getContext('2d');
        paint.lineCap = 'round';
        paint.lineJoin = 'round';
        paintRepairs(paint, source, config.restore.filter(patch => !patch.bridge));
        paint.globalCompositeOperation = 'destination-in';
        paint.drawImage(source, 0, 0);
        // A few traced tubes span an area that was transparent in the source.
        paint.globalCompositeOperation = 'source-over';
        paintRepairs(paint, source, config.restore.filter(patch => patch.bridge));
        paint.globalCompositeOperation = 'destination-in';
        paint.drawImage(mask, 0, 0);
        context.globalCompositeOperation = 'destination-over';
        context.drawImage(repair, 0, 0);
        context.globalCompositeOperation = 'source-over';
      }
    }
    return {
      config,
      base,
      upper: globalThis.RiderUpperBody?.create(config, base),
      foreground: prepareForeground(config, base),
      garment: (config.garment ?? []).map((polygon) => cutout(source, polygon)),
      legs: config.legs.map(leg => prepareLeg(config, source, leg))
    };
  }

  function drawCutout(context, patch) {
    context.drawImage(patch.layer, patch.x, patch.y);
  }

  function drawBone(context, patch, fromJoint, endJoint, toJoint, targetEnd, widthScale) {
    context.save();
    context.translate(...toJoint);
    context.rotate(angleOf(toJoint, targetEnd));
    context.scale(distance(toJoint, targetEnd) / distance(fromJoint, endJoint), widthScale);
    context.rotate(-angleOf(fromJoint, endJoint));
    context.translate(-fromJoint[0], -fromJoint[1]);
    drawCutout(context, patch);
    context.restore();
  }

  function drawLeg(context, leg, texture, pose, far) {
    const widthScale = leg.widthScale ?? (far ? 0.92 : 1);
    const shinStart = offset(pose.knee, axis(pose.knee, pose.ankle), -texture.kneeOverlap);
    drawBone(context, texture.shin, texture.shinFrom, texture.shinEnd, shinStart, pose.ankle, widthScale);
    drawBone(context, texture.thigh, texture.thighFrom, texture.thighKnee, pose.hip, pose.knee, widthScale);
    const upper = angleOf(pose.hip, pose.knee);
    const lower = angleOf(pose.knee, pose.ankle);
    const bend = Math.atan2(Math.sin(lower - upper), Math.cos(lower - upper));
    // A patch of the rider's own thigh texture blends the joint at the
    // bisector while the two limbs preserve their original outer contours.
    context.save();
    context.translate(...pose.knee);
    context.rotate(upper + bend * .48);
    context.scale(1, widthScale);
    context.drawImage(texture.kneecap, -30, -31);
    context.restore();

    context.save();
    context.translate(...pose.pedal);
    context.rotate(pose.pitch - (leg.pitch ?? 0));
    const shoeScale = leg.shoeScale ?? 1;
    context.scale(shoeScale, shoeScale);
    context.translate(-leg.sole[0], -leg.sole[1]);
    drawCutout(context, texture.shoe);
    context.restore();
  }

  function drawCrank(context, config, pose, far) {
    const unit = config.radius / 54;
    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (far) context.globalAlpha = 0.73;
    context.beginPath();
    context.moveTo(...config.crank);
    context.lineTo(...pose.pedal);
    context.strokeStyle = config.armOutline ?? '#383437';
    context.lineWidth = 8 * unit;
    context.stroke();
    context.strokeStyle = config.armColor ?? '#8b817d';
    context.lineWidth = 4.2 * unit;
    context.stroke();
    context.translate(...pose.pedal);
    context.rotate(pose.pitch);
    context.fillStyle = config.pedalColor ?? '#343037';
    context.fillRect(-17 * unit, 0, 34 * unit, 6 * unit);
    context.fillStyle = config.armColor ?? '#8b817d';
    context.fillRect(-12 * unit, 4.3 * unit, 24 * unit, 1.2 * unit);
    context.restore();
  }

  function drawWheelMotion(context, [x, y, radius, verticalRadius = radius], travel, far) {
    const spin = travel / radius;
    context.save();
    context.translate(x, y);
    context.scale(1, verticalRadius / radius);
    context.lineCap = 'round';
    context.beginPath();
    for (let spoke = 0; spoke < 16; spoke++) {
      const angle = spin + spoke * TAU / 16;
      const side = spoke % 2 ? .045 : -.045;
      context.moveTo(Math.cos(angle + side) * radius * .09, Math.sin(angle + side) * radius * .09);
      context.lineTo(Math.cos(angle) * radius * .895, Math.sin(angle) * radius * .895);
    }
    context.strokeStyle = far ? 'rgba(166,191,207,.30)' : 'rgba(191,211,220,.34)';
    context.lineWidth = 1.55;
    context.stroke();
    for (let marker = 0; marker < 3; marker++) {
      const angle = spin + marker * TAU / 3;
      context.beginPath();
      context.arc(0, 0, radius * .70, angle, angle + .17);
      context.strokeStyle = marker === 0 ? 'rgba(236,247,250,.88)' : 'rgba(192,218,234,.50)';
      context.lineWidth = marker === 0 ? 3.4 : 1.9;
      context.stroke();
    }
    context.restore();
  }

  function drawRig(context, rig, crankAngle, sourceRect, destinationRect, wheelTravel, motion) {
    const [sx, sy, sw, sh] = sourceRect;
    const [dx, dy, dw, dh] = destinationRect;
    const { config, base, legs, foreground, garment } = rig;
    const poses = solvePose(config, crankAngle, legs.map((leg) => leg.lengths));
    // Preserve the two solved lengths. Source shading and the foreground frame
    // layers give depth to overlapping knees without displacing either joint.
    context.save();
    context.beginPath();
    context.rect(dx, dy, dw, dh);
    context.clip();
    context.translate(dx, dy);
    context.scale(dw / sw, dh / sh);
    context.translate(-sx, -sy);
    // Spokes and rim markers pass behind the original fork, frame and artwork.
    if (config.wheels) {
      drawWheelMotion(context, config.wheels.rear, wheelTravel, true);
      drawWheelMotion(context, config.wheels.front, wheelTravel, false);
    }
    if (rig.upper && !motion?.reduceMotion) {
      globalThis.RiderUpperBody.draw(context, rig.upper, crankAngle, motion);
    } else {
      context.drawImage(base, 0, 0);
    }
    drawCrank(context, config, poses[0], true);
    drawLeg(context, config.legs[0], legs[0], poses[0], true);
    for (const patch of foreground) drawCutout(context, patch);
    drawCrank(context, config, poses[1], false);
    drawLeg(context, config.legs[1], legs[1], poses[1], false);
    for (const patch of garment) drawCutout(context, patch);
    context.restore();
  }

  function create(configs = []) {
    const entries = new Map(configs.map((config) => [config.source, {config}]));
    const recent = new Set();
    return {
      wheelContacts(source, sourceRect, destinationRect) {
        const wheels = entries.get(source)?.config.wheels;
        if (!wheels) return null;
        const [sx, sy, sw, sh] = sourceRect;
        const [dx, dy, dw, dh] = destinationRect;
        const contact = ([x, y, radius, verticalRadius = radius]) => [
          dx + (x - sx) * dw / sw,
          dy + (y + verticalRadius - sy) * dh / sh
        ];
        return { rear: contact(wheels.rear), front: contact(wheels.front) };
      },
      draw(context, source, image, crankAngle, sourceRect, destinationRect, wheelTravel = crankAngle * 210, motion) {
        const entry = entries.get(source);
        if (!entry || !image?.complete || !image.naturalWidth || entry.failed || !Number.isFinite(crankAngle)) {
          return false;
        }
        if (!entry.rig) {
          if (entry.config.clean) {
            if (!entry.clean) {
              entry.clean = new Image();
              entry.clean.src = entry.config.clean;
            }
            if (!entry.clean.complete) return false;
            if (!entry.clean.naturalWidth) {
              entry.failed = true;
              return false;
            }
          }
          try {
            entry.rig = prepare(entry.config, image, entry.clean);
          } catch {
            entry.failed = true;
            return false;
          }
        }
        recent.delete(entry);
        recent.add(entry);
        if (recent.size > 3) {
          const oldest = recent.values().next().value;
          oldest.rig = null;
          oldest.clean = null;
          recent.delete(oldest);
        }
        drawRig(context, entry.rig, crankAngle, sourceRect, destinationRect, wheelTravel, motion);
        return true;
      }
    };
  }

  globalThis.RiderPedaling = { create, solvePose };
})();
