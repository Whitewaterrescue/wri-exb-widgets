/**
 * trace-engine.js — National spill trajectory engine (JS port of spill_trace.py)
 * ==============================================================================
 *
 * Faithful port of the Python oracle. Dependency-free ESM: runs in plain Node
 * (>=18, global fetch) for golden testing and in the browser inside the ExB
 * widget. NO @arcgis imports here — the widget wraps this module and supplies
 * layer access through injectable providers:
 *
 *   config.widthProvider(envelope)  -> [{lat, lon, width}]   (GLOW midpoints in bbox)
 *   config.siteProviders            -> [{name, buffer_m, fetch: async () => [{name, lat, lon, ...extra}]}]
 *   config.receptorProviders        -> same shape as siteProviders
 *
 * Port gotchas honored (see README):
 *   1. geoserver CQL BBOX is lat,lon axis order (EPSG:4269 / WFS 2.0)
 *   2. HR NHDPlusID != MR comid — widths sampled spatially, never ID-joined
 *   3. impoundment = wbareatype in (LakePond, Reservoir)
 *   4. width override sampled in windows; failure degrades to formula widths
 *   5. NLDI/geoserver empty-200 -> retry 3x with backoff
 *   6. snap click to streamorde >= minStreamOrder
 *
 * Corridor mode (v1.6): US federal services (NLDI/NHDPlus/NWIS) end at the
 * border. config.corridors lists precomputed corridor files (see
 * corridors/build_corridors.py) — a stationed centerline + authored hydraulic
 * attributes + a flow model bound to ECCC (Water Survey of Canada) gauges.
 * A click that lands within a corridor's snap_m runs entirely on corridor
 * data; corridors chain downstream via continues_to (Brunette -> Fraser),
 * with short confluence gaps bridged by a straight connector that inherits
 * the DOWNSTREAM corridor's hydraulics. All physics (computeTrace) is shared
 * with the US path.
 */

export const ENGINE_VERSION = "1.8.0";

const NLDI_BASE = "https://api.water.usgs.gov/nldi";
const GEOSERVER = "https://api.water.usgs.gov/geoserver/wmadata/ows";
const NWIS_IV = "https://waterservices.usgs.gov/nwis/iv/";
const NWIS_SITE = "https://waterservices.usgs.gov/nwis/site/";
const NWIS_STAT = "https://waterservices.usgs.gov/nwis/stat/";
const ECCC_API = "https://api.weather.gc.ca/collections";

/**
 * NHDPlus MR waterbody flags lag reality — reaches through REMOVED dams still
 * carry wbareatype LakePond and would false-stop the clock. Known removals
 * are excluded here (extendable per-run via config.impoundExcludeComids).
 */
export const REMOVED_IMPOUNDMENT_COMIDS = new Set([
  // Milltown Dam, Clark Fork at Bonner MT — removed 2008-2010 (reported by Cody 2026-07-07)
  24293120, 24293122, 24293124,
]);

export const DEFAULT_CONFIG = {
  maxDistanceKm: 300,
  maxHours: 24,
  resolutionM: 100.0,
  safetyFactor: 1.5,
  manningN: 0.045,
  minStreamOrder: 4,
  widthProvider: null,        // async (env {xmin,ymin,xmax,ymax}) => [{lat, lon, width}]
  widthSampleRadiusM: 800,
  widthWindowPoints: 100,     // trace points per override sampling window (~10 km)
  siteProviders: [],
  receptorProviders: [],
  upstreamGaugeKm: 30,        // search UM this far for an upstream anchor gauge; 0 = off
  qInterp: "drainage-area",   // 'drainage-area' (Q jumps at confluences) | 'distance' (legacy linear smear)
  gaugeStatFallback: true,    // gauge IV feed down -> period-of-record median daily flow (Payton's get_discharge pattern)
  impoundStopKm: 2.0,
  impoundExcludeComids: [],   // extra removed-dam comids beyond REMOVED_IMPOUNDMENT_COMIDS
  corridors: [],              // corridor docs or URLs (Canadian rivers, see corridors/)
  corridorGapMaxM: 2000,      // max confluence gap bridged when chaining corridors
  timingModel: "hydraulic",   // 'hydraulic' (V=Q/A x safety) | 'jobson' (USGS WRIR 96-4013 dye-study regressions)
  asOf: null,                 // 'YYYY-MM-DD' historical Q; null = live
  verbose: true,
  openWater: {},              // overrides for DEFAULT_OPENWATER (v1.7 lake/reservoir mode)
};

/** Open-water (lake/reservoir) mode — GNOME-style particle transport
 *  (NOAA Tech Doc NOS OR&R 40, public domain). Validated in openwater-spike/. */
export const DEFAULT_OPENWATER = {
  enabled: true,              // lake-click dispatch + impoundment continuation
  minLakeSqKm: 1.0,           // PIP hits smaller than this stay on the river path
                              // (guards removed-dam relic polygons, farm ponds)
  riverOverrideM: 400,        // non-impounded reach this close → river mode wins
                              // (dam tailraces sit inside reservoir polygons)
  nParticles: 1000,
  durationHr: 24,             // sim length from water entry (continuations too)
  timestepS: 900,
  windageMin: 0.01,           // GNOME 1–4% of U10, uniform per particle
  windageMax: 0.04,
  windagePersistS: 900,
  diffusionM2s: 1.0,          // lakes/protected water (GNOME "low"); coastal = 10
  refloatHalfLifeHr: 1.0,
  continueAtImpoundment: true,
  shoreGapSegs: 3,            // beached-cluster merge tolerance (shoreline segments)
  maxShoreImpacts: 10,
  seed: 12345,                // deterministic replays; runRecord carries it
  // coastal (Tier 3): estuary/sound clicks blend CO-OPS tidal-current
  // predictions from the nearest stations into the advection
  coastalCurrents: true,
  currentStationsMax: 3,
  currentStationMaxKm: 15,
  coastalDiffusionM2s: 10,    // GNOME coastal default (lakes stay at 1)
};

// ---------------------------------------------------------------- helpers

const R_EARTH = 6371008.8;

export function haversineM(lat1, lon1, lat2, lon2) {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

/** Payton's width/depth formulas (fallback when no GLOW data). Verbatim. */
export function estimateGeometryPayton(drainageAreaSqMi) {
  let width, depth;
  if (drainageAreaSqMi < 100) {
    width = 10.0 * Math.pow(drainageAreaSqMi / 50, 0.5);
    depth = 0.5 * Math.pow(drainageAreaSqMi / 50, 0.3);
  } else if (drainageAreaSqMi < 1000) {
    width = 50.0 * Math.pow(drainageAreaSqMi / 500, 0.5);
    depth = 1.5 * Math.pow(drainageAreaSqMi / 500, 0.3);
  } else {
    width = 150.0 * Math.pow(drainageAreaSqMi / 5000, 0.4);
    depth = 3.0 * Math.pow(drainageAreaSqMi / 5000, 0.3);
  }
  return [width, depth];
}

/**
 * Manning's depth via bisection (Python used scipy brentq on [0.1, 20]).
 * The residual is monotonically increasing in depth, so bisection converges to
 * the same root. Replicates brentq's failure mode: no sign change across the
 * bracket -> null (caller falls back to formula depth).
 */
export function calculateDepthManning(Qm3s, widthM, slope, n = 0.045) {
  if (Qm3s <= 0 || widthM <= 0 || slope <= 0.00001) return null;
  const residual = (depth) => {
    if (depth <= 0.01) return -Qm3s;
    const A = widthM * depth;
    const P = widthM + 2 * depth;
    const R = A / P;
    return (1 / n) * A * Math.pow(R, 2 / 3) * Math.sqrt(slope) - Qm3s;
  };
  let lo = 0.1, hi = 20.0;
  let flo = residual(lo), fhi = residual(hi);
  if (flo === 0) return lo;
  if (fhi === 0) return hi;
  if (flo * fhi > 0) return null; // brentq raises -> Python returns None
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    const fm = residual(mid);
    if (fm === 0 || (hi - lo) / 2 < 1e-10) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return 0.5 * (lo + hi);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET/POST with retry — NLDI/geoserver intermittently return empty 200 bodies. */
async function getJson(url, { params = null, data = null, tries = 3, timeoutMs = 90000 } = {}) {
  let last = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let resp;
      try {
        if (data !== null) {
          resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(data).toString(),
            signal: ctrl.signal,
          });
        } else {
          const qs = params ? "?" + new URLSearchParams(params).toString() : "";
          resp = await fetch(url + qs, { signal: ctrl.signal });
        }
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json(); // empty body -> SyntaxError -> retry
    } catch (e) {
      last = e;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw new Error(`${url} failed after ${tries} tries: ${last}`);
}

async function getText(url, params, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url + "?" + new URLSearchParams(params).toString(), { signal: ctrl.signal });
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- data fetch

/** Snap to nearest reach with streamorde >= minOrder (geoserver bbox search). */
async function snapComid(lat, lon, minOrder) {
  const box = 0.2;
  // NOTE: EPSG:4269 under WFS 2.0 uses lat,lon axis order in CQL BBOX
  const j = await getJson(GEOSERVER, {
    data: {
      service: "WFS", version: "2.0.0", request: "GetFeature",
      typeName: "wmadata:nhdflowline_network", outputFormat: "application/json",
      cql_filter:
        `streamorde >= ${minOrder} AND BBOX(the_geom,` +
        `${lat - box},${lon - box},${lat + box},${lon + box})`,
      count: "500",
    },
  });
  let best = null, bestD = Infinity;
  for (const f of j.features || []) {
    const g = f.geometry;
    const paths = g.type === "LineString" ? [g.coordinates] : g.coordinates;
    for (const path of paths) {
      for (let i = 0; i < path.length; i += 3) { // every 3rd vertex
        const p = path[i];
        const d = haversineM(lat, lon, p[1], p[0]);
        if (d < bestD) { bestD = d; best = f.properties; }
      }
    }
  }
  if (best !== null) return [Number(best.comid), best.gnis_name ?? null, bestD];
  return [await nldiPositionComid(lat, lon), null, null];
}

async function nldiPositionComid(lat, lon) {
  const j = await getJson(`${NLDI_BASE}/linked-data/comid/position`, {
    params: { coords: `POINT(${lon} ${lat})` }, timeoutMs: 30000,
  });
  return Number(j.features[0].properties.identifier);
}

async function nldiDmFlowlines(comid, distanceKm) {
  const j = await getJson(`${NLDI_BASE}/linked-data/comid/${comid}/navigation/DM/flowlines`, {
    params: { distance: String(Math.trunc(distanceKm)) },
  });
  const geoms = new Map(); // comid -> [paths] ([[lon,lat],...])
  for (const f of j.features || []) {
    const cid = Number(f.properties.nhdplus_comid);
    const g = f.geometry;
    if (g.type === "LineString") geoms.set(cid, [g.coordinates]);
    else if (g.type === "MultiLineString") geoms.set(cid, g.coordinates);
  }
  return geoms;
}

async function nldiGauges(comid, distanceKm, mode) {
  const j = await getJson(`${NLDI_BASE}/linked-data/comid/${comid}/navigation/${mode}/nwissite`, {
    params: { distance: String(Math.trunc(distanceKm)) },
  });
  const out = [];
  for (const f of j.features || []) {
    const sid = (f.properties.identifier || "").replace("USGS-", "");
    if (sid.length > 15) continue; // coordinate-style IDs (notebook rule)
    out.push({
      station_id: sid,
      name: f.properties.name || "Unknown",
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
    });
  }
  return out;
}

/**
 * Merge the nearest upstream main-stem gauge into the located-gauge list as a
 * virtual gauge at the spill point (trace_dist 0). Without this, clicking just
 * DOWNSTREAM of a gauge drops it from the DM navigation and the next gauge's Q
 * is back-clamped onto the first reach — wildly wrong when that gauge sits
 * below a major confluence (Gallatin below Logan -> Missouri at Toston).
 * Q is transferred by drainage-area ratio (standard USGS transfer), which also
 * keeps the anchor honest when the UM path crosses a confluence: the ratio
 * scales a tributary gauge back up to the flow at the click.
 * No-op when an on-trace gauge already sits within anchorSkipM of the start
 * (it already anchors the boundary), the station is already located, or the
 * DA transfer is outside its credible range.
 */
export function mergeUpstreamAnchor(gd, up, spillDaSqmi, { anchorSkipM = 500, daRatioMax = 4 } = {}) {
  if (!up || !(up.discharge >= 0) || !(up.drainage_area > 0) || !(spillDaSqmi > 0)) return false;
  if (gd.some((g) => g.station_id === up.station_id)) return false;
  if (gd.some((g) => g.trace_dist <= anchorSkipM)) return false;
  const ratio = spillDaSqmi / up.drainage_area;
  if (ratio < 1 / daRatioMax || ratio > daRatioMax) return false;
  const [w, dep] = estimateGeometryPayton(spillDaSqmi);
  gd.push({
    station_id: up.station_id, name: up.name, lat: up.lat, lon: up.lon,
    discharge: up.discharge * ratio, drainage_area: spillDaSqmi,
    q_source: up.q_source || "iv",
    area: w * dep, trace_dist: 0.0,
    upstream_anchor: true,
    anchor_gauge_q_cfs: up.discharge, anchor_gauge_da_sqmi: up.drainage_area,
    anchor_upstream_m: up.upstream_m ?? null,
  });
  gd.sort((a, b) => a.trace_dist - b.trace_dist);
  return true;
}

/** VAAs for a list of COMIDs from USGS geoserver (batched POST). */
async function vaaBatch(comids) {
  const out = new Map();
  const CHUNK = 150;
  for (let i = 0; i < comids.length; i += CHUNK) {
    const chunk = comids.slice(i, i + CHUNK);
    const j = await getJson(GEOSERVER, {
      data: {
        service: "WFS", version: "2.0.0", request: "GetFeature",
        typeName: "wmadata:nhdflowline_network",
        outputFormat: "application/json",
        cql_filter: `comid IN (${chunk.join(",")})`,
      },
    });
    for (const f of j.features || []) {
      const p = f.properties;
      // EROM monthly modeled flow (gauge-adjusted, cfs) — ungauged fallback + Jobson Qa
      const qe = {};
      for (let m = 1; m <= 12; m++) {
        const k = `qe_${String(m).padStart(2, "0")}`;
        qe[m] = p[k] ?? null;
      }
      out.set(Number(p.comid), {
        hydroseq: p.hydroseq ?? null,
        streamorde: p.streamorde ?? null,
        slope: p.slope ?? null,
        totdasqkm: p.totdasqkm ?? null,
        ftype: p.ftype ?? null,
        fcode: p.fcode ?? null,
        gnis_name: p.gnis_name ?? null,
        // LakePond/Reservoir = impounded; StreamRiver = braided free-flowing
        wbareatype: p.wbareatype ?? null,
        ve_ma: p.ve_ma ?? null,
        qe_ma: p.qe_ma ?? null,   // EROM mean annual flow (cfs) — Jobson Qa
        qe_monthly: qe,
        // NHDPlus divergence: 0 = none, 1 = main path, 2 = minor path of a split
        divergence: p.divergence ?? 0,
      });
    }
  }
  return out;
}

/** Discharge (cfs) + drainage area (sq mi) per gauge via plain NWIS REST.
 *  statFallback (v1.5, Payton's get_discharge pattern): gauges whose IV feed
 *  is down/negative get the period-of-record MEDIAN daily flow (stat service
 *  p50, needs >3 years of record) for the run date's calendar day, flagged
 *  q_source='stat-p50' so the run can warn it isn't live conditions. */
async function gaugeInfo(stationIds, asOf = null, statFallback = false) {
  const info = new Map();
  if (!stationIds.length) return info;
  const sites = stationIds.join(",");

  // drainage areas (rdb, expanded output)
  try {
    const text = await getText(NWIS_SITE, { format: "rdb", sites, siteOutput: "expanded" });
    const lines = text.split("\n").filter((l) => l && !l.startsWith("#"));
    if (lines.length >= 2) {
      const hdr = lines[0].split("\t");
      const iSite = hdr.indexOf("site_no");
      const iDa = hdr.indexOf("drain_area_va"); // -1 if absent
      for (const line of lines.slice(2)) {
        const parts = line.split("\t");
        if (parts.length <= Math.max(iSite, iDa > -1 ? iDa : 0)) continue;
        let da = null;
        if (iDa > -1) {
          const v = parseFloat(parts[iDa]);
          da = Number.isFinite(v) ? v : null;
        }
        info.set(parts[iSite], { drainage_area: da });
      }
    }
  } catch { /* ignore — matches Python */ }

  // discharge
  const params = { format: "json", sites, parameterCd: "00060" };
  if (asOf) { params.startDT = asOf; params.endDT = asOf; }
  else params.period = "P1D";
  try {
    const j = await getJson(NWIS_IV, { params, timeoutMs: 60000, tries: 1 });
    for (const ts of j?.value?.timeSeries || []) {
      const sid = ts.sourceInfo.siteCode[0].value;
      const vals = ts.values[0].value;
      if (!vals || !vals.length) continue;
      const q = parseFloat(vals[vals.length - 1].value);
      if (q >= 0) {
        if (!info.has(sid)) info.set(sid, {});
        info.get(sid).discharge = q;
        info.get(sid).q_source = "iv";
      }
    }
  } catch { /* ignore — matches Python */ }

  // median-daily-flow fallback for gauges the IV pass didn't cover
  if (statFallback) {
    const missing = stationIds.filter((s) => info.get(s)?.discharge === undefined);
    const [month, day] = asOf
      ? [parseInt(asOf.slice(5, 7), 10), parseInt(asOf.slice(8, 10), 10)]
      : [new Date().getMonth() + 1, new Date().getDate()];
    const STAT_CHUNK = 10; // stat service 400s above 10 sites per request
    for (let c = 0; c < missing.length; c += STAT_CHUNK) {
      try {
        const text = await getText(NWIS_STAT, {
          format: "rdb", sites: missing.slice(c, c + STAT_CHUNK).join(","), parameterCd: "00060",
          statReportType: "daily", statTypeCd: "p50",
        });
        const lines = text.split("\n").filter((l) => l && !l.startsWith("#"));
        if (lines.length >= 2) {
          const hdr = lines[0].split("\t");
          const col = (name) => hdr.indexOf(name);
          const [iSite, iMon, iDay, iCount, iP50] =
            ["site_no", "month_nu", "day_nu", "count_nu", "p50_va"].map(col);
          for (const line of lines.slice(2)) {
            const p = line.split("\t");
            if (p.length <= Math.max(iSite, iMon, iDay, iCount, iP50)) continue;
            const sid = p[iSite];
            if (info.get(sid)?.discharge !== undefined) continue; // first matching series wins
            if (parseInt(p[iMon], 10) !== month || parseInt(p[iDay], 10) !== day) continue;
            if (!(parseInt(p[iCount], 10) > 3)) continue; // Payton's record-length rule
            const q = parseFloat(p[iP50]);
            if (!(q >= 0)) continue;
            if (!info.has(sid)) info.set(sid, {});
            info.get(sid).discharge = q;
            info.get(sid).q_source = "stat-p50";
          }
        }
      } catch { /* stat service down -> this chunk's gauges stay dropped, as before */ }
    }
  }
  return info;
}

// ---------------------------------------------------------------- trace assembly

/** Order segments downstream (hydroseq desc), orient, trim to spill point,
 *  emit ~resolutionM spaced points carrying VAA attributes. */
function assembleTrace(lat, lon, geoms, vaa, resolutionM, log) {
  const segs = [];
  for (const [cid, paths] of geoms) {
    const v = vaa.get(cid);
    if (!v || v.hydroseq === null || v.hydroseq === undefined) continue;
    const coords = paths.flat(); // flatten multiline into one vertex list
    if (coords.length < 2) continue;
    segs.push({ comid: cid, coords, ...v });
  }
  segs.sort((a, b) => b.hydroseq - a.hydroseq); // downstream = decreasing hydroseq

  // orient each segment so it flows start->end, chaining ends to starts
  let prevEnd = null;
  for (const s of segs) {
    let c = s.coords;
    if (prevEnd !== null) {
      const dStart = haversineM(prevEnd[1], prevEnd[0], c[0][1], c[0][0]);
      const dEnd = haversineM(prevEnd[1], prevEnd[0], c[c.length - 1][1], c[c.length - 1][0]);
      if (dEnd < dStart) c = c.slice().reverse();
    }
    s.coords = c;
    prevEnd = c[c.length - 1];
  }

  // trim the first segment to start at the vertex nearest the spill point
  if (segs.length) {
    const c0 = segs[0].coords;
    let minI = 0, minD = Infinity;
    for (let i = 0; i < c0.length; i++) {
      const d = haversineM(lat, lon, c0[i][1], c0[i][0]);
      if (d < minD) { minD = d; minI = i; }
    }
    const trimmed = c0.slice(minI);
    segs[0].coords = trimmed.length ? trimmed : [c0[c0.length - 1]];
  }

  // flatten to attributed points, downsample to resolutionM
  let pts = [];
  for (const s of segs) {
    let slope = s.slope;
    if (slope === null || slope === undefined || slope < 0) slope = 0.001; // -9998 = missing
    for (const p of s.coords) {
      pts.push({
        lon: p[0], lat: p[1],
        drainage_area_km2: s.totdasqkm || 0,
        slope,
        ftype: s.ftype, wbareatype: s.wbareatype,
        comid: s.comid,
        gnis_name: s.gnis_name,
        qe_ma: s.qe_ma, qe_monthly: s.qe_monthly,
        divergence: s.divergence || 0,
      });
    }
  }
  if (pts.length > 1) {
    const keep = [pts[0]];
    let cum = 0.0;
    let last = pts[0];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      cum += haversineM(last.lat, last.lon, p.lat, p.lon);
      last = p;
      if (cum >= resolutionM) { keep.push(p); cum = 0.0; }
    }
    pts = keep;
  }
  log(`  trace: ${segs.length} segments -> ${pts.length} points (${segs.length ? segs[0].gnis_name : "?"} ...)`);
  return [pts, segs.length ? segs[0].gnis_name : null];
}

