/**
 * waterEngine.js - Lawnly Water Balance Engine v9.0-pure
 *
 * PRINCIPIO: funzione pura, stateless, idempotente.
 *   theta_oggi = f(storia_meteo_60gg, suolo, irrigazioni_loggate, misura_opzionale)
 * Ricalcola SEMPRE da zero. Nessun "stored theta" avanzato a ogni reload.
 * Stesso input -> stesso output, sempre.
 *
 * FISICA: FAO-56 dual-coefficient, two-layer (0-10cm surface / 10-30cm root).
 * Preserva v8.3 (uptake bistrato), v8.4 (self-mulching + eta), v8.5 (warm-start continuo),
 * v8.1 (dewfall + sun engine).
 *
 * ELIMINATO: stored-recent/aged/stale, persist-and-readvance, soft-floor preroll,
 * gap-window re-step, offset structural/seasonal/adaptive, pseudo-falda.
 */

'use strict';

// =======================================================================
// 1. COSTANTI
// =======================================================================

const MODEL_VERSION = 'vwc-unified-v9.0-pure';
const SURF_DEPTH    = 0.10;   // 0-10cm evaporative layer [m]

const WATER_SOIL_PHYSICS = {
  sandy: { fc:0.20, wp:0.08, sat:0.35, drainRate:0.60, capillarity:0.20, eta:0.85, Zr:0.25 },
  loam:  { fc:0.32, wp:0.14, sat:0.45, drainRate:0.30, capillarity:0.50, eta:0.75, Zr:0.30 },
  clay:  { fc:0.40, wp:0.20, sat:0.50, drainRate:0.10, capillarity:0.70, eta:0.70, Zr:0.30 },
};

// Uptake traspirativo bistrato (v8.3)
const UPTAKE_SURF_FRAC = 0.60;   // 60% dai primi 10cm
const UPTAKE_ROOT_FRAC = 0.40;   // 40% dai 10-30cm

const KE_FLOOR = 0.01;
const KCMAX    = 1.20;

// Dewfall (FAO-56 par.6.5)
const DEW_RH_MIN  = 85;    // % RH minima per rugiada
const DEW_WIND_MAX = 14;   // m/s max
const DEW_CAP     = 2.5;   // mm/notte

// Kcb mensile (indice 0 = gennaio)
const KCB_TABLE = {
  microterme: [0.65,0.68,0.78,0.88,0.90,0.85,0.76,0.76,0.85,0.90,0.80,0.65],
  macroterme: [0.30,0.32,0.48,0.72,0.90,1.00,1.00,0.95,0.80,0.58,0.38,0.30],
};

// =======================================================================
// 2. UTILITY
// =======================================================================

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function getDOY(date) {
  return Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
}

function getField(day) {
  // usage: getField(day, 'a','b','c') -> first non-null numeric field
  for (let i = 1; i < arguments.length; i++) {
    const k = arguments[i];
    if (day[k] != null && !isNaN(day[k])) return +day[k];
  }
  return null;
}

// =======================================================================
// 3. PARAMETRI SUOLO DERIVATI
// =======================================================================

function buildSoilParams(soilType) {
  const sp       = WATER_SOIL_PHYSICS[soilType] || WATER_SOIL_PHYSICS.loam;
  const rootDepth = sp.Zr - SURF_DEPTH;   // m (loam: 0.20)
  const range    = sp.fc - sp.wp;

  return Object.assign({}, sp, {
    rootDepth,
    TAW_surf: range * SURF_DEPTH  * 1000,
    TAW_root: range * rootDepth   * 1000,
    RAW_surf: 0.5 * range * SURF_DEPTH  * 1000,
    RAW_root: 0.5 * range * rootDepth   * 1000,
    thetaAtRAW_surf: sp.fc - 0.5 * range,
    thetaAtRAW_root: sp.fc - 0.5 * range,
    wpFloor:   sp.wp + 0.05 * range,   // floor agronomico root
    wpSurface: sp.wp * 0.60,           // floor superficie
  });
}

