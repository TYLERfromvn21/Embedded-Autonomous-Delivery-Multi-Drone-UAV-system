const EARTH_RADIUS_M = 6371000;
const HORIZONTAL_PROTECTION_M = 10;
const VERTICAL_PROTECTION_M = 5;
const HORIZONTAL_SIGMA_M = Math.sqrt(2 * (5 ** 2 + 3 ** 2 + 2 ** 2));
const VERTICAL_SIGMA_M = Math.sqrt(2) * 2;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function project(point, reference) {
  const latitudeRadians = reference.lat * Math.PI / 180;
  return {
    x: (point.lon - reference.lon) * Math.PI / 180 * EARTH_RADIUS_M * Math.cos(latitudeRadians),
    y: (point.lat - reference.lat) * Math.PI / 180 * EARTH_RADIUS_M,
    alt: Number(point.alt) || 0,
  };
}

function closestSegmentPoints(a0, a1, b0, b1) {
  const ux = a1.x - a0.x;
  const uy = a1.y - a0.y;
  const vx = b1.x - b0.x;
  const vy = b1.y - b0.y;
  const wx = a0.x - b0.x;
  const wy = a0.y - b0.y;
  const aa = ux * ux + uy * uy;
  const bb = ux * vx + uy * vy;
  const cc = vx * vx + vy * vy;
  const dd = ux * wx + uy * wy;
  const ee = vx * wx + vy * wy;
  let s = 0;
  let t = 0;
  if (aa <= 1e-9 && cc <= 1e-9) {
    return { first: a0, second: b0, s, t };
  }
  if (aa <= 1e-9) {
    t = clamp(ee / cc, 0, 1);
  } else if (cc <= 1e-9) {
    s = clamp(-dd / aa, 0, 1);
  } else {
    const denominator = aa * cc - bb * bb;
    s = denominator > 1e-9 ? clamp((bb * ee - cc * dd) / denominator, 0, 1) : 0;
    t = (bb * s + ee) / cc;
    if (t < 0) {
      t = 0;
      s = clamp(-dd / aa, 0, 1);
    } else if (t > 1) {
      t = 1;
      s = clamp((bb - dd) / aa, 0, 1);
    }
  }

  const first = { x: a0.x + s * ux, y: a0.y + s * uy, alt: a0.alt + s * (a1.alt - a0.alt) };
  const second = { x: b0.x + t * vx, y: b0.y + t * vy, alt: b0.alt + t * (b1.alt - b0.alt) };
  return { first, second, s, t };
}

function centralChiSquareCdf(degreesOfFreedomHalf, x) {
  let term = 1;
  let sum = 1;
  for (let i = 1; i <= degreesOfFreedomHalf; i += 1) {
    term *= x / i;
    sum += term;
  }
  return clamp(1 - Math.exp(-x) * sum, 0, 1);
}

function radialCollisionProbability(distance, sigma, radius) {
  const normalizedDistance = distance / sigma;
  if (normalizedDistance > 12) return 0;

  const poissonMean = (normalizedDistance ** 2) / 2;
  const normalizedRadiusSquared = (radius / sigma) ** 2 / 2;
  let poissonWeight = Math.exp(-poissonMean);
  let probability = 0;
  for (let k = 0; k < 100; k += 1) {
    probability += poissonWeight * centralChiSquareCdf(k, normalizedRadiusSquared);
    poissonWeight *= poissonMean / (k + 1);
    if (poissonWeight < 1e-12 && k > poissonMean) break;
  }
  return clamp(probability, 0, 1);
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function verticalCollisionProbability(distance, sigma, clearance) {
  return clamp(
    normalCdf((clearance - distance) / sigma) - normalCdf((-clearance - distance) / sigma),
    0,
    1,
  );
}

function routeSegments(route, reference) {
  const points = route.points.filter((point) =>
    Number.isFinite(point.lat) && Number.isFinite(point.lon),
  ).map((point) => project(point, reference));
  const segments = [];
  if (points.length === 1) segments.push([points[0], points[0]]);
  for (let i = 0; i < points.length - 1; i += 1) {
    segments.push([points[i], points[i + 1]]);
  }
  return segments;
}

export function estimateRouteConflicts(routes) {
  const conflicts = [];
  for (let firstIndex = 0; firstIndex < routes.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < routes.length; secondIndex += 1) {
      const firstRoute = routes[firstIndex];
      const secondRoute = routes[secondIndex];
      const allPoints = [...firstRoute.points, ...secondRoute.points];
      if (allPoints.length === 0) continue;
      const reference = {
        lat: allPoints.reduce((sum, point) => sum + point.lat, 0) / allPoints.length,
        lon: allPoints.reduce((sum, point) => sum + point.lon, 0) / allPoints.length,
      };
      const firstSegments = routeSegments(firstRoute, reference);
      const secondSegments = routeSegments(secondRoute, reference);
      let highestRisk = null;

      firstSegments.forEach(([a0, a1]) => {
        secondSegments.forEach(([b0, b1]) => {
          const closest = closestSegmentPoints(a0, a1, b0, b1);
          const horizontalDistance = Math.hypot(
            closest.first.x - closest.second.x,
            closest.first.y - closest.second.y,
          );
          const verticalDistance = Math.abs(closest.first.alt - closest.second.alt);
          const horizontalProbability = radialCollisionProbability(
            horizontalDistance,
            HORIZONTAL_SIGMA_M,
            HORIZONTAL_PROTECTION_M,
          );
          const verticalProbability = verticalCollisionProbability(
            verticalDistance,
            VERTICAL_SIGMA_M,
            VERTICAL_PROTECTION_M,
          );
          const probability = horizontalProbability * verticalProbability;

          if (!highestRisk || probability > highestRisk.probability) {
            highestRisk = {
              probability,
              horizontalDistance,
              verticalDistance,
              midpoint: {
                lat: reference.lat + ((closest.first.y + closest.second.y) / 2) / EARTH_RADIUS_M * 180 / Math.PI,
                lon: reference.lon + ((closest.first.x + closest.second.x) / 2) /
                  (EARTH_RADIUS_M * Math.cos(reference.lat * Math.PI / 180)) * 180 / Math.PI,
              },
            };
          }
        });
      });

      if (highestRisk && highestRisk.probability >= 0.05) {
        conflicts.push({
          firstUav: firstRoute.uavId,
          secondUav: secondRoute.uavId,
          ...highestRisk,
        });
      }
    }
  }
  return conflicts.sort((a, b) => b.probability - a.probability);
}

export const COLLISION_MODEL = {
  horizontalProtectionM: HORIZONTAL_PROTECTION_M,
  verticalProtectionM: VERTICAL_PROTECTION_M,
  perVehicleHorizontalSigmaM: Math.sqrt(5 ** 2 + 3 ** 2 + 2 ** 2),
  perVehicleVerticalSigmaM: 2,
};