/**
 * DA-weighted discharge interpolator (v1.4): Q as a piecewise-linear function
 * of drainage area between gauges, DA-ratio extrapolated outside the gauge
 * range (uniform-yield assumption — same semantics as the single-gauge path).
 * Because DA jumps at confluences, the Q jump lands AT the confluence instead
 * of smearing linearly over the inter-gauge distance; it also can't back-clamp
 * a post-confluence gauge's full Q onto a small upstream tributary.
 * Gauges whose NWIS DA breaks downstream monotonicity are dropped (NWIS and
 * NHDPlus delineations disagree occasionally). Returns null when fewer than 2
 * monotonic gauges remain — caller falls back to distance interpolation.
 */
export function daWeightedQ(gd) {
  const kept = [];
  for (const g of gd) {
    if (!(g.drainage_area > 0) || !(g.discharge >= 0)) continue;
    if (kept.length && g.drainage_area <= kept[kept.length - 1].drainage_area) continue;
    kept.push(g);
  }
  if (kept.length < 2) return null;
  const fQ = interpClamped(kept.map((g) => g.drainage_area), kept.map((g) => g.discharge));
  const da0 = kept[0].drainage_area, q0 = kept[0].discharge;
  const daN = kept[kept.length - 1].drainage_area, qN = kept[kept.length - 1].discharge;
  return {
    kept,
    q: (da) => {
      if (!(da > 0)) return 1.0;
      if (da <= da0) return q0 * (da / da0);
      if (da >= daN) return qN * (da / daN);
      return fQ(da);
    },
  };
}

/** Clamped linear interpolation (scipy interp1d with clamped fill_value). */
function interpClamped(xs, ys) {
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let i = 1;
    while (xs[i] < x) i++;
    const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return ys[i - 1] + t * (ys[i] - ys[i - 1]);
  };
}

// ---------------------------------------------------------------- corridors (v1.6)
//
// A corridor doc (built offline by corridors/build_corridors.py):
//   { id, name, snap_m, continues_to, tidal_from_km, impoundments:[{from_km,
//     to_km, name}], warnings:[...], attrs:{da_km2|slope|width_m|depth_m:
//     [[km, value], ...]}, flow:{provider, ...}, station_km:[...],
//     vertices:[[lon,lat], ...] }
// Flow providers:
//   eccc-live-sum  — sum live ECCC discharge over flow.stations (each
//                    {id, name, da_km2}); DA-ratio transferred along the
//                    corridor. asOf uses the ECCC daily-mean archive.
//   monthly-median — flow.monthly_median_m3s[month] at flow.ref_da_km2
//                    (rivers with no active gauge, e.g. the Brunette).

const CORRIDOR_CACHE = new Map(); // url -> corridor doc

async function loadCorridors(list, log) {
  const out = [];
  for (const entry of list || []) {
    if (entry && typeof entry === "object" && entry.vertices) { out.push(entry); continue; }
    const url = typeof entry === "string" ? entry : entry?.url;
    if (!url) continue;
    if (!CORRIDOR_CACHE.has(url)) {
      try {
        CORRIDOR_CACHE.set(url, await getJson(url, { timeoutMs: 30000 }));
      } catch (e) {
        log(`  corridor load FAILED (${url}): ${String(e).slice(0, 80)}`);
        CORRIDOR_CACHE.set(url, null);
      }
    }
    const doc = CORRIDOR_CACHE.get(url);
    if (doc) out.push(doc);
  }
  return out;
}

/** Clamped linear interpolation over authored [[km, value], ...] breakpoints. */
function corridorAttr(bps, km, fallback = 0) {
  if (!bps || !bps.length) return fallback;
  if (km <= bps[0][0]) return bps[0][1];
  const last = bps[bps.length - 1];
  if (km >= last[0]) return last[1];
  for (let i = 1; i < bps.length; i++) {
    if (bps[i][0] >= km) {
      const t = (km - bps[i - 1][0]) / (bps[i][0] - bps[i - 1][0]);
      return bps[i - 1][1] + t * (bps[i][1] - bps[i - 1][1]);
    }
  }
  return last[1];
}

function nearestCorridorVertex(lat, lon, corr) {
  let best = Infinity, idx = 0;
  const v = corr.vertices;
  for (let i = 0; i < v.length; i++) {
    const d = haversineM(lat, lon, v[i][1], v[i][0]);
    if (d < best) { best = d; idx = i; }
  }
  return { idx, distM: best };
}

/** Point attributes sampled from a corridor at its native stationing (km). */
function corridorPoint(corr, lon, lat, km, connector = false) {
  const a = corr.attrs || {};
  const impound = (corr.impoundments || []).find((z) => km >= z.from_km && km <= z.to_km);
  return {
    lon, lat,
    drainage_area_km2: corridorAttr(a.da_km2, km, 0),
    slope: Math.max(corridorAttr(a.slope, km, 0.001), 0.00001),
    corridor_width_m: corridorAttr(a.width_m, km, 0),
    depth_override: corridorAttr(a.depth_m, km, 0),
    tidal: corr.tidal_from_km !== null && corr.tidal_from_km !== undefined && km >= corr.tidal_from_km,
    ftype: connector ? "CorridorConnector" : "Corridor",
    wbareatype: impound ? "Reservoir" : "StreamRiver",
    comid: null,
    gnis_name: impound ? (impound.name || corr.name) : corr.name,
    qe_ma: null, qe_monthly: null,
    divergence: 0,
    corridor_id: corr.id,
    corridor_km: km,
  };
}

/** Live/median discharge for a corridor's flow model.
 *  Returns { qM3s, daKm2, source, note } or null (caller warns + errors). */