// =======================================================================
// 4. FISICA CORE
// =======================================================================

function computeKs(theta, sp, thetaAtRAW) {
  if (theta >= thetaAtRAW) return 1.0;
  if (theta <= sp.wp)      return 0.0;
  return (theta - sp.wp) / (thetaAtRAW - sp.wp);
}

function computeKr(thetaSurf, sp) {
  const TEW = (sp.fc - 0.5 * sp.wp) * SURF_DEPTH * 1000;
  const We  = clamp((thetaSurf - sp.wp * 0.5) * SURF_DEPTH * 1000, 0, TEW);
  return We / Math.max(TEW, 0.001);
}

function computeKe(kr, kcb) {
  return Math.max(KE_FLOOR * KCMAX, kr * Math.max(0, KCMAX - kcb));
}

function computeDewfall(day) {
  const rh   = getField(day, 'rhmax', 'relative_humidity_2m_max') || 0;
  const wind = getField(day, 'wind_speed_max', 'windspeed_10m_max') || 0;
  if (rh < DEW_RH_MIN || wind > DEW_WIND_MAX) return 0;
  return clamp(0.40 + 1.60 * (rh - DEW_RH_MIN) / 15, 0, DEW_CAP);
}

function computeRa(lat, doy) {
  var phi   = lat * Math.PI / 180;
  var dr    = 1 + 0.033 * Math.cos(2 * Math.PI * doy / 365);
  var delta = 0.409 * Math.sin(2 * Math.PI * doy / 365 - 1.39);
  var ws    = Math.acos(clamp(-Math.tan(phi) * Math.tan(delta), -1, 1));
  var Gsc   = 0.0820;
  return (24*60/Math.PI) * Gsc * dr *
    (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws));
}

function hargreavesSamani(tmax, tmin, ra) {
  var tmean = (tmax + tmin) / 2;
  var td    = Math.max(0, tmax - tmin);
  return clamp(0.0023 * (tmean + 17.8) * Math.sqrt(td) * ra / 2.45, 0, 15);
}

function extractETo(day, lat) {
  var eto = getField(day, 'et0_fao_evapotranspiration', 'et0', 'eto', 'evapotranspiration');
  if (eto != null && eto > 0) return eto;
  var tmax = getField(day, 'temperature_2m_max', 'tmax');
  var tmin = getField(day, 'temperature_2m_min', 'tmin');
  if (tmax != null && tmin != null) {
    var date = new Date(day.date || Date.now());
    return hargreavesSamani(tmax, tmin, computeRa(lat, getDOY(date)));
  }
  return 2.0;
}

function getKcb(grassType, month) {
  var table = KCB_TABLE[grassType] || KCB_TABLE.microterme;
  return table[clamp(month - 1, 0, 11)];
}

// =======================================================================
// 5. WARM-START (v8.5 continuo — usa INIZIO della finestra storica)
// =======================================================================

/**
 * Stima theta all'INIZIO della finestra di simulazione (~60gg fa).
 * USA i primi giorni di history (condizioni a t=-60), NON gli ultimi
 * (che descrivono oggi e creerebbero un doppio conteggio dell'ET).
 */
