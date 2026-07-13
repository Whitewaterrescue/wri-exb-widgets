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
 */

export const ENGINE_VERSION = "1.3.0";

const NLDI_BASE = "https://api.water.usgs.gov/nldi";
const GEOSERVER = "https://api.water.usgs.gov/geoserver/wmadata/ows";
const NWIS_IV = "https://waterservices.usgs.gov/nwis/iv/";
const NWIS_SITE = "https://waterservices.usgs.gov/nwis/site/";

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
  impoundStopKm: 2.0,
  impoundExcludeComids: [],   // extra removed-dam comids beyond REMOVED_IMPOUNDMENT_COMIDS
  timingModel: "hydraulic",   // 'hydraulic' (V=Q/A x safety) | 'jobson' (USGS WRIR 96-4013 dye-study regressions)
  asOf: null,                 // 'YYYY-MM-DD' historical Q; null = live
  verbose: true,
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

/** Discharge (cfs) + drainage area (sq mi) per gauge via plain NWIS REST. */
async function gaugeInfo(stationIds, asOf = null) {
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
      }
    }
  } catch { /* ignore — matches Python */ }
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
  const ginfo = await gaugeInfo(allIds, cfg.asOf);
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
      area: w * dep, trace_dist: rows[idx].cum_dist,
    });
  }
  gd.sort((a, b) => a.trace_dist - b.trace_dist);
  const spillDaSqmi = rows[0].drainage_area_sqmi;
  for (const u of upCands) {
    const i = ginfo.get(u.station_id) || {};
    if (i.discharge === undefined || !i.drainage_area) continue;
    if (mergeUpstreamAnchor(gd, { ...u, discharge: i.discharge, drainage_area: i.drainage_area }, spillDaSqmi)) {
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
    log(`  gauge ${g.station_id} ${g.name.slice(0, 38).padEnd(38)} ${String(Math.round(g.discharge)).padStart(8)} cfs @ ${(g.trace_dist / 1000).toFixed(1).padStart(6)} km${g.upstream_anchor ? " (upstream anchor)" : ""}`);
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
  if (gd.length >= 2) {
    const fQ = interpClamped(gd.map((g) => g.trace_dist), gd.map((g) => g.discharge));
    for (const r of rows) r.Q_cfs = Math.max(fQ(r.cum_dist), 1.0);
    qMethod = anchored ? "gauge-interpolation+upstream-anchor" : "gauge-interpolation";
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

  // 4. Manning's depth per point (formula fallback), V = Q/A, safety factor
  const CFS_TO_M3S = Math.pow(3.281, 3);
  let ok = 0;
  for (const r of rows) {
    r.Q_m3s = r.Q_cfs / CFS_TO_M3S;
    const depthFormula = estimateGeometryPayton(r.drainage_area_sqmi)[1];
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
  if (qConfidence !== "HIGH") warnings.unshift(`Flow estimate: ${qConfidence} (${qMethod})`);
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
    gauges: gd.map((g) => ({
      station_id: g.station_id, name: g.name, discharge_cfs: g.discharge, trace_km: Math.round(g.trace_dist / 100) / 10,
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
  };

  const result = {
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

export async function runTrace(lat, lon, config = {}) {
  const data = await fetchTraceData(lat, lon, config);
  return computeTrace(data, config);
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
  return fc;
}