async function corridorFlow(corr, asOf, log) {
  const flow = corr.flow || {};
  const month = asOf ? parseInt(asOf.slice(5, 7), 10) : new Date().getMonth() + 1;

  const medians = flow.monthly_median_m3s || null;
  const median = medians && medians[String(month)] > 0
    ? { qM3s: medians[String(month)], daKm2: flow.ref_da_km2, source: "monthly-median",
        note: flow.source_note || null }
    : null;

  if (flow.provider === "eccc-live-sum") {
    let qSum = 0, daSum = 0;
    const live = [], down = [];
    for (const st of flow.stations || []) {
      try {
        let q = null;
        if (asOf) {
          const j = await getJson(`${ECCC_API}/hydrometric-daily-mean/items`, {
            params: { STATION_NUMBER: st.id, DATE: asOf, f: "json", limit: "5", skipGeometry: "true" },
            timeoutMs: 30000,
          });
          for (const f of j.features || []) {
            const v = f.properties?.DISCHARGE;
            if (v !== null && v !== undefined && v >= 0) { q = Number(v); break; }
          }
        } else {
          const j = await getJson(`${ECCC_API}/hydrometric-realtime/items`, {
            params: {
              STATION_NUMBER: st.id, f: "json", limit: "48",
              sortby: "-DATETIME", skipGeometry: "true",
              properties: "DISCHARGE,DATETIME,STATION_NUMBER",
            },
            timeoutMs: 30000,
          });
          for (const f of j.features || []) {
            const v = f.properties?.DISCHARGE;
            if (v !== null && v !== undefined && v >= 0) { q = Number(v); break; }
          }
        }
        if (q !== null) { qSum += q; daSum += st.da_km2 || 0; live.push(st.id); }
        else down.push(st.id);
      } catch (e) {
        down.push(st.id);
        log(`  ECCC gauge ${st.id} failed: ${String(e).slice(0, 60)}`);
      }
    }
    // stations without per-station da_km2: usable only when ALL report live
    if (live.length === (flow.stations || []).length && !(daSum > 0)) daSum = flow.ref_da_km2 || 0;
    if (live.length && daSum > 0) {
      return {
        qM3s: qSum, daKm2: daSum, source: "eccc-iv",
        note: `ECCC live: ${live.join("+")}` + (down.length ? ` (feed down: ${down.join(",")})` : ""),
      };
    }
    if (median) {
      log(`  ECCC feed down for ${corr.id} — falling back to monthly median`);
      return { ...median, note: `ECCC feed DOWN (${down.join(",")}) — ${median.note || "historical monthly median"}` };
    }
    return null;
  }

  if (flow.provider === "monthly-median") return median;
  return median; // unknown provider — best effort
}

// ---- tidal corridor support (v1.8, Tier 2) ----------------------------------
//
// A corridor may carry a `tidal` block:
//   { from_km, provider: 'iwls-wlp-slope', station_code, station_name,
//     u_max_ms, phase_lag_min, phase_uncert_min, note }
// The predicted water-level curve at the station is differentiated to a
// normalized signed tide signal T(t) in [-1,1]; along-channel tidal velocity
// is u(t) = -u_max·T(t) (rising level = flood = upstream = negative). This is
// the standing-wave assumption — `phase_lag_min` shifts it for progressive
// reaches, and `phase_uncert_min` feeds the earliest-credible envelope run.
// Amplitude is AUTHORED (warned): tides are deterministic, the amplitude is
// the calibration knob.

const IWLS_API = "https://api-iwls.dfo-mpo.gc.ca/api/v1";

async function fetchIwlsTidalSeries(tidalCfg, asOf, maxHours, log) {
  const sts = await getJson(`${IWLS_API}/stations`, {
    params: { code: tidalCfg.station_code }, timeoutMs: 30000,
  });
  if (!Array.isArray(sts) || !sts.length) throw new Error(`IWLS station ${tidalCfg.station_code} not found`);
  const st = sts[0];
  const t0Ms = asOf ? Date.parse(asOf + "T00:00:00Z") : Date.now();
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z/, "Z");
  const raw = await getJson(`${IWLS_API}/stations/${st.id}/data`, {
    params: {
      "time-series-code": "wlp",
      from: iso(t0Ms - 3 * 3600e3),
      to: iso(t0Ms + (2 * maxHours + 12) * 3600e3),
    },
    timeoutMs: 45000,
  });
  if (!Array.isArray(raw) || raw.length < 20) throw new Error("IWLS wlp series empty");

  // resample to 15-min buckets, central-difference slope, normalize to [-1,1]
  const BUCKET = 900e3;
  const buckets = new Map();
  for (const r of raw) {
    const t = Date.parse(r.eventDate);
    const k = Math.round(t / BUCKET);
    if (!buckets.has(k)) buckets.set(k, Number(r.value));
  }
  const ks = [...buckets.keys()].sort((a, b) => a - b);
  const slopes = [];
  for (let i = 1; i < ks.length - 1; i++) {
    if (ks[i + 1] - ks[i - 1] !== 2) continue; // gap — skip
    slopes.push({ t: ks[i] * BUCKET, s: (buckets.get(ks[i + 1]) - buckets.get(ks[i - 1])) / (2 * 900) });
  }
  if (slopes.length < 10) throw new Error("IWLS series too gappy for slope");
  const maxAbs = Math.max(...slopes.map((x) => Math.abs(x.s)));
  if (!(maxAbs > 0)) throw new Error("IWLS series is flat");
  const lagMs = (tidalCfg.phase_lag_min || 0) * 60e3;
  const uMax = tidalCfg.u_max_ms;
  // series value = along-channel tidal velocity (+downstream); T(t)=slope(t+lag)
  const series = slopes.map((x) => ({ t: x.t - lagMs, u: -uMax * (x.s / maxAbs), v: 0 }));
  log(`  tidal: IWLS ${tidalCfg.station_code} ${st.officialName} — ${series.length} pts, u_max ${uMax} m/s, lag ${tidalCfg.phase_lag_min || 0} min`);
  return {
    series,
    t0Ms,
    station_code: tidalCfg.station_code,
    station_name: tidalCfg.station_name || st.officialName,
    u_max_ms: uMax,
    phase_lag_min: tidalCfg.phase_lag_min || 0,
    phase_uncert_min: tidalCfg.phase_uncert_min ?? 60,
    from_km: tidalCfg.from_km ?? 0,
    source: tidalCfg.provider || "iwls-wlp-slope",
    note: tidalCfg.note || null,
  };
}

/**
 * 1-D leading-edge front through tidal rows: s' = vNet(s) + uTide(t), floored
 * at the head of tide (flood can push the front back, not above the tidal
 * zone). Returns FIRST-PASSAGE hours per df index (Infinity = never reached
 * within maxHours) — first-passage is monotonic in distance, so hourly
 * markers and site ETAs stay well-defined. Exported for unit tests.
 *
 *   vNetAt(s): net downstream velocity (m/s) at trace distance s (meters)
 *   uTideAt(hr): along-channel tidal velocity (+downstream) at sim-hour hr
 */
export function tidalFrontTimes(df, i0, entryHr, vNetAt, uTideAt, maxHours, dtS = 300) {
  const n = df.length;
  const times = new Array(n).fill(null);
  const sStart = i0 > 0 ? df[i0 - 1].cum_dist : 0;
  let s = sStart;
  let j = i0;
  const tEnd = maxHours * 3600;
  for (let t = entryHr * 3600; t <= tEnd && j < n; t += dtS) {
    const v = vNetAt(s) + uTideAt(t / 3600);
    s = Math.max(sStart, s + v * dtS);
    while (j < n && s >= df[j].cum_dist) { times[j] = (t + dtS) / 3600; j++; }
  }
  for (let k = i0; k < n; k++) if (times[k] === null) times[k] = Infinity;
  return times;
}

/**
 * Corridor-mode fetchTraceData: rows + virtual gauges from corridor docs.
 * Mirrors the US path's output shape exactly, so computeTrace is unchanged.
 */
async function fetchCorridorTraceData(lat, lon, corr, allCorridors, cfg, log) {
  const byId = new Map(allCorridors.map((c) => [c.id, c]));

  // 1. downstream chain, cycle-guarded
  const chain = [corr];
  const seen = new Set([corr.id]);
  let cur = corr;
  while (cur.continues_to && byId.has(cur.continues_to) && !seen.has(cur.continues_to)) {
    cur = byId.get(cur.continues_to);
    chain.push(cur);
    seen.add(cur.id);
  }

  // 2. assemble attributed points: click -> corridor end, then chained
  //    corridors from their join vertex, bridging gaps with connectors
  const { idx: startIdx, distM: snapDistM } = nearestCorridorVertex(lat, lon, corr);
  const pts = [];
  const corridorMeta = [];
  for (let ci = 0; ci < chain.length; ci++) {
    const c = chain[ci];
    let fromIdx;
    if (ci === 0) fromIdx = startIdx;
    else {
      const prev = pts[pts.length - 1];
      const { idx, distM } = nearestCorridorVertex(prev.lat, prev.lon, c);
      if (distM > cfg.corridorGapMaxM) {
        log(`  corridor chain stops: ${chain[ci - 1].id} -> ${c.id} gap ${(distM / 1000).toFixed(2)} km > max`);
        break;
      }
      // straight connector through the confluence gap, attributed with the
      // DOWNSTREAM corridor's hydraulics at the join (it is that river's water)
      if (distM > 30) {
        const joinKm = c.station_km[idx];
        const [jLon, jLat] = c.vertices[idx];
        const steps = Math.max(1, Math.ceil(distM / cfg.resolutionM));
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          pts.push(corridorPoint(c, prev.lon + (jLon - prev.lon) * t,
            prev.lat + (jLat - prev.lat) * t, joinKm, true));
        }
        log(`  connector: ${chain[ci - 1].id} -> ${c.id} (${Math.round(distM)} m, ${c.name} hydraulics)`);
      }
      fromIdx = idx;
    }
    const firstPt = pts.length;
    for (let i = fromIdx; i < c.vertices.length; i++) {
      pts.push(corridorPoint(c, c.vertices[i][0], c.vertices[i][1], c.station_km[i]));
    }
    corridorMeta.push({ id: c.id, name: c.name, from_km: c.station_km[fromIdx], first_pt: firstPt });
  }
  if (pts.length < 2) throw new Error("corridor trace too short");

  // downsample to cfg.resolutionM (corridor vertices are ~50 m)
  let sampled = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += haversineM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    if (acc >= cfg.resolutionM || i === pts.length - 1) { sampled.push(pts[i]); acc = 0; }
  }

  // 3. rows — same shape/derived fields as the US path
  const rows = sampled.map((p) => ({ ...p }));
  const n = rows.length;
  rows[0].distance = 0.0;
  for (let i = 1; i < n; i++) {
    rows[i].distance = haversineM(rows[i - 1].lat, rows[i - 1].lon, rows[i].lat, rows[i].lon);
  }
  let cum = 0.0;
  for (const r of rows) { cum += r.distance; r.cum_dist = cum; }
  for (const r of rows) {
    r.drainage_area_sqmi = r.drainage_area_km2 * 0.386102;
    r.formula_width = estimateGeometryPayton(r.drainage_area_sqmi)[0];
    r.braided = false;
    // authored corridor width is trusted: no GLOW cap, but keep the same
    // 51-pt trailing smoothing so breakpoint steps don't kink the velocity
    r.width_m = r.corridor_width_m;
    r.width_final_raw = r.corridor_width_m > 0 ? r.corridor_width_m : r.formula_width;
  }
  {
    const W = 51;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += rows[i].width_final_raw;
      if (i >= W) sum -= rows[i - W].width_final_raw;
      rows[i].width_final = sum / Math.min(i + 1, W);
    }
  }

  // 4. virtual gauges: entry + exit of each chained corridor, DA-ratio
  //    transferred from that corridor's flow reference. Feeds the standard
  //    DA-weighted interpolation — flow jumps land AT the confluence.
  const CFS_PER_M3S = Math.pow(3.281, 3);
  const gd = [];
  const corridorWarnings = [];
  const flowNotes = [];
  for (const meta of corridorMeta) {
    const c = byId.get(meta.id);
    const f = await corridorFlow(c, cfg.asOf, log);
    if (!f) {
      corridorWarnings.push(`${c.name}: no flow data available (gauge feed down, no fallback) — flow assumed from drainage area only.`);
      continue;
    }
    const daRefSqmi = f.daKm2 * 0.386102;
    const crows = rows.filter((r) => r.corridor_id === meta.id && r.ftype === "Corridor");
    if (!crows.length) continue;
    for (const at of [crows[0], crows[crows.length - 1]]) {
      const daSqmi = at.drainage_area_sqmi;
      if (!(daSqmi > 0) || !(daRefSqmi > 0)) continue;
      const q = f.qM3s * CFS_PER_M3S * (daSqmi / daRefSqmi);
      if (gd.some((g) => Math.abs(g.trace_dist - at.cum_dist) < 1)) continue;
      const [w, dep] = estimateGeometryPayton(daSqmi);
      gd.push({
        station_id: `${meta.id}:${f.source}`,
        name: `${c.name} (${f.note || f.source})`,
        lat: at.lat, lon: at.lon,
        discharge: q, drainage_area: daSqmi,
        q_source: f.source,
        area: w * dep, trace_dist: at.cum_dist,
      });
    }
    if (f.source !== "eccc-iv") {
      corridorWarnings.push(
        `${c.name}: flow is a HISTORICAL MONTHLY MEDIAN (${f.note || "archived record"}) — NOT live conditions.`);
    }
    flowNotes.push(`${c.name}: ${f.qM3s.toFixed(2)} m3/s at ref DA ${Math.round(f.daKm2)} km2 (${f.source})`);
    for (const wtext of c.warnings || []) {
      if (!corridorWarnings.includes(wtext)) corridorWarnings.push(wtext);
    }
  }
  gd.sort((a, b) => a.trace_dist - b.trace_dist);
  for (const g of gd) {
    log(`  corridor gauge ${g.station_id.padEnd(28)} ${String(Math.round(g.discharge)).padStart(9)} cfs @ ${(g.trace_dist / 1000).toFixed(1).padStart(6)} km (${g.q_source})`);
  }

  // 5. site/receptor features — identical to the US path
  const fetchSets = async (providers) => Promise.all(
    (providers || []).map(async (p) => ({
      buffer_m: p.buffer_m ?? 400,
      feats: await p.fetch(),
    })),
  );
  const [siteSets, receptorSets] = await Promise.all(
    [fetchSets(cfg.siteProviders), fetchSets(cfg.receptorProviders)],
  );

  const riverName = corridorMeta.map((m) => byId.get(m.id).name).join(" → ");
  log(`  corridor trace: ${riverName}, ${n} points, ${(rows[n - 1].cum_dist / 1000).toFixed(1)} km, ${gd.length} virtual gauges`);

  // 6. tidal series (v1.8) — first corridor in the chain with a tidal block.
  // Failure degrades to steady net-drift timing with the legacy warning.
  let tidal = null;
  const tidalCorr = corridorMeta.map((m) => byId.get(m.id)).find((c) => c.tidal && c.tidal.station_code);
  if (tidalCorr) {
    try {
      tidal = await fetchIwlsTidalSeries(tidalCorr.tidal, cfg.asOf || null, cfg.maxHours, log);
    } catch (e) {
      corridorWarnings.push(
        `Tide feed unavailable (${String(e).slice(0, 70)}) — tidal reach ETAs are NET-DRIFT ONLY; ` +
        `flood tides can stall or reverse transport, treat as bands of ± several hours.`);
      log(`  tidal fetch FAILED: ${e}`);
    }
  }

  return {
    lat, lon, comid: null, snapName: corr.name, snapDistM, riverName,
    rows, gd, siteSets, receptorSets, tidal,
    asOf: cfg.asOf || "live",
    fetchedAt: new Date().toISOString(),
    corridorWarnings,
    corridorMeta: {
      chain: corridorMeta.map((m) => ({ id: m.id, from_km: Math.round(m.from_km * 100) / 100 })),
      flow: flowNotes,
    },
  };
}