function warmStart(history, sp) {
  if (!history || history.length === 0) {
    return { thetaRoot: sp.fc, thetaSurface: sp.fc, frac:0.75, frac7:0.75, frac30:0.75, source:'default-fc' };
  }
  var h7  = history.slice(0, 7);
  var h30 = history.slice(0, Math.min(30, history.length));
  var rain7  = 0, rain30 = 0, eto7 = 0, eto30 = 0;
  h7.forEach(function(d)  { rain7  += getField(d,'precipitation_sum','rain','precipitation') || 0; eto7  += getField(d,'et0_fao_evapotranspiration','et0','eto') || 2; });
  h30.forEach(function(d) { rain30 += getField(d,'precipitation_sum','rain','precipitation') || 0; eto30 += getField(d,'et0_fao_evapotranspiration','et0','eto') || 2; });
  var b7   = rain7  - 0.65 * eto7;
  var b30  = rain30 - 0.65 * eto30;
  var frac7  = 0.25 + 0.65 * clamp((b7  + 18) / 33, 0, 1);
  var frac30 = 0.30 + 0.60 * clamp((b30 + 25) / 45, 0, 1);
  var frac   = Math.max(frac7, frac30);
  var theta  = sp.wp + (sp.fc - sp.wp) * frac;
  return {
    thetaRoot:    clamp(theta,        sp.wpFloor,   sp.fc),
    thetaSurface: clamp(theta * 0.92, sp.wpSurface, sp.fc),
    frac, frac7, frac30, source: 'warm-start-continuous',
  };
}

// =======================================================================
// 6. PASSO GIORNALIERO DUAL-LAYER
// =======================================================================

/**
 * Avanza lo stato idrico di un giorno. PURO, nessuna side-effect.
 *
 * INFILTRAZIONE FAO-56: la pioggia penetra nell'INTERA zona radicale (0-Zr)
 * con distribuzione uniforme per profondita'. Non si accumula solo nei 10cm
 * superficiali aspettando overflow: questo era il difetto che prosciugava
 * il root anche con piogge abbondanti.
 *
 * SELF-MULCHING: quando la superficie e' piu' secca del root, il flusso
 * capillare verso l'alto e' soppresso (seSurf^3 -> 0). Il fondo trattiene
 * umidita' per settimane dopo che la superficie si e' asciugata.
 */