// ---------------------------------------------------------------- main model
//
// Split into two stages so the expensive part is cacheable:
//   fetchTraceData(lat, lon, config)  — ALL network I/O: trace geometry, VAAs,
//     width sampling, gauges + flows, site/receptor features. Safety factor,
//     max hours etc. do NOT affect this stage.
//   computeTrace(data, config)        — pure math: Q interp, Manning depth,
//     velocity x safety, impoundment, travel time, hourly markers, site ETAs.
//     Deterministic and re-runnable on the same data (fields are overwritten,
//     rows are never structurally mutated).
// runTrace() composes the two — identical behavior to the original.

export async function fetchTraceData(lat, lon, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const log = cfg.verbose ? (...a) => console.log(...a) : () => {};

  log(`fetchTraceData(${lat.toFixed(4)}, ${lon.toFixed(4)})  asOf=${cfg.asOf || "live"}`);

  // 0. corridor mode (v1.6): if the click lands on a configured corridor
  // (Canadian rivers — no NLDI/NHDPlus/NWIS coverage), run on corridor data.
  if (cfg.corridors && cfg.corridors.length) {
    const docs = await loadCorridors(cfg.corridors, log);
    let best = null;
    for (const c of docs) {
      const { distM } = nearestCorridorVertex(lat, lon, c);
      if (distM <= (c.snap_m || 500) && (!best || distM < best.distM)) best = { c, distM };
    }
    if (best) {
      log(`  corridor match: ${best.c.id} (${Math.round(best.distM)} m from centerline)`);
      return fetchCorridorTraceData(lat, lon, best.c, docs, cfg, log);
    }
  }

  // 1. trace geometry (one NLDI call) + VAA batch join
  const [comid, snapName, snapD] = await snapComid(lat, lon, cfg.minStreamOrder);
  log(`  COMID ${comid}` + (snapName ? ` (${snapName}, snapped ${(snapD / 1000).toFixed(2)} km)` : ""));
  const geoms = await nldiDmFlowlines(comid, cfg.maxDistanceKm);
  log(`  NLDI DM flowlines: ${geoms.size}`);
  const vaa = await vaaBatch([...geoms.keys()]);
  const [pts, riverName] = assembleTrace(lat, lon, geoms, vaa, cfg.resolutionM, log);
  if (pts.length < 2) throw new Error("trace too short");

  // per-point arrays (mirrors the DataFrame)
  const n = pts.length;
  const rows = pts.map((p) => ({ ...p }));
  rows[0].distance = 0.0;
  for (let i = 1; i < n; i++) {
    rows[i].distance = haversineM(rows[i - 1].lat, rows[i - 1].lon, rows[i].lat, rows[i].lon);
  }
  let cum = 0.0;
  for (const r of rows) { cum += r.distance; r.cum_dist = cum; }
  for (const r of rows) r.drainage_area_sqmi = r.drainage_area_km2 * 0.386102;

  // 2. widths: formula baseline, optional override provider, 2x cap, backward smoothing
  for (const r of rows) {
    r.formula_width = estimateGeometryPayton(r.drainage_area_sqmi)[0];
    r.width_m = 0.0;
  }
  // braided-reach flag: any NHDPlus divergence within ~1 km (10 rows) — GLOW widths
  // there measure total wetted width across bars, inflating A and killing velocity
  {
    const W = 10;
    for (let i = 0; i < n; i++) {
      let braided = false;
      for (let k = Math.max(0, i - W); k <= Math.min(n - 1, i + W); k++) {
        if (rows[k].divergence > 0) { braided = true; break; }
      }
      rows[i].braided = braided;
    }
    const nb = rows.filter((r) => r.braided).length;
    if (nb) log(`  braided flag: ${nb}/${n} trace points near channel divergences (GLOW override disabled there)`);
  }

  if (cfg.widthProvider) {
    // HR NHDPlusID != MR comid — sample spatially, in windows; never let the
    // override kill the run (degrade to formula widths).
    let mids = [];
    try {
      const STEP = cfg.widthWindowPoints;
      const pad = 0.03;
      for (let i0 = 0; i0 < n; i0 += STEP) {
        const win = rows.slice(i0, i0 + STEP);
        const env = {
          xmin: Math.min(...win.map((r) => r.lon)) - pad,
          ymin: Math.min(...win.map((r) => r.lat)) - pad,
          xmax: Math.max(...win.map((r) => r.lon)) + pad,
          ymax: Math.max(...win.map((r) => r.lat)) + pad,
        };
        const feats = await cfg.widthProvider(env); // [{lat, lon, width}]
        mids.push(...feats);
      }
    } catch (e) {
      log(`  WIDTH OVERRIDE FAILED (${String(e).slice(0, 80)}) - falling back to formula widths`);
      mids = [];
    }
    if (mids.length) {
      for (const r of rows) {
        if (r.braided) { r.width_m = 0.0; continue; } // formula width on braided reaches
        let bestD = Infinity, bestW = 0;
        for (const m of mids) {
          const d = haversineM(r.lat, r.lon, m.lat, m.lon);
          if (d < bestD) { bestD = d; bestW = m.width || 0; }
        }
        r.width_m = bestD <= cfg.widthSampleRadiusM ? bestW : 0.0;
      }
      const matched = rows.filter((r) => r.width_m > 0).length;
      log(`  GLOW spatial sample: ${mids.length} HR segments, widths matched at ${matched}/${n} trace points`);
    }
  }
  for (const r of rows) {
    r.width_final_raw =
      r.width_m > 0 && r.width_m <= r.formula_width * 2.0 ? r.width_m : r.formula_width;
  }
  // pandas rolling(window=51, min_periods=1).mean() — trailing window
  {
    const W = 51;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += rows[i].width_final_raw;
      if (i >= W) sum -= rows[i - W].width_final_raw;
      rows[i].width_final = sum / Math.min(i + 1, W);
    }
  }

  // 3. discharge inputs: NLDI downstream gauges -> NWIS Q (+DA), located on trace
  const gauges = await nldiGauges(comid, cfg.maxDistanceKm, "DM");
  // upstream-anchor candidates: nearest UM gauges (fixes the discontinuity when
  // the click is just below a gauge and DM navigation no longer sees it)
  let upCands = [];
  if (cfg.upstreamGaugeKm > 0) {
    try {
      const dmIds = new Set(gauges.map((g) => g.station_id));
      upCands = (await nldiGauges(comid, cfg.upstreamGaugeKm, "UM"))
        .filter((u) => !dmIds.has(u.station_id))
        .map((u) => ({ ...u, upstream_m: haversineM(lat, lon, u.lat, u.lon) }))
        .filter((u) => u.upstream_m <= cfg.upstreamGaugeKm * 1000)
        .sort((a, b) => a.upstream_m - b.upstream_m);
    } catch (e) {
      log(`  UM gauge lookup failed (${String(e).slice(0, 80)}) — no upstream anchor`);
    }
  }
  const allIds = [...new Set([...gauges, ...upCands].map((g) => g.station_id))];
  const ginfo = await gaugeInfo(allIds, cfg.asOf, cfg.gaugeStatFallback);
  const gd = [];
  for (const g of gauges) {
    const i = ginfo.get(g.station_id) || {};
    if (i.discharge === undefined || !i.drainage_area) continue;
    let bestD = Infinity, idx = 0;
    for (let k = 0; k < n; k++) {
      const d = haversineM(rows[k].lat, rows[k].lon, g.lat, g.lon);
      if (d < bestD) { bestD = d; idx = k; }
    }
    if (bestD > 5000) continue; // gauge not on our trace corridor
    const [w, dep] = estimateGeometryPayton(i.drainage_area);
    gd.push({
      ...g, discharge: i.discharge, drainage_area: i.drainage_area,
      q_source: i.q_source || "iv",
      area: w * dep, trace_dist: rows[idx].cum_dist,
    });
  }
  gd.sort((a, b) => a.trace_dist - b.trace_dist);
  // median-flow gauges are a rescue, not a supplement: with ANY live gauge on
  // the trace, live-only interpolation beats splicing a historical median into
  // the profile (median != today's flow in runoff or drought). They engage
  // only on a full feed outage or a pre-IV-era asOf date.
  if (gd.some((g) => g.q_source === "iv") && gd.some((g) => g.q_source === "stat-p50")) {
    const dropped = gd.filter((g) => g.q_source === "stat-p50").map((g) => g.station_id);
    log(`  median-fallback gauges suppressed (live gauges available): ${dropped.join(", ")}`);
    for (let i = gd.length - 1; i >= 0; i--) if (gd[i].q_source === "stat-p50") gd.splice(i, 1);
  }
  const spillDaSqmi = rows[0].drainage_area_sqmi;
  for (const u of upCands) {
    const i = ginfo.get(u.station_id) || {};
    if (i.discharge === undefined || !i.drainage_area) continue;
    // same rescue-only rule for the upstream anchor: no median anchors when
    // live gauges are on the trace
    if ((i.q_source || "iv") === "stat-p50" && gd.some((g) => g.q_source === "iv")) continue;
    if (mergeUpstreamAnchor(gd, { ...u, discharge: i.discharge, drainage_area: i.drainage_area, q_source: i.q_source || "iv" }, spillDaSqmi)) {
      log(
        `  upstream anchor ${u.station_id} ${u.name.slice(0, 30)}: ${Math.round(i.discharge)} cfs ` +
        `@ ${(u.upstream_m / 1000).toFixed(1)} km upstream -> ${Math.round(i.discharge * (spillDaSqmi / i.drainage_area))} cfs ` +
        `at spill point (DA x${(spillDaSqmi / i.drainage_area).toFixed(2)})`,
      );
      break;
    }
    // an on-trace gauge near the start already anchors the boundary — stop looking
    if (gd.some((g) => !g.upstream_anchor && g.trace_dist <= 500)) break;
  }
  for (const g of gd) {
    log(`  gauge ${g.station_id} ${g.name.slice(0, 38).padEnd(38)} ${String(Math.round(g.discharge)).padStart(8)} cfs @ ${(g.trace_dist / 1000).toFixed(1).padStart(6)} km${g.upstream_anchor ? " (upstream anchor)" : ""}${g.q_source === "stat-p50" ? " (MEDIAN fallback)" : ""}`);
  }

  // 4. site/receptor features (fetched in parallel; joined in computeTrace)
  const fetchSets = async (providers) => Promise.all(
    (providers || []).map(async (p) => ({
      buffer_m: p.buffer_m ?? 400,
      feats: await p.fetch(), // [{name, lat, lon, ...extra}]
    })),
  );
  const [siteSets, receptorSets] = await Promise.all(
    [fetchSets(cfg.siteProviders), fetchSets(cfg.receptorProviders)],
  );

  return {
    lat, lon, comid, snapName, snapDistM: snapD, riverName,
    rows, gd, siteSets, receptorSets,
    asOf: cfg.asOf || "live",
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- Jobson (USGS WRIR 96-4013)
//
// Dye-tracer regressions from ~980 subreaches / ~90 US rivers. Units: Da m^2,
// Q & Qa m^3/s, S dimensionless, velocities m/s. Eq 12/13 (with slope) or
// 14/15 (without). Leading edge Tl = 0.890 x Tp (eq 18). Passage: unit-peak
// concentration Cup = 857 x Tp^-0.760 x Q'a^-0.079 (Tp hours, eq 7), and
// Td10 = 2e6 / Cup seconds (eq 19) = leading edge -> 10%-of-peak trailing.
export function jobsonVelocities(daM2, Qm3s, QaM3s, slope) {
  if (!(daM2 > 0) || !(Qm3s > 0) || !(QaM3s > 0)) return null;
  const g = 9.8;
  const Dp = (Math.pow(daM2, 1.25) * Math.sqrt(g)) / QaM3s; // D'a, eq 10
  const Qp = Qm3s / QaM3s;                                   // Q'a, eq 11
  const qOverDa = Qm3s / daM2;
  let vp, vmp;
  if (slope > 0.00001) {
    const X = Math.pow(Dp, 0.919) * Math.pow(Qp, -0.469) * Math.pow(slope, 0.159) * qOverDa;
    vp = 0.094 + 0.0143 * X;   // eq 12
    vmp = 0.25 + 0.02 * X;     // eq 13 (99% envelope — fastest probable)
  } else {
    const X = Math.pow(Dp, 0.821) * Math.pow(Qp, -0.465) * qOverDa;
    vp = 0.020 + 0.051 * X;    // eq 14
    vmp = 0.2 + 0.093 * X;     // eq 15
  }
  return { vp, vmp, qPrime: Qp };
}

export function jobsonPassageHours(tpHours, qPrime) {
  // eq 7 + eq 19: duration from leading edge to 10%-of-peak trailing edge
  if (!(tpHours > 0) || !(qPrime > 0)) return null;
  const cup = 857 * Math.pow(tpHours, -0.760) * Math.pow(qPrime, -0.079); // s^-1
  return 2e6 / cup / 3600;
}

export function computeTrace(data, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const log = cfg.verbose ? (...a) => console.log(...a) : () => {};
  const { comid, riverName, rows, gd, siteSets, receptorSets } = data;
  const n = rows.length;

  // 5. discharge: interpolate along trace
  // month for EROM lookups: as_of month if pinned, else current
  const eromMonth = data.asOf && data.asOf !== "live"
    ? parseInt(data.asOf.slice(5, 7), 10)
    : new Date().getMonth() + 1;

  let qMethod, qConfidence;
  const anchored = gd.some((g) => g.upstream_anchor);
  let qInterpUsed = null;
  if (gd.length >= 2) {
    const daQ = cfg.qInterp === "drainage-area" ? daWeightedQ(gd) : null;
    if (daQ) {
      // interpolate on the running-max DA: ArtificialPath/divergence reaches can
      // carry 0/dipping totdasqkm, which must not crater Q mid-trace
      if (daQ.kept.length < gd.length)
        log(`  DA interp: dropped ${gd.length - daQ.kept.length} gauge(s) with non-monotonic NWIS DA`);
      let runMax = 0;
      for (const r of rows) {
        runMax = Math.max(runMax, r.drainage_area_sqmi);
        r.Q_cfs = Math.max(daQ.q(runMax), 1.0);
      }
      qMethod = anchored ? "gauge-DA-interpolation+upstream-anchor" : "gauge-DA-interpolation";
      qInterpUsed = "drainage-area";
    } else {
      if (cfg.qInterp === "drainage-area")
        log("  DA interp unavailable (<2 monotonic gauge DAs) — falling back to distance interpolation");
      const fQ = interpClamped(gd.map((g) => g.trace_dist), gd.map((g) => g.discharge));
      for (const r of rows) r.Q_cfs = Math.max(fQ(r.cum_dist), 1.0);
      qMethod = anchored ? "gauge-interpolation+upstream-anchor" : "gauge-interpolation";
      qInterpUsed = "distance";
    }
    qConfidence = "HIGH";
  } else if (gd.length === 1) {
    const g = gd[0];
    for (const r of rows) {
      r.Q_cfs = Math.max(g.discharge * (r.drainage_area_sqmi / g.drainage_area), 1.0);
    }
    qMethod = anchored ? "upstream-anchor-DA-ratio" : "single-gauge-DA-ratio";
    qConfidence = "MEDIUM";
    log("  1 gauge: scaling by drainage-area ratio");
  } else {
    // EROM per-reach monthly modeled flow (gauge-adjusted; captures seasonal
    // yield — Montana June vs September differs ~5x) before the flat constant
    const eromOk = rows.filter((r) => r.qe_monthly && r.qe_monthly[eromMonth] > 0).length;
    if (eromOk >= rows.length * 0.8) {
      for (const r of rows) {
        const qe = r.qe_monthly ? r.qe_monthly[eromMonth] : null;
        r.Q_cfs = Math.max(qe > 0 ? qe : r.drainage_area_sqmi * 2.0, 1.0);
      }
      qMethod = `erom-monthly (month ${eromMonth})`; qConfidence = "MODERATE — modeled flow, no live gauge";
      log(`  NO gauges: EROM monthly modeled flow (month ${eromMonth}, ${eromOk}/${rows.length} reaches)`);
    } else {
      for (const r of rows) r.Q_cfs = Math.max(r.drainage_area_sqmi * 2.0, 1.0);
      qMethod = "drainage-area-constant"; qConfidence = "LOW CONFIDENCE — NO GAUGE";
      log("  NO gauges, no EROM: Q ~ 2 cfs per sq mi drainage — LOW CONFIDENCE");
    }
  }

  // 4. Manning's depth per point (formula fallback), V = Q/A, safety factor.
  // Corridor rows may carry an authored depth_override (surveyed/charted
  // depth — e.g. tidal reaches where an energy slope is meaningless).
  const CFS_TO_M3S = Math.pow(3.281, 3);
  let ok = 0;
  for (const r of rows) {
    r.Q_m3s = r.Q_cfs / CFS_TO_M3S;
    const depthFormula = estimateGeometryPayton(r.drainage_area_sqmi)[1];
    if (r.depth_override > 0) { r.depth = r.depth_override; ok++; r.area = r.width_final * r.depth; r.velocity = (r.Q_m3s / r.area) * cfg.safetyFactor; continue; }
    const dm = calculateDepthManning(r.Q_m3s, r.width_final, r.slope, cfg.manningN);
    if (dm !== null && dm > 0.1 && dm < 20) { r.depth = dm; ok++; }
    else r.depth = depthFormula;
    r.area = r.width_final * r.depth;
    r.velocity = (r.Q_m3s / r.area) * cfg.safetyFactor;
  }
  log(`  Manning's depth: ${ok}/${n} points (${Math.round((100 * ok) / n)}%)`);

  // 5. impoundment rule: flowline passes through a LakePond/Reservoir waterbody
  // (minus known REMOVED dams whose waterbody flags linger in NHDPlus)
  const excluded = new Set([...REMOVED_IMPOUNDMENT_COMIDS, ...(cfg.impoundExcludeComids || [])]);
  let stopIdx = null, runM = 0.0;
  for (let i = 0; i < rows.length; i++) {
    const imp = (rows[i].wbareatype === "LakePond" || rows[i].wbareatype === "Reservoir") &&
      !excluded.has(rows[i].comid);
    rows[i].impounded = imp;
    if (imp) {
      runM += rows[i].distance;
      if (runM >= cfg.impoundStopKm * 1000) { stopIdx = i; break; }
    } else runM = 0.0;
  }
  let impoundNote = null;
  let df = rows;
  if (stopIdx !== null) {
    const name = rows[stopIdx].gnis_name || "impoundment";
    impoundNote =
      `Trace reaches an impounded reach (${name}) at ` +
      `${(rows[stopIdx].cum_dist / 1000).toFixed(1)} km — travel time beyond ` +
      `this point is NOT modeled (reservoir transit).`;
    df = rows.slice(0, stopIdx + 1);
    log(`  IMPOUNDMENT STOP: ${impoundNote}`);
  }

  // 6. travel time, cutoff, hourly markers
  const jobson = cfg.timingModel === "jobson";
  const CFS = Math.pow(3.281, 3);
  let cumT = 0.0, tPeak = 0.0, tFast = 0.0, jobsonDegraded = 0;
  for (const r of df) {
    r.seg_time = r.distance / r.velocity;
    cumT += r.seg_time;
    r.cum_time = cumT / 3600; // hydraulic (x safety) — always computed; feeds legacy mode
    if (jobson) {
      const daM2 = (r.drainage_area_km2 || 0) * 1e6;
      const QaM3s = r.qe_ma > 0 ? r.qe_ma / CFS : null;
      const jv = QaM3s ? jobsonVelocities(daM2, r.Q_m3s, QaM3s, r.slope) : null;
      let vp, vmp, qPrime;
      if (jv) { ({ vp, vmp, qPrime } = jv); }
      else { vp = r.velocity / cfg.safetyFactor; vmp = vp * 2; qPrime = 1; jobsonDegraded++; }
      tPeak += r.distance / vp;
      tFast += r.distance / vmp;
      r.t_peak = tPeak / 3600;
      r.t_lead = 0.890 * r.t_peak;              // eq 18 — most probable first arrival
      r.t_lead_min = 0.890 * (tFast / 3600);    // 99% envelope — earliest credible arrival
      const td10 = jobsonPassageHours(r.t_peak, qPrime);
      r.t_clear = td10 !== null ? r.t_lead + td10 : null; // 10%-of-peak trailing edge
    }
  }
  if (jobson && jobsonDegraded) log(`  Jobson: ${jobsonDegraded} points lacked EROM Qa (hydraulic fallback)`);
  const timeOf = (r) => (jobson ? r.t_lead : r.cum_time);

  // 6b. tidal corridor override (v1.8): rows flagged tidal get FIRST-PASSAGE
  // times from a 1-D oscillating front (net drift + predicted tide) instead of
  // steady integration. Net velocity comes from the steady time GRADIENT, so
  // it inherits safety-factor/Jobson semantics for either timing model.
  let tidalApplied = null;
  if (data.tidal && data.tidal.series.length) {
    const i0 = df.findIndex((r) => r.tidal);
    if (i0 !== -1 && df.length > 1) {
      const td = data.tidal;
      const gradVel = (tField) => {
        const dist = df.map((r) => r.cum_dist);
        const segV = new Array(df.length).fill(0.1);
        for (let i = 1; i < df.length; i++) {
          const dt = (df[i][tField] - df[i - 1][tField]) * 3600;
          segV[i] = dt > 0 ? df[i].distance / dt : segV[i - 1];
        }
        segV[0] = segV[1] ?? 0.1;
        return (s) => {
          if (s <= dist[0]) return segV[0];
          if (s >= dist[dist.length - 1]) return segV[segV.length - 1];
          let lo = 0, hi = dist.length - 1;
          while (hi - lo > 1) { const m = (lo + hi) >> 1; if (dist[m] <= s) lo = m; else hi = m; }
          return segV[lo + 1];
        };
      };
      const uAt = (shiftMin, scale) => (hr) => {
        const [u] = owWindAt(td.series, td.t0Ms + (hr * 60 + shiftMin) * 60e3);
        return u * scale;
      };
      const tMain = jobson ? "t_lead" : "cum_time";
      const entryHr = i0 > 0 ? df[i0 - 1][tMain] : 0;
      const times = tidalFrontTimes(df, i0, entryHr, gradVel(tMain), uAt(0, 1), cfg.maxHours);
      // earliest-credible envelope: tide phase advanced by the authored
      // uncertainty + 10% amplitude, entered at the fast river time
      const entryFastHr = i0 > 0 ? (jobson ? df[i0 - 1].t_lead_min : df[i0 - 1].cum_time) : 0;
      const vFast = jobson ? gradVel("t_lead_min") : gradVel("cum_time");
      const timesFast = tidalFrontTimes(df, i0, entryFastHr, vFast, uAt(td.phase_uncert_min, 1.1), cfg.maxHours);
      for (let k = i0; k < df.length; k++) {
        df[k].cum_time = times[k];
        if (jobson) {
          df[k].t_peak = times[k];
          df[k].t_lead = times[k];
          df[k].t_lead_min = Math.min(timesFast[k], times[k]);
          df[k].t_clear = null; // Jobson passage regressions don't apply to tidal reaches
        }
      }
      tidalApplied = {
        station_code: td.station_code, station_name: td.station_name,
        u_max_ms: td.u_max_ms, phase_lag_min: td.phase_lag_min,
        phase_uncert_min: td.phase_uncert_min, source: td.source,
        tide_points: td.series.length, entry_hr: Math.round(entryHr * 100) / 100,
        rows_tidal: df.length - i0,
      };
      log(`  TIDAL: front integration from row ${i0} (entry ${entryHr.toFixed(2)} h), ` +
        `${td.station_name} u_max ${td.u_max_ms} m/s`);
    }
  }

  // where + when the plume enters the impoundment — seeds the open-water
  // continuation (v1.7). Timing fields exist on rows[stopIdx] because df was
  // sliced from rows (shared references) before the time cutoff below.
  let impoundStopPoint = null;
  if (stopIdx !== null) {
    const sr = rows[stopIdx];
    const etaStop = timeOf(sr);
    if (etaStop !== undefined && etaStop < cfg.maxHours) {
      impoundStopPoint = {
        lat: sr.lat, lon: sr.lon,
        eta_hr: Math.round(etaStop * 100) / 100,
        name: sr.gnis_name || "impoundment",
      };
    }
  }
  df = df.filter((r) => timeOf(r) < cfg.maxHours);
  const maxCumTime = df.length ? timeOf(df[df.length - 1]) : 0;
  const nearestRow = (field, target) => {
    let bestD = Infinity, i = 0;
    for (let k = 0; k < df.length; k++) {
      const d = Math.abs(df[k][field] - target);
      if (d < bestD) { bestD = d; i = k; } // first occurrence of min (pandas idxmin)
    }
    return i;
  };
  const hourly = [];
  for (let hour = 1; hour <= cfg.maxHours; hour++) {
    if (maxCumTime < hour && Math.abs(maxCumTime - hour) > 0.5) break;
    const i = nearestRow(jobson ? "t_lead" : "cum_time", hour);
    const h = {
      hour,
      lat: df[i].lat, lon: df[i].lon,
      cum_dist_km: df[i].cum_dist / 1000,
      velocity_mph: df[i].velocity * 2.23694,
    };
    if (jobson) {
      // band at this hour: bulk (peak) position .. farthest credible (99% leading)
      const iPeak = nearestRow("t_peak", hour);
      const iFar = nearestRow("t_lead_min", hour);
      h.band = {
        peak: { i: iPeak, lat: df[iPeak].lat, lon: df[iPeak].lon, cum_dist_km: df[iPeak].cum_dist / 1000 },
        fastest: { i: iFar, lat: df[iFar].lat, lon: df[iFar].lon, cum_dist_km: df[iFar].cum_dist / 1000 },
      };
    }
    hourly.push(h);
  }

  // 7. site ETAs + receptor warnings (nearest trace point within buffer);
  // features were pre-fetched into data.siteSets/receptorSets
  function proximity(set) {
    const feats = set.feats; // [{name, lat, lon, ...extra}]
    const buf = set.buffer_m ?? 400;
    const out = [];
    for (const f of feats) {
      if (f.lat === undefined || f.lon === undefined) continue;
      let bestD = Infinity, i = 0;
      for (let k = 0; k < df.length; k++) {
        const d = haversineM(df[k].lat, df[k].lon, f.lat, f.lon);
        if (d < bestD) { bestD = d; i = k; }
      }
      if (bestD <= buf) {
        const { lat: _a, lon: _b, ...rest } = f;
        const row = {
          ...rest,
          eta_hr: Math.round(timeOf(df[i]) * 100) / 100,
          dist_km: Math.round((df[i].cum_dist / 1000) * 10) / 10,
          offset_m: Math.round(bestD),
          // modeled hydraulics at the site's trace point — feeds boom sizing
          river_width_m: Math.round(df[i].width_final * 10) / 10,
          velocity_ms: Math.round(df[i].velocity * 1000) / 1000,
          depth_m: Math.round(df[i].depth * 100) / 100,
        };
        if (jobson) {
          row.eta_early_hr = Math.round(df[i].t_lead_min * 100) / 100;
          row.eta_peak_hr = Math.round(df[i].t_peak * 100) / 100;
          row.clear_hr = df[i].t_clear !== null ? Math.round(df[i].t_clear * 100) / 100 : null;
        }
        out.push(row);
      }
    }
    out.sort((a, b) => a.eta_hr - b.eta_hr);
    return out;
  }

  const sites = [];
  for (const s of siteSets || []) sites.push(...proximity(s));
  sites.sort((a, b) => a.eta_hr - b.eta_hr);
  const warnings = impoundNote ? [impoundNote] : [];
  if (tidalApplied) {
    warnings.unshift(
      `Tidal reach MODELED with predicted tide at ${tidalApplied.station_name} ` +
      `(authored amplitude ${tidalApplied.u_max_ms} m/s): ETAs are FIRST ARRIVAL of an oscillating ` +
      `front — product re-crosses sites on later cycles; phase uncertainty ±${tidalApplied.phase_uncert_min} min.`);
  }
  // corridor mode: authored warnings (tidal reach, no-live-gauge, arm splits)
  // + downgrade confidence when any flow input is a historical median
  if (gd.some((g) => g.q_source === "monthly-median") && qConfidence === "HIGH") {
    qConfidence = "MODERATE — includes historical-median flow (no live gauge)";
  }
  for (const w of data.corridorWarnings || []) warnings.push(w);
  if (qConfidence !== "HIGH") warnings.unshift(`Flow estimate: ${qConfidence} (${qMethod})`);
  {
    const statG = gd.filter((g) => g.q_source === "stat-p50");
    if (statG.length) {
      warnings.unshift(
        `Gauge feed down: ${statG.map((g) => g.station_id).join(", ")} using ` +
        `period-of-record MEDIAN flow for this date — NOT live conditions`,
      );
    }
  }
  for (const s of receptorSets || []) {
    for (const r of proximity(s)) {
      warnings.push(
        `Receptor '${r.name}' ~${r.offset_m} m off trace at hr ${r.eta_hr} (${r.dist_km} km downstream)`,
      );
    }
  }

  const distanceKm = df.length ? df[df.length - 1].cum_dist / 1000 : 0;
  const avgVel = df.length ? df.reduce((s, r) => s + r.velocity, 0) / df.length : 0;
  const glowMatched = rows.filter((r) => r.width_m > 0).length;
  const braidedN = rows.filter((r) => r.braided).length;

  // provenance — enough to reconstruct any output in an after-action review
  const runRecord = {
    engine_version: ENGINE_VERSION,
    generated_at: new Date().toISOString(),
    data_fetched_at: data.fetchedAt || null,
    spill_point: { lat: data.lat, lon: data.lon },
    snap: { comid, river: riverName, snapped_from_m: data.snapDistM !== undefined ? Math.round(data.snapDistM || 0) : null },
    timing_model: cfg.timingModel,
    safety_factor: cfg.safetyFactor,
    max_hours: cfg.maxHours,
    as_of: data.asOf || "live",
    q_method: qMethod,
    q_confidence: qConfidence,
    q_interp: qInterpUsed,
    gauges: gd.map((g) => ({
      station_id: g.station_id, name: g.name, discharge_cfs: g.discharge, trace_km: Math.round(g.trace_dist / 100) / 10,
      q_source: g.q_source || "iv",
      ...(g.upstream_anchor ? {
        upstream_anchor: true,
        anchor_gauge_q_cfs: g.anchor_gauge_q_cfs,
        anchor_gauge_da_sqmi: g.anchor_gauge_da_sqmi,
        anchor_upstream_km: g.anchor_upstream_m !== null ? Math.round(g.anchor_upstream_m / 100) / 10 : null,
      } : {}),
    })),
    erom_month: qMethod.startsWith("erom") ? eromMonth : null,
    width_source: { glow_matched_points: glowMatched, total_points: rows.length, braided_points_formula_width: braidedN },
    jobson_degraded_points: jobson ? jobsonDegraded : null,
    impound_exclusions_applied: [...excluded].filter((c) => rows.some((r) => r.comid === c)),
    impound_stop_km: stopIdx !== null ? Math.round(rows[stopIdx].cum_dist / 100) / 10 : null,
    corridor: data.corridorMeta || null,
    tidal: tidalApplied,
  };

  const result = {
    mode: "river",
    river_name: riverName,
    comid,
    as_of: data.asOf || "live",
    safety_factor: cfg.safetyFactor,
    timing_model: cfg.timingModel,
    q_method: qMethod,
    q_confidence: qConfidence,
    gauges_used: gd.map((g) => ({
      station_id: g.station_id, name: g.name,
      discharge: g.discharge, trace_dist: g.trace_dist,
    })),
    distance_km_24h: distanceKm,
    avg_velocity_mph: avgVel * 2.23694,
    impound_stop: impoundNote,
    impound_stop_point: impoundStopPoint,
    hourly,
    sites,
    warnings,
    runRecord,
    trace: df, // full row array for inspection/geojson export
  };
  log(
    `  RESULT: ${distanceKm.toFixed(1)} km in <= ${cfg.maxHours} h, ` +
    `avg ${result.avg_velocity_mph.toFixed(2)} mph, ${sites.length} sites, ${warnings.length} warnings`,
  );
  return result;
}

/**
 * Which model does a click get? 'open-water' when the point sits inside a
 * lake/reservoir polygon (>= minLakeSqKm) — UNLESS a non-impounded reach is
 * nearby (dam tailraces sit inside reservoir polygons; that click means the
 * river below the dam). Returns { mode, waterbody? } — the waterbody is
 * passed on so the open-water fetch skips a duplicate PIP query.
 */
export async function resolveTraceMode(lat, lon, config = {}) {
  const ow = { ...DEFAULT_OPENWATER, ...(config.openWater || {}) };
  if (!ow.enabled) return { mode: "river" };
  const wb = await queryWaterbody(lat, lon, config);
  if (!wb || !isOpenWaterBody(wb) || !(wb.area_sqkm >= ow.minLakeSqKm)) return { mode: "river" };
  const cfg = { ...DEFAULT_CONFIG, ...config };
  try {
    if (await nearRiverReach(lat, lon, cfg.minStreamOrder, ow.riverOverrideM)) {
      return { mode: "river", waterbody: wb };
    }
  } catch { /* tiebreak unavailable → open water (the PIP hit stands) */ }
  return { mode: "open-water", waterbody: wb };
}

export async function runTrace(lat, lon, config = {}) {
  const ow = { ...DEFAULT_OPENWATER, ...(config.openWater || {}) };
  const disp = await resolveTraceMode(lat, lon, config);
  if (disp.mode === "open-water") return runOpenWater(lat, lon, config, disp.waterbody);
  const data = await fetchTraceData(lat, lon, config);
  const result = computeTrace(data, config);
  if (ow.enabled && ow.continueAtImpoundment && result.impound_stop_point) {
    try {
      result.open_water = await runOpenWaterContinuation(result, config);
    } catch (e) {
      result.warnings.push(`Open-water continuation unavailable: ${e.message || e}`);
    }
  }
  return result;
}

/**
 * Boom sizing from modeled hydraulics (planning-level, for GRPs that carry no
 * equipment quantities). Standard containment rule: oil entrains under a boom
 * when the flow component normal to it exceeds ~0.35 m/s (0.7 kt), so in
 * faster water the boom is angled with sin(theta) = entrainment/velocity and
 * the required length grows to width/sin(theta). Anchor sets from length.
 * Angles below ~15 deg (v > ~1.35 m/s) are flagged: use cascaded shorter booms.
 */
export function estimateBoomNeeds(widthM, velocityMs, opts = {}) {
  const entrain = opts.entrainmentMs ?? 0.35;
  const reservePct = opts.reservePct ?? 20;
  const anchorSpacingFt = opts.anchorSpacingFt ?? 100;
  if (!(widthM > 0) || !(velocityMs >= 0)) return null;
  const sinTheta = velocityMs > entrain ? entrain / velocityMs : 1;
  const angleDeg = (Math.asin(sinTheta) * 180) / Math.PI;
  const lengthFt = (widthM / sinTheta) * 3.28084 * (1 + reservePct / 100);
  const boomFt = Math.ceil(lengthFt / 50) * 50; // round up to 50-ft sticks
  const anchors = Math.max(2, Math.ceil(boomFt / anchorSpacingFt) + 1);
  return {
    boom_ft: boomFt,
    boom_angle_deg: Math.round(angleDeg),
    anchors,
    deflection: velocityMs > entrain,
    cascade_advised: angleDeg < 15, // too fast for a single sweep — cascade booms
  };
}

/** Trace line + hourly markers as a GeoJSON FeatureCollection (widget preview). */
export function toGeoJson(result) {
  const df = result.trace;
  const fc = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          kind: "trace", river: result.river_name,
          distance_km_24h: result.distance_km_24h,
        },
        geometry: {
          type: "LineString",
          coordinates: df.map((r) => [
            Math.round(r.lon * 1e6) / 1e6, Math.round(r.lat * 1e6) / 1e6,
          ]),
        },
      },
    ],
  };
  for (const h of result.hourly) {
    fc.features.push({
      type: "Feature",
      properties: { kind: "hour", hour: h.hour, cum_dist_km: h.cum_dist_km, velocity_mph: h.velocity_mph },
      geometry: {
        type: "Point",
        coordinates: [Math.round(h.lon * 1e6) / 1e6, Math.round(h.lat * 1e6) / 1e6],
      },
    });
  }
  if (result.open_water) {
    fc.features.push(...toOpenWaterGeoJson(result.open_water).features);
  }
  return fc;
}