function stepDayDual(thetaSurface, thetaRoot, day, sp, kcb, lat) {
  var rain       = clamp(getField(day, 'precipitation_sum', 'rain', 'precipitation') || 0, 0, 200);
  var irrigation = clamp(getField(day, 'irrigation_mm') || 0, 0, 100);
  var eto        = extractETo(day, lat);
  var dew        = computeDewfall(day);
  var eta        = sp.eta;

  // Infiltrazione uniforme sull'intera zona radicale (0 a Zr)
  var totalMm    = (SURF_DEPTH + sp.rootDepth) * 1000;   // mm (loam: 300)
  var effRain    = (rain + irrigation) * eta + dew;
  var dThetaRain = effRain / totalMm;                    // incremento VWC uniforme

  var thetaS = thetaSurface + dThetaRain;
  var thetaR = thetaRoot    + dThetaRain;

  // Cap a sat; eccesso superficie -> root (immediato)
  if (thetaS > sp.sat) {
    var exS = (thetaS - sp.sat) * SURF_DEPTH * 1000;
    thetaS = sp.sat;
    thetaR += exS / (sp.rootDepth * 1000);
  }
  // Eccesso root -> drenaggio profondo (LENTO: loam 30%/gg)
  var deepDrainMm = 0;
  if (thetaR > sp.sat) {
    deepDrainMm += (thetaR - sp.sat) * sp.rootDepth * 1000;
    thetaR = sp.sat;
  }
  if (thetaR > sp.fc) {
    var exR     = (thetaR - sp.fc) * sp.rootDepth * 1000;
    var drToday = exR * clamp(sp.drainRate, 0, 1);
    deepDrainMm += drToday;
    thetaR       = sp.fc + (exR - drToday) / (sp.rootDepth * 1000);
  }
  // Superficie sopra fc -> drena al root (immediato)
  if (thetaS > sp.fc) {
    var exS2 = (thetaS - sp.fc) * SURF_DEPTH * 1000;
    thetaS   = sp.fc;
    thetaR   = Math.min(sp.sat, thetaR + exS2 / (sp.rootDepth * 1000));
  }

  // Evaporazione dal suolo (solo superficie)
  var kr  = computeKr(thetaS, sp);
  var ke  = computeKe(kr, kcb);
  var Es  = clamp(ke * eto, 0, SURF_DEPTH * 1000 * Math.max(0, thetaS - sp.wpSurface));

  // Traspirazione bistrato (v8.3): 60% surf, 40% root, ognuno con proprio Ks
  var ksSurf = computeKs(thetaS, sp, sp.thetaAtRAW_surf);
  var ksRoot = computeKs(thetaR, sp, sp.thetaAtRAW_root);
  var ksEff  = UPTAKE_SURF_FRAC * ksSurf + UPTAKE_ROOT_FRAC * ksRoot;
  var Tcb    = clamp(kcb * ksEff * eto, 0, 20);
  var T_surf = Tcb * UPTAKE_SURF_FRAC;
  var T_root = Tcb * UPTAKE_ROOT_FRAC;

  thetaS -= (Es + T_surf) / (SURF_DEPTH       * 1000);
  thetaR -= T_root         / (sp.rootDepth * 1000);

  // Self-mulching capillare (v8.4)
  // Flusso discendente (surf > root): libero
  // Flusso ascendente (root > surf): soppresso da seSurf^3
  var gradient = thetaS - thetaR;
  if (gradient > 0.001) {
    var fluxDown = sp.capillarity * gradient * sp.rootDepth * 1000 * 0.4;
    thetaS = Math.max(sp.wpSurface, thetaS - fluxDown / (SURF_DEPTH       * 1000));
    thetaR = Math.min(sp.fc,        thetaR + fluxDown / (sp.rootDepth * 1000));
  } else if (gradient < -0.001) {
    var seSurf  = clamp((thetaS - sp.wp) / (sp.sat - sp.wp), 0, 1);
    var fluxUp  = sp.capillarity * Math.abs(gradient) * sp.rootDepth * 1000 * 0.4 * Math.pow(seSurf, 3);
    thetaS = Math.min(sp.fc,        thetaS + fluxUp / (SURF_DEPTH       * 1000));
    thetaR = Math.max(sp.wpFloor,   thetaR - fluxUp / (sp.rootDepth * 1000));
  }

  // Floor agronomici
  thetaS = clamp(thetaS, sp.wpSurface, sp.sat);
  thetaR = clamp(thetaR, sp.wpFloor,   sp.sat);

  return { thetaSurface: thetaS, thetaRoot: thetaR, Es: Es, Tcb: Tcb, eto: eto,
           rain: rain, dewfall: dew, ks: ksEff, ke: ke, drained: deepDrainMm };
}

// =======================================================================
// 7. ANCHOR DA MISURAZIONE SUOLO (opzionale, 14gg)
// =======================================================================

function applySoilAnchor(soilData, refTheta, sp) {
  if (!soilData || soilData.um == null || !soilData.dt) return { theta: refTheta, anchored: false };
  var daysOld = (Date.now() - new Date(soilData.dt).getTime()) / 86400000;
  if (daysOld > 14) return { theta: refTheta, anchored: false, daysOld: daysOld, reason: 'troppo_vecchia' };
  var frac = clamp(soilData.um / 100, 0, 1);
  var theta;
  if (soilData.source === 'open-meteo') {
    // Open-Meteo land-surface: gia' volumetrico (um = soilMoist m3/m3 * 100)
    theta = clamp(soilData.um / 100, 0, 1);
  } else if (sp) {
    // Misura strumento/percepita: scala relativa 0-100 (wp=0%, sat=100%) -> volumetrico
    theta = sp.wp + frac * (sp.sat - sp.wp);
  } else {
    theta = frac;
  }
  return { theta: theta, anchored: true, daysOld: daysOld, anchorSource: soilData.source || 'measure' };
}

// =======================================================================
// 8. IRRIGATION STRATEGY
// =======================================================================

function getIrrigationStrategy(soilType, stressHeat) {
  var base = { sandy:{maxSessionMm:12,intervalH:36,refillTo:0.85},
               loam: {maxSessionMm:18,intervalH:48,refillTo:0.75},
               clay: {maxSessionMm:25,intervalH:96,refillTo:0.70} };
  var s    = base[soilType] || base.loam;
  var heat = clamp(stressHeat || 0, 0, 1);
  return {
    maxSessionMm: Math.round(s.maxSessionMm * (1 + 0.20 * heat)),
    intervalH:    Math.max(12, Math.round(s.intervalH * (1 - 0.50 * heat))),
    refillTo:     s.refillTo,
  };
}

// =======================================================================
// 9. calcWaterBalance — FUNZIONE PRINCIPALE
// =======================================================================

/**
 * Calcola il bilancio idrico del prato.
 * IDEMPOTENTE: stessi input -> stesso output. Non usa localStorage.
 *
 * @param {object} params
 *   wxData      : { history[60d], forecast[8d] }
 *   gardenData  : { lat, lon, soilType, totalArea, grassType, irrigationHistory[] }
 *   soilData    : { um (%), dt (ISO date) } — opzionale, finestra 14gg
 *   persistTheta: IGNORATO (era la causa del bug, rimosso)
 *
 * @returns interfaccia identica all'attuale calcWaterBalance:
 *   { modelVersion, vwcDisplayed, thetaRoot, thetaSurface, thetaSource,
 *     verdict, reason, displayNeedMm, totalLiters, irrigationWindow,
 *     trace[], layers{}, diagnostics{} }
 */