// =========================================================================
// OPEN-WATER MODE (v1.7) — lakes & reservoirs
//
// GNOME-style Lagrangian particle transport (NOAA Tech Doc NOS OR&R 40,
// public domain; algorithms validated against its closed forms in
// openwater-spike/test_core.mjs — 18/18). Wind-drift only: for reservoirs
// with no operational current model this IS accepted responder practice
// (the "3% of wind toward the downwind shore" rule, done properly with an
// hourly forecast + minimum-regret uncertainty set).
//
// Gotchas honored (spike findings):
//   1. explicit windage persistence and GNOME's App. C sqrt(persist/dt)
//      range rescale DOUBLE-COUNT — rescale only when dt > persistence
//   2. NHD MapServer field names are UPPERCASE (GNIS_NAME, AREASQKM, FTYPE)
//   3. waterbody query needs maxAllowableOffset (~30 m) or Flathead-size
//      polygons return thousands of vertices; MultiPolygon rings flattened
//      (islands beach particles too)
//   4. refloatHalfLifeHr <= 0 would mean INSTANT refloat — treated as "off"
// =========================================================================

const NHD_WATERBODY_URL =
  "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/12/query";
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
const M_PER_DEG_LAT = 111120.00024; // GNOME Tech Doc §4

// NHD FType: 390 LakePond, 436 Reservoir, 493 Estuary, 445 SeaOcean (numeric
// on the MapServer; accept the string forms for robustness). Estuary/SeaOcean
// = coastal — the particle model adds a blended tidal-current field (Tier 3).
export function isOpenWaterBody(wb) {
  const f = wb && wb.ftype;
  return f === 390 || f === 436 || f === 493 || f === 445 ||
    f === "LakePond" || f === "Reservoir" || f === "Estuary" || f === "SeaOcean";
}
export function isCoastalBody(wb) {
  const f = wb && wb.ftype;
  return f === 493 || f === 445 || f === "Estuary" || f === "SeaOcean";
}

/**
 * Nearest flowline reach within radiusM (wbareatype included) — dispatch
 * tiebreak: NHD reservoir polygons extend over dam tailraces, and a click
 * there means the RIVER below, not the pool (caught live at American Falls:
 * the reservoir polygon contains the tailrace at 42.7803,-112.8767).
 */
async function nearRiverReach(lat, lon, minOrder, radiusM) {
  const box = radiusM / 111000; // degrees, generous at these latitudes
  const j = await getJson(GEOSERVER, {
    data: {
      service: "WFS", version: "2.0.0", request: "GetFeature",
      typeName: "wmadata:nhdflowline_network", outputFormat: "application/json",
      cql_filter:
        `streamorde >= ${minOrder} AND BBOX(the_geom,` +
        `${lat - box},${lon - box},${lat + box},${lon + box})`, // lat,lon axis order
      count: "50",
    },
  });
  // nearest NON-impounded reach: at a dam both the pool's LakePond reach and
  // the free-flowing reach below are close — any free-flowing reach in radius
  // means the click is river context (mid-pool has only the LakePond
  // ArtificialPath nearby). A tributary mouth flipping to river mode is fine:
  // the trace impound-stops into the lake immediately and continues as
  // open water anyway.
  let best = null, bestD = Infinity;
  for (const f of j.features || []) {
    const wba = f.properties.wbareatype;
    if (wba === "LakePond" || wba === "Reservoir") continue;
    const g = f.geometry;
    const paths = g.type === "LineString" ? [g.coordinates] : g.coordinates;
    for (const path of paths)
      for (const p of path) {
        const d = haversineM(lat, lon, p[1], p[0]);
        if (d < bestD) { bestD = d; best = f.properties; }
      }
  }
  if (best === null || bestD > radiusM) return null;
  return { dist_m: bestD, wbareatype: best.wbareatype ?? null, comid: Number(best.comid) };
}