function calcWaterBalance(params) {
  params = params || {};
  var wxData     = params.wxData     || {};
  var gardenData = params.gardenData || {};
  var soilData   = params.soilData;

  var soilType   = gardenData.soilType  || 'loam';
  var lat        = gardenData.lat       || 45;
  var grassType  = gardenData.grassType || 'microterme';
  var totalArea  = gardenData.totalArea || 100;
  var sp         = buildSoilParams(soilType);
  var irrigLog   = gardenData.irrigationHistory || [];

  function irrigMmForDate(dateStr) {
    var entry = irrigLog.filter(function(e) { return (e.date || e.dt || '').slice(0,10) === (dateStr || '').slice(0,10); })[0];
    return entry ? (entry.mm || (entry.liters ? entry.liters / totalArea : 0)) : 0;
  }

  // Storia 60gg con irrigazioni iniettate
  var rawHistory = (wxData.history || []).slice(-60);
  var history    = rawHistory.map(function(d) {
    return Object.assign({}, d, { irrigation_mm: irrigMmForDate(d.date) });
  });

  // Warm-start: stima theta all'INIZIO della finestra (60gg fa)
  var ws = warmStart(history, sp);
  var thetaSurface = ws.thetaSurface;
  var thetaRoot    = ws.thetaRoot;
  var source       = ws.source;

  // Ricerca anchor in history
  var anchorInfo = { anchored: false };
  var anchorIdx  = -1;
  if (soilData && soilData.dt) {
    var mDate = soilData.dt.slice(0, 10);
    for (var ai = 0; ai < history.length; ai++) {
      if ((history[ai].date || '').slice(0, 10) === mDate) { anchorIdx = ai; break; }
    }
    // Fallback: misura piu' recente dell'ultimo giorno simulato (es. misura di oggi
    // ma history finisce a ieri) -> ancora all'ultimo giorno. Evita che l'ancora non scatti.
    if (anchorIdx < 0 && history.length) {
      var lastDate = (history[history.length - 1].date || '').slice(0, 10);
      if (mDate >= lastDate) anchorIdx = history.length - 1;
    }
    if (anchorIdx >= 0) anchorInfo = { anchored: true, idx: anchorIdx };
  }

  // Simulazione giornaliera
  var trace = [];
  for (var i = 0; i < history.length; i++) {
    var day   = history[i];
    var date  = new Date(day.date || '');
    var month = date.getMonth() + 1;
    var kcb   = getKcb(grassType, month);

    var step  = stepDayDual(thetaSurface, thetaRoot, day, sp, kcb, lat);
    thetaSurface = step.thetaSurface;
    thetaRoot    = step.thetaRoot;

    // Anchor: se questo e' il giorno della misura, correggi theta root
    if (anchorInfo.anchored && i === anchorIdx) {
      var anch = applySoilAnchor(soilData, thetaRoot, sp);
      if (anch.anchored) { thetaRoot = anch.theta; source = 'soil-measure-anchor'; }
    }

    trace.push({
      date:         day.date,
      thetaRoot:    +thetaRoot.toFixed(4),
      thetaSurface: +thetaSurface.toFixed(4),
      rain:         +step.rain.toFixed(1),
      irrigation:   +(day.irrigation_mm || 0).toFixed(1),
      eto:          +step.eto.toFixed(2),
      etc:          +(step.Es + step.Tcb).toFixed(2),
      Es:           +step.Es.toFixed(2),
      Tcb:          +step.Tcb.toFixed(2),
      dewfall:      +step.dewfall.toFixed(2),
      ks:           +step.ks.toFixed(3),
      ke:           +step.ke.toFixed(3),
      drained:      +step.drained.toFixed(2),
    });
  }

  // Display values
  // ROOT: scala relativa (wp=0%, sat=100%) - corrisponde alle sonde consumer a 15cm.
  //   loam fc -> ~58%, theta=0.28 dopo 3gg secchi -> ~45%  (target 45-55%) [OK]
  // SURFACE: raw VWC x100 - sonda a 5cm legge umidita' assoluta del top layer.
  //   target 20-30% -> theta_surf = 0.20-0.30 dopo 3gg secchi [OK]
  var satRange     = sp.sat - sp.wp;
  var vwcDisplayed = Math.round(clamp((thetaRoot - sp.wp) / satRange, 0, 1) * 100);
  var vwcSurface   = Math.round(clamp(thetaSurface * 100, 0, 100));

  // Fabbisogno
  var deficit       = Math.max(0, sp.fc - thetaRoot);
  var displayNeedMm = Math.round(deficit * sp.rootDepth * 1000 * 10) / 10;
  var totalLiters   = Math.round(displayNeedMm * totalArea);

  // Pioggia finestre
  var rain5d = 0;
  for (var ri = Math.max(0, history.length - 5); ri < history.length; ri++) {
    rain5d += getField(history[ri], 'precipitation_sum', 'rain', 'precipitation') || 0;
  }
  var forecast    = wxData.forecast7 || wxData.forecast || [];
  var rainNext2d  = 0;
  for (var fi = 0; fi < Math.min(2, forecast.length); fi++) {
    rainNext2d += getField(forecast[fi], 'precipitation_sum', 'rain', 'precipitation') || 0;
  }

  // Irrigazioni ultime 48h
  var now = Date.now();
  var irrigLast48h = irrigLog.reduce(function(s, e) {
    return s + ((now - new Date(e.date || e.dt).getTime()) < 172800000 ? (e.mm || 0) : 0);
  }, 0);

  // Verdict
  var verdict = 'monitor', reason = 'nella_norma';
  if      (rain5d >= 25)                                 { verdict='no';    reason='pioggia_abbondante'; }
  else if (thetaRoot > sp.thetaAtRAW_root)               { verdict='no';    reason='suolo_carico'; }
  else if (rainNext2d >= displayNeedMm * 0.8 && displayNeedMm > 0) { verdict='wait'; reason='pioggia_prevista'; }
  else if (displayNeedMm >= 3)                           { verdict='yes';   reason='deficit_idrico'; }
  if (displayNeedMm < 1)    { verdict='no'; reason='fabbisogno_minimo'; }
  if (irrigLast48h >= 2)    { verdict='no'; reason='irrigato_recente'; }

  // Finestra oraria e strategia
  var avgTmax3d = 20;
  if (forecast.length > 0) {
    var n = Math.min(3, forecast.length), sum = 0;
    for (var ti = 0; ti < n; ti++) sum += getField(forecast[ti], 'temperature_2m_max', 'tmax') || 20;
    avgTmax3d = sum / n;
  }
  var stressHeat = avgTmax3d > 30 ? 1.0 : avgTmax3d > 25 ? 0.5 : 0;
  var strategy   = getIrrigationStrategy(soilType, stressHeat);
  var irrWindow  = avgTmax3d > 25 ? '03:00-06:00' : avgTmax3d > 18 ? '05:00-08:00' : 'mattina';

  return {
    modelVersion:       MODEL_VERSION,
    vwcDisplayed:       vwcDisplayed,
    thetaRoot:          thetaRoot,
    thetaSurface:       thetaSurface,
    thetaSource:        source,
    verdict:            verdict,
    reason:             reason,
    displayNeedMm:      displayNeedMm,
    totalLiters:        totalLiters,
    irrigationWindow:   irrWindow,
    irrigationStrategy: strategy,
    trace:              trace,
    layers: {
      surface: {
        theta: thetaSurface, vwcDisplayed: vwcSurface, depth: SURF_DEPTH, depthCm: '0-10cm',
        tawMm:   +((sp.fc - sp.wp) * SURF_DEPTH * 1000).toFixed(1),
        availableMm: +Math.max(0, (thetaSurface - sp.wp) * SURF_DEPTH * 1000).toFixed(1),
        fc: sp.fc, wp: sp.wp, sat: sp.sat,
      },
      root: {
        theta: thetaRoot, vwcDisplayed: vwcDisplayed, depth: sp.rootDepth, depthCm: '10-30cm',
        tawMm:   +((sp.fc - sp.wp) * sp.rootDepth * 1000).toFixed(1),
        availableMm: +Math.max(0, (thetaRoot - sp.wp) * sp.rootDepth * 1000).toFixed(1),
        fc: sp.fc, wp: sp.wp, sat: sp.sat,
      },
    },
    diagnostics: {
      soilType:    soilType,
      soilParams:  { fc: sp.fc, wp: sp.wp, eta: sp.eta, Zr: sp.Zr },
      warmStart:   { frac: ws.frac, frac7: ws.frac7, frac30: ws.frac30 },
      anchor:      anchorInfo,
      rain5d:      +rain5d.toFixed(1),
      rainNext2d:  +rainNext2d.toFixed(1),
      irrigLast48h: +irrigLast48h.toFixed(1),
      thetaAtRAW:  +sp.thetaAtRAW_root.toFixed(3),
      deficit:     +deficit.toFixed(3),
      stressHeat:  stressHeat,
      avgTmax3d:   +avgTmax3d.toFixed(1),
      historyDays: history.length,
    },
  };
}

// =======================================================================
// EXPORT
// =======================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    calcWaterBalance: calcWaterBalance,
    stepDayDual:      stepDayDual,
    warmStart:        warmStart,
    buildSoilParams:  buildSoilParams,
    getKcb:           getKcb,
    getIrrigationStrategy: getIrrigationStrategy,
    computeDewfall:   computeDewfall,
    computeRa:        computeRa,
    hargreavesSamani: hargreavesSamani,
    MODEL_VERSION:    MODEL_VERSION,
    WATER_SOIL_PHYSICS: WATER_SOIL_PHYSICS,
  };
}

if (typeof window !== 'undefined') {
  window.WaterEngine = {
    calcWaterBalance: calcWaterBalance, stepDayDual: stepDayDual,
    warmStart: warmStart, buildSoilParams: buildSoilParams,
    getKcb: getKcb, getIrrigationStrategy: getIrrigationStrategy,
    MODEL_VERSION: MODEL_VERSION,
  };
}