/** Containing NHD waterbody at a point, or null. Geometry simplified to ~30 m. */
export async function queryWaterbody(lat, lon, config = {}) {
  const j = await getJson(NHD_WATERBODY_URL, {
    params: {
      geometry: `${lon},${lat}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "GNIS_NAME,AREASQKM,FTYPE", // UPPERCASE on this layer
      returnGeometry: "true",
      maxAllowableOffset: "0.0003",
      f: "geojson",
    },
  });
  const f = j.features && j.features[0];
  if (!f) return null;
  const rings = f.geometry.type === "Polygon"
    ? f.geometry.coordinates
    : f.geometry.coordinates.flat(1); // MultiPolygon → all rings incl. islands
  return {
    name: f.properties.GNIS_NAME || "unnamed waterbody",
    area_sqkm: f.properties.AREASQKM ?? null,
    ftype: f.properties.FTYPE,
    rings,
  };
}

// ---- CO-OPS tidal-current predictions (Tier 3 coastal) ----------------------

const COOPS_DATA_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
const COOPS_MDAPI_URL = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json";
let COOPS_CATALOG = null; // module cache — ~4,400 stations, fetched once per session

/**
 * Nearest CO-OPS current-prediction stations with their signed 6-min series
 * projected onto flood/ebb axes → [{id, name, lat, lon, dist_km,
 * series: [{t, u, v}] (m/s true-vector)}]. Tries nearest candidates until
 * `maxN` succeed (subordinate stations reject 6-min interval — skipped).
 */
export async function fetchCurrentStations(lat, lon, ow, hoursNeeded, startTMs, log) {
  if (!COOPS_CATALOG) {
    const j = await getJson(COOPS_MDAPI_URL, { params: { type: "currentpredictions", units: "metric" }, timeoutMs: 60000 });
    // the catalog lists one row per bin/depth — dedupe to one per station id
    const seen = new Set();
    COOPS_CATALOG = [];
    for (const s of j.stations || []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      COOPS_CATALOG.push({ id: s.id, name: s.name, lat: s.lat, lon: s.lng });
    }
  }
  const cands = COOPS_CATALOG
    .map((s) => ({ ...s, dist_m: haversineM(lat, lon, s.lat, s.lon) }))
    .filter((s) => s.dist_m <= ow.currentStationMaxKm * 1000)
    .sort((a, b) => a.dist_m - b.dist_m)
    .slice(0, ow.currentStationsMax * 3); // spare candidates for failures
  const beginMs = startTMs - 2 * 3600e3;
  const d = new Date(beginMs);
  const pad = (x) => String(x).padStart(2, "0");
  const begin = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  const range = Math.ceil(hoursNeeded + 8);
  const out = [];
  for (const c of cands) {
    if (out.length >= ow.currentStationsMax) break;
    try {
      const j = await getJson(COOPS_DATA_URL, {
        params: {
          station: c.id, product: "currents_predictions",
          begin_date: begin, range: String(range),
          time_zone: "gmt", interval: "6", units: "metric", format: "json",
        },
        tries: 1, timeoutMs: 30000,
      });
      const cp = j.current_predictions && j.current_predictions.cp;
      if (!Array.isArray(cp) || cp.length < 10) throw new Error("empty");
      const series = cp.map((r) => {
        const spd = Number(r.Velocity_Major) / 100; // cm/s (metric) → m/s, signed +flood/−ebb
        const dir = ((spd >= 0 ? Number(r.meanFloodDir) : Number(r.meanEbbDir)) * Math.PI) / 180;
        const mag = Math.abs(spd);
        return { t: Date.parse(r.Time.replace(" ", "T") + "Z"), u: mag * Math.sin(dir), v: mag * Math.cos(dir) };
      }).filter((x) => Number.isFinite(x.t) && Number.isFinite(x.u));
      if (series.length < 10) throw new Error("unparseable");
      out.push({ id: c.id, name: c.name, lat: c.lat, lon: c.lon, dist_km: Math.round(c.dist_m / 100) / 10, series });
      if (log) log(`  current station ${c.id} ${c.name} @ ${(c.dist_m / 1000).toFixed(1)} km — ${series.length} pts`);
    } catch (e) {
      if (log) log(`  current station ${c.id} skipped: ${String(e).slice(0, 60)}`);
    }
  }
  return out;
}

/** Hourly forecast wind at a point as [{t: ms, u, v}] (10 m, m/s). */
async function fetchWindSeries(lat, lon, hoursNeeded) {
  const days = Math.min(16, Math.ceil(hoursNeeded / 24) + 1);
  const j = await getJson(OPEN_METEO_URL, {
    params: {
      latitude: lat.toFixed(4), longitude: lon.toFixed(4),
      hourly: "wind_speed_10m,wind_direction_10m",
      wind_speed_unit: "ms", forecast_days: String(days), timezone: "UTC",
    },
  });
  const h = j.hourly;
  const series = h.time.map((t, i) => {
    const r = (h.wind_direction_10m[i] * Math.PI) / 180; // meteorological FROM
    const s = h.wind_speed_10m[i];
    return { t: Date.parse(t + ":00Z"), u: -s * Math.sin(r), v: -s * Math.cos(r) };
  });
  return { series, source: "open-meteo", points: series.length };
}

function owWindAt(series, tMs) {
  if (!series.length) return [0, 0];
  if (tMs <= series[0].t) return [series[0].u, series[0].v];
  const last = series[series.length - 1];
  if (tMs >= last.t) return [last.u, last.v];
  let lo = 0, hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= tMs) lo = mid; else hi = mid;
  }
  const A = series[lo], B = series[hi];
  const f = (tMs - A.t) / (B.t - A.t);
  return [A.u + f * (B.u - A.u), A.v + f * (B.v - A.v)];
}

// seeded RNG (mulberry32 + Box-Muller) — deterministic replays
function owMakeRng(seed) {
  let a = seed >>> 0;
  let spare = null;
  const next = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    uniform: (lo, hi) => lo + (hi - lo) * next(),
    gaussian() {
      if (spare !== null) { const v = spare; spare = null; return v; }
      let u1 = 0;
      while (u1 === 0) u1 = next();
      const u2 = next();
      const r = Math.sqrt(-2 * Math.log(u1));
      spare = r * Math.sin(2 * Math.PI * u2);
      return r * Math.cos(2 * Math.PI * u2);
    },
  };
}

function owProjection(lat0, lon0) {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return {
    toXY: (lat, lon) => [(lon - lon0) * mPerDegLon, (lat - lat0) * M_PER_DEG_LAT],
    toLatLon: (x, y) => [lat0 + y / M_PER_DEG_LAT, lon0 + x / mPerDegLon],
  };
}

function owSegIntersectT(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const denom = rx * sy - ry * sx;
  if (denom === 0) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/** Uniform grid over shoreline segments; segments remember ring + ordinal so
 *  beached particles can be clustered into contiguous shoreline arcs. */
function owShorelineIndex(ringsXY, cellM = 500) {
  const segs = [], segMeta = [];
  ringsXY.forEach((ring, ringIdx) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      segs.push([a[0], a[1], b[0], b[1]]);
      segMeta.push({ ring: ringIdx, ord: i });
    }
  });
  const cells = new Map();
  const key = (i, j) => i + "," + j;
  segs.forEach((s, idx) => {
    const i0 = Math.floor(Math.min(s[0], s[2]) / cellM), i1 = Math.floor(Math.max(s[0], s[2]) / cellM);
    const j0 = Math.floor(Math.min(s[1], s[3]) / cellM), j1 = Math.floor(Math.max(s[1], s[3]) / cellM);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const k = key(i, j);
        let arr = cells.get(k);
        if (!arr) { arr = []; cells.set(k, arr); }
        arr.push(idx);
      }
  });
  return { segs, segMeta, cells, cellM, key };
}

function owFirstCrossing(index, x1, y1, x2, y2) {
  const { segs, cells, cellM, key } = index;
  const i0 = Math.floor(Math.min(x1, x2) / cellM), i1 = Math.floor(Math.max(x1, x2) / cellM);
  const j0 = Math.floor(Math.min(y1, y2) / cellM), j1 = Math.floor(Math.max(y1, y2) / cellM);
  const seen = new Set();
  let best = null;
  for (let i = i0; i <= i1; i++)
    for (let j = j0; j <= j1; j++) {
      const arr = cells.get(key(i, j));
      if (!arr) continue;
      for (const idx of arr) {
        if (seen.has(idx)) continue;
        seen.add(idx);
        const s = segs[idx];
        const t = owSegIntersectT(x1, y1, x2, y2, s[0], s[1], s[2], s[3]);
        if (t !== null && (best === null || t < best.t)) best = { t, idx };
      }
    }
  if (best === null) return null;
  return {
    t: best.t, idx: best.idx,
    x: x1 + best.t * (x2 - x1), y: y1 + best.t * (y2 - y1),
  };
}

export function convexHull(pointsXY) {
  const pts = [...pointsXY].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** Protective/exclusion boom for a shoreline arc (open water — the river
 *  deflection rule sin(theta)=0.35/v does NOT apply with no persistent
 *  current). Planning-level: arc length + reserve, 50-ft sticks. */
export function estimateShorelineBoom(lengthM, opts = {}) {
  const reservePct = opts.reservePct ?? 20;
  const anchorSpacingFt = opts.anchorSpacingFt ?? 100;
  if (!(lengthM > 0)) return null;
  const boomFt = Math.ceil((lengthM * 3.28084 * (1 + reservePct / 100)) / 50) * 50;
  return { boom_ft: boomFt, anchors: Math.max(2, Math.ceil(boomFt / anchorSpacingFt) + 1), protective: true };
}

/** One particle set. Pure + deterministic (seeded). Internal.
 *  currentAt(x, y, tMs) → [u, v] m/s (optional — coastal tidal blend);
 *  currents advect at 100% (GNOME), windage rides on top. */
function owSimulate({ x0, y0, tMs0, windSeries, index, ow, uncertainty, seed, currentAt = null }) {
  const rng = owMakeRng(seed);
  const dt = ow.timestepS;
  const nSteps = Math.round((ow.durationHr * 3600) / dt);
  const stepsPerHour = Math.max(1, Math.round(3600 / dt));

  // windage: explicit persistence for dt <= persist (reference range as-is);
  // per-step draws with the App. C rescaled range only for dt > persist
  const wMean = (ow.windageMin + ow.windageMax) / 2;
  let wHalf = (ow.windageMax - ow.windageMin) / 2;
  let wPersistS = ow.windagePersistS;
  if (dt > wPersistS) {
    wHalf *= Math.sqrt(wPersistS / dt);
    wPersistS = dt;
  }
  const drawWindage = () => Math.max(0, wMean + rng.uniform(-wHalf, wHalf));
  const diffStep = Math.sqrt(6 * ow.diffusionM2s * dt);
  const angCap = Math.PI / 3; // ±60° cap on wind-angle perturbation (GNOME §15)
  const pRefloat = ow.refloatHalfLifeHr > 0
    ? 1 - Math.pow(2, -(dt / 3600) / ow.refloatHalfLifeHr)
    : 0; // <= 0 disables refloating (NOT "instant")

  const N = ow.nParticles;
  const P = new Array(N);
  for (let i = 0; i < N; i++) {
    P[i] = {
      x: x0, y: y0, beached: false, lastX: x0, lastY: y0,
      beachTMs: null, beachSeg: null,
      windage: drawWindage(), windageAgeS: 0,
      pertF: 1, pertA: 0, pertAgeS: 0,
      curF: 1, curA: 0,
    };
    if (uncertainty) drawPerturb(P[i]);
  }
  function drawPerturb(p) {
    p.pertF = Math.exp(rng.gaussian() * 0.3); // lognormal speed factor, median 1
    p.pertA = Math.max(-angCap, Math.min(angCap, (rng.gaussian() * 20 * Math.PI) / 180));
    p.pertAgeS = 0;
    // current perturbation (GNOME §15 spirit): ±20% scale + small rotation,
    // held for the run (currents re-randomize on the 48 h scale, > our runs)
    p.curF = Math.exp(rng.gaussian() * 0.2);
    p.curA = Math.max(-0.52, Math.min(0.52, (rng.gaussian() * 10 * Math.PI) / 180));
  }

  const hourly = [];
  const snapshot = (hr) => {
    const pos = new Array(N);
    let cx = 0, cy = 0, nb = 0;
    for (let i = 0; i < N; i++) {
      pos[i] = [P[i].x, P[i].y];
      cx += P[i].x; cy += P[i].y;
      if (P[i].beached) nb++;
    }
    hourly.push({ hr, centroidXY: [cx / N, cy / N], beachedCount: nb, positions: pos });
  };
  snapshot(0);

  for (let step = 1; step <= nSteps; step++) {
    const tMs = tMs0 + (step - 1) * dt * 1000; // forcing at interval start (forward Euler)
    const [wu0, wv0] = owWindAt(windSeries, tMs);
    for (let i = 0; i < N; i++) {
      const p = P[i];
      if (p.beached) {
        if (pRefloat > 0 && rng.next() < pRefloat) {
          p.beached = false; p.x = p.lastX; p.y = p.lastY;
        } else continue;
      }
      p.windageAgeS += dt;
      if (p.windageAgeS >= wPersistS) { p.windage = drawWindage(); p.windageAgeS = 0; }
      let wu = wu0, wv = wv0;
      if (uncertainty) {
        p.pertAgeS += dt;
        if (p.pertAgeS >= 10800) drawPerturb(p); // 3 h persistence
        const c = Math.cos(p.pertA), s = Math.sin(p.pertA);
        wu = p.pertF * (wu0 * c - wv0 * s);
        wv = p.pertF * (wu0 * s + wv0 * c);
      }
      let cu = 0, cv = 0;
      if (currentAt) {
        [cu, cv] = currentAt(p.x, p.y, tMs);
        if (uncertainty) {
          const cc = Math.cos(p.curA), cs = Math.sin(p.curA);
          const ru = p.curF * (cu * cc - cv * cs);
          cv = p.curF * (cu * cs + cv * cc);
          cu = ru;
        }
      }
      const nx = p.x + (cu + p.windage * wu) * dt + rng.uniform(-1, 1) * diffStep;
      const ny = p.y + (cv + p.windage * wv) * dt + rng.uniform(-1, 1) * diffStep;
      if (index) {
        const hit = owFirstCrossing(index, p.x, p.y, nx, ny);
        if (hit) {
          p.lastX = p.x; p.lastY = p.y; // last water position (GNOME §14)
          const len = Math.hypot(nx - p.x, ny - p.y) || 1;
          p.x = hit.x - (nx - p.x) / len; // land 1 m short of the crossing
          p.y = hit.y - (ny - p.y) / len;
          p.beached = true;
          p.beachSeg = hit.idx;
          if (p.beachTMs === null) p.beachTMs = tMs + dt * 1000;
          continue;
        }
      }
      p.x = nx; p.y = ny;
    }
    if (step % stepsPerHour === 0) snapshot(step / stepsPerHour);
  }
  return { particles: P, hourly };
}

/**
 * fetchOpenWaterData — all network for one open-water run. Waterbody may be
 * passed pre-fetched (runTrace dispatch already queried it).
 * startOffsetHr shifts the sim start into the forecast (impoundment
 * continuations start when the river plume ARRIVES, not now).
 */
export async function fetchOpenWaterData(lat, lon, config = {}, waterbody = null, startOffsetHr = 0) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const ow = { ...DEFAULT_OPENWATER, ...(config.openWater || {}) };
  const wb = waterbody || (await queryWaterbody(lat, lon, config));
  if (!wb) throw new Error("point is not inside an NHD waterbody");
  const startTMs = Date.now() + startOffsetHr * 3600000;
  const coastal = isCoastalBody(wb);
  const log = cfg.verbose ? (...a) => console.log(...a) : null;
  const windP = fetchWindSeries(lat, lon, startOffsetHr + ow.durationHr);
  // coastal: blended tidal-current field from the nearest prediction stations
  let stationsP = Promise.resolve([]);
  if (coastal && ow.coastalCurrents) {
    stationsP = fetchCurrentStations(lat, lon, ow, ow.durationHr, startTMs, log)
      .catch((e) => { if (log) log(`  current stations FAILED: ${e}`); return []; });
  }
  const fetchSets = async (providers) => Promise.all(
    (providers || []).map(async (p) => ({
      name: p.name, buffer_m: p.buffer_m ?? 400, feats: await p.fetch(),
    })),
  );
  const [wind, currentStations, siteSets, receptorSets] = await Promise.all(
    [windP, stationsP, fetchSets(cfg.siteProviders), fetchSets(cfg.receptorProviders)],
  );
  return {
    lat, lon, waterbody: wb, coastal,
    windSeries: wind.series, windSource: wind.source,
    currentStations,
    siteSets, receptorSets,
    startOffsetHr,
    startTMs,
    fetchedAt: new Date().toISOString(),
  };
}

/** Re-aim cached open-water data at a new start offset (safety-factor
 *  re-runs move the river ETA into the impoundment — wind + polygon are
 *  reusable, only the clock shifts). */
export function rebaseOpenWaterData(data, startOffsetHr) {
  return { ...data, startOffsetHr, startTMs: Date.now() + startOffsetHr * 3600000 };
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/** computeOpenWater — pure given data + config (seeded RNG in runRecord). */
export function computeOpenWater(data, config = {}) {
  const ow = { ...DEFAULT_OPENWATER, ...(config.openWater || {}) };
  // coastal water is more energetic — bump the diffusion default unless the
  // config explicitly set one
  if (data.coastal && (config.openWater?.diffusionM2s === undefined)) {
    ow.diffusionM2s = ow.coastalDiffusionM2s;
  }
  const log = (m) => ({ ...DEFAULT_CONFIG, ...config }).verbose && console.log(m);
  const t0 = Date.now();
  const proj = owProjection(data.lat, data.lon);
  const ringsXY = data.waterbody.rings.map((r) => r.map(([lo, la]) => proj.toXY(la, lo)));
  const index = owShorelineIndex(ringsXY);

  // coastal tidal-current field: inverse-distance-squared blend of the
  // station vectors (100 m floor keeps a click on top of a station finite)
  let currentAt = null;
  if (data.currentStations && data.currentStations.length) {
    const sts = data.currentStations.map((s) => {
      const [sx, sy] = proj.toXY(s.lat, s.lon);
      return { sx, sy, series: s.series };
    });
    currentAt = (x, y, tMs) => {
      let wu = 0, wv = 0, wsum = 0;
      for (const s of sts) {
        const dx = x - s.sx, dy = y - s.sy;
        const w = 1 / Math.max(dx * dx + dy * dy, 1e4);
        const [u, v] = owWindAt(s.series, tMs);
        wu += w * u; wv += w * v; wsum += w;
      }
      return [wu / wsum, wv / wsum];
    };
  }

  const simArgs = {
    x0: 0, y0: 0, tMs0: data.startTMs, windSeries: data.windSeries, index, ow, currentAt,
  };
  const best = owSimulate({ ...simArgs, uncertainty: false, seed: ow.seed });
  const regret = owSimulate({ ...simArgs, uncertainty: true, seed: ow.seed + 1 });

  const toLatLonRing = (hullXY) =>
    hullXY.length >= 3 ? [...hullXY, hullXY[0]].map(([x, y]) => {
      const [la, lo] = proj.toLatLon(x, y);
      return [Math.round(lo * 1e6) / 1e6, Math.round(la * 1e6) / 1e6];
    }) : null;

  const hourly = best.hourly.filter((h) => h.hr > 0).map((h) => {
    const [cla, clo] = proj.toLatLon(...h.centroidXY);
    return {
      hour: h.hr,
      abs_hr: Math.round((data.startOffsetHr + h.hr) * 100) / 100,
      centroid: { lat: Math.round(cla * 1e6) / 1e6, lon: Math.round(clo * 1e6) / 1e6 },
      hull: toLatLonRing(convexHull(h.positions)),
      beached_count: h.beachedCount,
    };
  });
  const uncertaintyHourly = regret.hourly.filter((h) => h.hr > 0).map((h) => ({
    hour: h.hr, hull: toLatLonRing(convexHull(h.positions)),
  }));

  // shoreline impacts: cluster beached particles into contiguous shore arcs
  const { segMeta } = index;
  const byRing = new Map();
  for (const p of best.particles) {
    if (p.beachSeg === null) continue;
    const m = segMeta[p.beachSeg];
    let arr = byRing.get(m.ring);
    if (!arr) { arr = []; byRing.set(m.ring, arr); }
    arr.push({ ord: m.ord, hr: (p.beachTMs - data.startTMs) / 3600000 });
  }
  const impacts = [];
  for (const [ringIdx, hits] of byRing) {
    hits.sort((a, b) => a.ord - b.ord);
    const ring = data.waterbody.rings[ringIdx];
    let cl = null;
    const flush = () => { if (cl) { impacts.push(cl); cl = null; } };
    for (const h of hits) {
      if (cl && h.ord - cl.maxOrd <= ow.shoreGapSegs) {
        cl.maxOrd = Math.max(cl.maxOrd, h.ord);
        cl.hrs.push(h.hr);
      } else {
        flush();
        cl = { ring: ringIdx, minOrd: h.ord, maxOrd: h.ord, hrs: [h.hr] };
      }
    }
    flush();
    // NOTE: a cluster wrapping a ring's index origin splits in two — cosmetic
    for (const c of impacts.filter((c) => c.ring === ringIdx && !c.line)) {
      const pts = [];
      for (let i = c.minOrd; i <= Math.min(c.maxOrd + 1, ring.length - 1); i++) pts.push(ring[i]);
      if (pts.length < 2) pts.push(ring[Math.min(c.maxOrd, ring.length - 1)]);
      let lenM = 0;
      for (let i = 1; i < pts.length; i++) lenM += haversineM(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]);
      c.hrs.sort((a, b) => a - b);
      const mid = pts[(pts.length / 2) | 0];
      c.line = pts.map(([lo, la]) => [Math.round(lo * 1e6) / 1e6, Math.round(la * 1e6) / 1e6]);
      c.out = {
        count: c.hrs.length,
        share_pct: Math.round((1000 * c.hrs.length) / ow.nParticles) / 10,
        first_hr: Math.round(c.hrs[0] * 10) / 10,
        first_abs_hr: Math.round((data.startOffsetHr + c.hrs[0]) * 10) / 10,
        median_hr: Math.round(c.hrs[(c.hrs.length / 2) | 0] * 10) / 10,
        length_m: Math.round(lenM),
        center: { lat: mid[1], lon: mid[0] },
        line: c.line,
        boom: estimateShorelineBoom(lenM),
      };
    }
  }
  const shoreImpacts = impacts.map((c) => c.out)
    .sort((a, b) => b.count - a.count)
    .slice(0, ow.maxShoreImpacts)
    .sort((a, b) => a.first_hr - b.first_hr);

  // site ETAs: first hour any best-guess particle comes within the buffer
  const sites = [];
  for (const set of data.siteSets || []) {
    const buf = set.buffer_m ?? 400;
    for (const f of set.feats || []) {
      if (f.lat === undefined || f.lon === undefined) continue;
      const [fx, fy] = proj.toXY(f.lat, f.lon);
      let eta = null, offset = null;
      for (const h of best.hourly) {
        if (h.hr === 0) continue;
        let dmin = Infinity;
        for (const [x, y] of h.positions) {
          const d = Math.hypot(x - fx, y - fy);
          if (d < dmin) dmin = d;
        }
        if (dmin <= buf) { eta = h.hr; offset = Math.round(dmin); break; }
      }
      if (eta !== null) {
        const { lat: _a, lon: _b, ...rest } = f;
        sites.push({
          ...rest,
          eta_hr: Math.round((data.startOffsetHr + eta) * 100) / 100,
          offset_m: offset,
          open_water: true,
        });
      }
    }
  }
  sites.sort((a, b) => a.eta_hr - b.eta_hr);

  // downwind headline from the first-12h mean wind + earliest arrivals
  const warnings = [];
  let headline = null;
  {
    let su = 0, sv = 0, n = 0;
    for (let hr = 0; hr < 12; hr++) {
      const [u, v] = owWindAt(data.windSeries, data.startTMs + hr * 3600000);
      su += u; sv += v; n++;
    }
    const spd = Math.hypot(su / n, sv / n);
    const towardDeg = (Math.atan2(su / n, sv / n) * 180) / Math.PI;
    const bestFirst = shoreImpacts.length ? shoreImpacts[0] : null;
    const regretTimes = regret.particles.filter((p) => p.beachTMs !== null)
      .map((p) => (p.beachTMs - data.startTMs) / 3600000).sort((a, b) => a - b);
    const early = regretTimes.length ? Math.round(regretTimes[0] * 10) / 10 : null;
    const curNote = currentAt
      ? ` + tidal currents (${data.currentStations.length} station${data.currentStations.length > 1 ? "s" : ""})`
      : "";
    headline =
      `Wind ${spd.toFixed(1)} m/s → drifting ${compass(towardDeg)}${curNote}` +
      (bestFirst
        ? `; first shoreline arrival ~${early !== null && early < bestFirst.first_hr ? early + "–" : ""}${bestFirst.first_hr} h`
        : `; no shoreline arrival within ${ow.durationHr} h (best guess)`);
    if (spd < 1.5 && !currentAt) warnings.push(
      "Light/variable wind — drift direction is LOW CONFIDENCE; treat the uncertainty envelope as the planning footprint.");
  }
  if (data.coastal && !currentAt) {
    warnings.unshift(
      `No CO-OPS current-prediction station within range — COASTAL drift is wind-only here; ` +
      `tidal transport is NOT modeled and can dominate. Treat with caution.`);
  }
  if (currentAt) {
    warnings.push(
      `Tidal currents blended from ${data.currentStations.map((s) => s.id).join(", ")} ` +
      `(nearest ${data.currentStations[0].dist_km} km) — station-axis predictions, not a circulation model; ` +
      `accuracy degrades away from the stations.`);
  }
  warnings.push(
    "Open-water model: surface transport only (GNOME-class physics) — no weathering; ETAs depend on the wind forecast" +
    (currentAt ? " and predicted tidal currents." : "; lake-circulation currents are not modeled."));

  const result = {
    mode: "open-water",
    coastal: !!data.coastal,
    waterbody: { name: data.waterbody.name, area_sqkm: data.waterbody.area_sqkm, ftype: data.waterbody.ftype },
    spill_point: { lat: data.lat, lon: data.lon },
    start_offset_hr: data.startOffsetHr,
    duration_hr: ow.durationHr,
    headline,
    hourly,
    uncertainty_hourly: uncertaintyHourly,
    shore_impacts: shoreImpacts,
    sites,
    warnings,
    stats: {
      n_particles: ow.nParticles,
      beached_final: best.particles.filter((p) => p.beached).length,
      ever_beached: best.particles.filter((p) => p.beachTMs !== null).length,
      compute_ms: Date.now() - t0,
    },
    runRecord: {
      engine_version: ENGINE_VERSION,
      mode: "open-water",
      generated_at: new Date().toISOString(),
      data_fetched_at: data.fetchedAt,
      spill_point: { lat: data.lat, lon: data.lon },
      waterbody: { name: data.waterbody.name, area_sqkm: data.waterbody.area_sqkm, ftype: data.waterbody.ftype, rings: data.waterbody.rings.length },
      wind_source: data.windSource,
      wind_points: data.windSeries.length,
      coastal: !!data.coastal,
      current_stations: (data.currentStations || []).map((s) => ({ id: s.id, name: s.name, dist_km: s.dist_km })),
      start_offset_hr: data.startOffsetHr,
      seed: ow.seed,
      params: {
        n_particles: ow.nParticles, duration_hr: ow.durationHr, timestep_s: ow.timestepS,
        windage: [ow.windageMin, ow.windageMax], diffusion_m2s: ow.diffusionM2s,
        refloat_half_life_hr: ow.refloatHalfLifeHr,
      },
      shoreline_segments: index.segs.length,
    },
  };
  log(`  OPEN WATER: ${data.waterbody.name} — ${result.stats.ever_beached}/${ow.nParticles} beached, ` +
    `${shoreImpacts.length} shore impacts, ${sites.length} sites, ${result.stats.compute_ms} ms`);
  return result;
}

export async function runOpenWater(lat, lon, config = {}, waterbody = null) {
  const data = await fetchOpenWaterData(lat, lon, config, waterbody);
  return computeOpenWater(data, config);
}

/** River trace ended at an impoundment → continue as open water from the
 *  entry point, clock offset by the river ETA. */
export async function runOpenWaterContinuation(riverResult, config = {}) {
  const sp = riverResult.impound_stop_point;
  if (!sp) return null;
  const data = await fetchOpenWaterData(sp.lat, sp.lon, config, null, sp.eta_hr);
  const owRes = computeOpenWater(data, config);
  owRes.continuation_of = {
    river: riverResult.river_name,
    entered: sp.name,
    river_eta_hr: sp.eta_hr,
  };
  owRes.warnings.unshift(
    `Continuation: river plume enters ${sp.name} at ~${sp.eta_hr} h; open-water hours below are ABSOLUTE from the spill (abs_hr).`);
  return owRes;
}

/** Open-water result as GeoJSON (hulls, centroid track, shore impacts). */
export function toOpenWaterGeoJson(ow) {
  const features = [{
    type: "Feature",
    properties: { kind: "ow_spill_point", waterbody: ow.waterbody.name, headline: ow.headline },
    geometry: { type: "Point", coordinates: [ow.spill_point.lon, ow.spill_point.lat] },
  }];
  features.push({
    type: "Feature",
    properties: { kind: "ow_centroid_track" },
    geometry: { type: "LineString", coordinates: ow.hourly.map((h) => [h.centroid.lon, h.centroid.lat]) },
  });
  for (const h of ow.hourly) {
    if (h.hull) features.push({
      type: "Feature",
      properties: { kind: "ow_hull", hour: h.hour, abs_hr: h.abs_hr, beached_count: h.beached_count },
      geometry: { type: "Polygon", coordinates: [h.hull] },
    });
  }
  for (const h of ow.uncertainty_hourly) {
    if (h.hull) features.push({
      type: "Feature",
      properties: { kind: "ow_uncertainty_hull", hour: h.hour },
      geometry: { type: "Polygon", coordinates: [h.hull] },
    });
  }
  for (const s of ow.shore_impacts) {
    features.push({
      type: "Feature",
      properties: {
        kind: "ow_shore_impact", first_hr: s.first_hr, median_hr: s.median_hr,
        share_pct: s.share_pct, length_m: s.length_m, boom_ft: s.boom ? s.boom.boom_ft : null,
      },
      geometry: { type: "LineString", coordinates: s.line },
    });
  }
  return { type: "FeatureCollection", features };
}
