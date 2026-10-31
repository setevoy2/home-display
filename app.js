"use strict";

const MAX_FRESHNESS_MS = 300000;
const CLOCK_SKEW_MS = 120000;
const UNAVAILABLE_REASON = "Дані застаріли - рекомендацією не користуватися";
const RECOMMENDATION_POLICY_VERSION = 2;
const APPLIANCES = [
  {id: "kettle", name: "Електрочайник", watts: 2000, allowedSoc: 50, cautionSoc: 35},
  {id: "microwave", name: "Мікрохвильовка", watts: 1400, allowedSoc: 40, cautionSoc: 25},
];
const PAYLOAD_KEYS = ["generatedAt", "recommendations", "schemaVersion", "stations"];
const STATION_KEYS = ["acInputVolts", "available", "chargePercent", "freshnessSeconds", "gridState", "id", "inputWatts", "label", "observedAt", "outputWatts", "remainingMinutes", "state"];
const RECOMMENDATION_KEYS = ["appliances", "reason", "simultaneousWarning", "status"];
const APPLIANCE_KEYS = ["id", "name", "reason", "status"];
const STATUS = ["allowed", "caution", "avoid", "unknown"];
let lastValidPayload = null;
let refreshInFlight = null;
let lastRefreshFailed = false;

const element = selector => document.querySelector(selector);
const banner = element("#banner");

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("|") === expected.slice().sort().join("|");
}

function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/.exec(value);
  if (!match || Number(match[1]) === 0) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const instant = new Date(parsed);
  return instant.getUTCFullYear() === Number(match[1]) && instant.getUTCMonth() + 1 === Number(match[2]) &&
    instant.getUTCDate() === Number(match[3]) && instant.getUTCHours() === Number(match[4]) &&
    instant.getUTCMinutes() === Number(match[5]) && instant.getUTCSeconds() === Number(match[6]);
}

const integerIn = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;

function validStation(station, expectedId, expectedLabel, generatedAt) {
  if (!exactKeys(station, STATION_KEYS) || station.id !== expectedId || station.label !== expectedLabel ||
      typeof station.available !== "boolean" || !["charging", "discharging", "idle", "unknown"].includes(station.state) ||
      !["present", "absent", "unknown"].includes(station.gridState)) return false;
  const observedPair = station.observedAt === null && station.freshnessSeconds === null;
  const observedValues = validTimestamp(station.observedAt) && Number.isInteger(station.freshnessSeconds) && station.freshnessSeconds >= 0;
  if (!observedPair && !observedValues) return false;
  if (observedValues) {
    const generationAge = (Date.parse(generatedAt) - Date.parse(station.observedAt)) / 1000;
    if (generationAge < 0 || station.freshnessSeconds !== Math.floor(generationAge)) return false;
  }
  if (!station.available) {
    return station.state === "unknown" && station.gridState === "unknown" &&
      [station.chargePercent, station.inputWatts, station.outputWatts, station.acInputVolts, station.remainingMinutes].every(value => value === null);
  }
  if (!observedValues || Date.parse(station.observedAt) - Date.now() > CLOCK_SKEW_MS ||
      Date.now() - Date.parse(station.observedAt) > MAX_FRESHNESS_MS || station.freshnessSeconds > 300) return false;
  if (!integerIn(station.chargePercent, 0, 100) || !integerIn(station.inputWatts, 0, 100000) ||
      !integerIn(station.outputWatts, 0, 100000) || !integerIn(station.acInputVolts, 0, 1000) ||
      station.state === "unknown") return false;
  const expectedGrid = station.acInputVolts >= 180 ? "present" : station.acInputVolts <= 10 ? "absent" : "unknown";
  const difference = station.inputWatts - station.outputWatts;
  const expectedState = difference > 50 ? "charging" : difference < -50 ? "discharging" : "idle";
  if (station.gridState !== expectedGrid || station.state !== expectedState) return false;
  if (station.remainingMinutes !== null && !integerIn(station.remainingMinutes, 1, 5999)) return false;
  if (station.state === "idle" && station.remainingMinutes !== null) return false;
  if (station.state !== "idle" && !integerIn(station.remainingMinutes, 1, 5999)) return false;
  return true;
}

function adviceItem(appliance, status, reason) {
  return {id: appliance.id, name: appliance.name, status, reason};
}

// Mirrored implementation of recommendation-policy-v2.md. Python-generated
// exhaustive boundary fixtures are the cross-runtime conformance oracle.
function deriveRecommendations(home) {
  if (!home.available || home.gridState === "unknown") {
    return {status: "unknown", reason: UNAVAILABLE_REASON,
      appliances: APPLIANCES.map(appliance => adviceItem(appliance, "unknown", UNAVAILABLE_REASON)),
      simultaneousWarning: null};
  }
  const items = [];
  if (home.gridState === "present") {
    const voltage = home.acInputVolts;
    const charging = home.state === "charging" ? home.inputWatts : 0;
    let status;
    let reason;
    if (voltage < 205) {
      status = "avoid";
      reason = `Низька напруга ${voltage} В${charging >= 500 ? ` і заряджання ${charging} Вт` : ""}`;
    } else if (voltage < 215) {
      status = charging >= 500 ? "avoid" : "caution";
      reason = charging >= 500 ? `Напруга ${voltage} В і заряджання ${charging} Вт` :
        `Напруга ${voltage} В - лише з обережністю`;
    } else if (voltage > 260) {
      status = "avoid"; reason = `Висока напруга ${voltage} В`;
    } else if (voltage >= 254) {
      if (charging > 1500) {
        status = "avoid"; reason = `Висока напруга ${voltage} В і заряджання ${charging} Вт`;
      } else {
        status = "caution"; reason = `Висока напруга ${voltage} В - лише з обережністю`;
      }
    } else if (charging > 1500) {
      status = "avoid"; reason = `Станція заряджається на ${charging} Вт`;
    } else if (charging > 1000) {
      status = "caution"; reason = `Станція заряджається на ${charging} Вт`;
    } else {
      status = "allowed"; reason = "Мережа є, але запас потужності не гарантований";
    }
    APPLIANCES.forEach(appliance => items.push(adviceItem(appliance, status, reason)));
  } else {
    APPLIANCES.forEach(appliance => {
      const projected = home.outputWatts + appliance.watts;
      let status;
      let reason;
      if (projected > 3000) {
        status = "avoid"; reason = `Очікуване навантаження ${projected} Вт перевищує обережний ліміт`;
      } else if (home.chargePercent >= appliance.allowedSoc) {
        status = "allowed"; reason = `Заряд ${home.chargePercent}%, очікуване навантаження ${projected} Вт`;
      } else if (home.chargePercent >= appliance.cautionSoc) {
        status = "caution"; reason = `Заряд лише ${home.chargePercent}%`;
      } else {
        status = "avoid"; reason = `Низький заряд ${home.chargePercent}%`;
      }
      items.push(adviceItem(appliance, status, reason));
    });
  }
  const rank = {allowed: 0, caution: 1, avoid: 2, unknown: 3};
  const status = items.reduce((worst, item) => rank[item.status] > rank[worst] ? item.status : worst, "allowed");
  const reason = items.find(item => item.status === status).reason;
  const warningContext = home.gridState === "present" &&
    ((home.acInputVolts >= 205 && home.acInputVolts <= 214) ||
     (home.acInputVolts >= 215 && home.acInputVolts <= 253 && home.state === "charging"));
  const simultaneousWarning = warningContext &&
    items.every(item => item.status === "allowed" || item.status === "caution") ?
    "Не вмикайте потужні прилади одночасно" : null;
  return {status, reason, appliances: items, simultaneousWarning};
}

function validRecommendations(value, home) {
  if (!exactKeys(value, RECOMMENDATION_KEYS) || !STATUS.includes(value.status) || typeof value.reason !== "string" ||
      !Array.isArray(value.appliances) || value.appliances.length !== 2 ||
      !(value.simultaneousWarning === null || value.simultaneousWarning === "Не вмикайте потужні прилади одночасно")) return false;
  const expected = [["kettle", "Електрочайник"], ["microwave", "Мікрохвильовка"]];
  if (!value.appliances.every((item, index) => exactKeys(item, APPLIANCE_KEYS) && item.id === expected[index][0] &&
      item.name === expected[index][1] && STATUS.includes(item.status) && typeof item.reason === "string")) return false;
  return JSON.stringify(value) === JSON.stringify(deriveRecommendations(home));
}

function validPayload(payload) {
  if (!exactKeys(payload, PAYLOAD_KEYS) || payload.schemaVersion !== 2 || !validTimestamp(payload.generatedAt) ||
      Date.parse(payload.generatedAt) - Date.now() > CLOCK_SKEW_MS || !Array.isArray(payload.stations) || payload.stations.length !== 2) return false;
  if (!validStation(payload.stations[0], "home", "Дім", payload.generatedAt) ||
      !validStation(payload.stations[1], "office", "Офіс", payload.generatedAt)) return false;
  return validRecommendations(payload.recommendations, payload.stations[0]);
}

function showBanner(message) { banner.textContent = message; banner.hidden = false; }
function hideBanner() { banner.textContent = ""; banner.hidden = true; }

const stateText = {charging: "Заряджається", discharging: "Віддає заряд", idle: "Очікує", unknown: "Дані недоступні"};
const adviceText = {allowed: "Можна вмикати", caution: "Краще не вмикати", avoid: "Не вмикайте", unknown: "Не покладайтеся на рекомендацію"};
const applianceText = {allowed: "Можна", caution: "Обережно", avoid: "Не вмикати", unknown: "Невідомо"};

function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} год ${rest} хв` : `${rest} хв`;
}

function ageSeconds(observedAt) {
  return Math.max(0, Math.floor((Date.now() - Date.parse(observedAt)) / 1000));
}

function formatFreshness(observedAt) {
  const age = ageSeconds(observedAt);
  if (age < 60) return `Оновлено ${age} с тому`;
  return `Оновлено ${Math.floor(age / 60)} хв тому`;
}

function voltageBand(volts) {
  if (volts >= 215 && volts <= 253) return "green";
  if ((volts >= 205 && volts <= 214) || (volts >= 254 && volts <= 260)) return "yellow";
  return "red";
}

function outputPowerBand(watts) {
  if (watts < 200) return "green";
  if (watts < 300) return "yellow";
  if (watts < 400) return "orange";
  if (watts < 500) return "red";
  return "deep-red";
}

function renderRecommendation(recommendation, forceUnknown) {
  const value = forceUnknown ? {
    status: "unknown", reason: UNAVAILABLE_REASON,
    appliances: [
      {id: "kettle", name: "Електрочайник", status: "unknown", reason: UNAVAILABLE_REASON},
      {id: "microwave", name: "Мікрохвильовка", status: "unknown", reason: UNAVAILABLE_REASON},
    ], simultaneousWarning: null,
  } : recommendation;
  const card = element("#recommendation");
  card.className = `recommendation recommendation-${value.status}`;
  element("#recommendation-status").textContent = adviceText[value.status];
  element("#recommendation-reason").textContent = value.reason;
  value.appliances.forEach(item => {
    element(`#${item.id}-name`).textContent = item.name;
    element(`#${item.id}-status`).textContent = applianceText[item.status];
    element(`#${item.id}-reason`).textContent = item.reason;
    element(`#${item.id}-row`).className = `appliance appliance-${item.status}`;
  });
  const warning = element("#simultaneous-warning");
  warning.textContent = value.simultaneousWarning || "";
  warning.hidden = value.simultaneousWarning === null;
}

function renderStation(station, forceStale = false) {
  const prefix = station.id;
  const unavailable = !station.available || forceStale;
  element(`#station-${prefix}`).className = `station-card${unavailable ? " unavailable" : ""}`;
  element(`#${prefix}-title`).textContent = station.label;
  element(`#${prefix}-state`).textContent = unavailable ? "Дані недоступні" : stateText[station.state];
  element(`#${prefix}-charge`).textContent = unavailable ? "—" : `${station.chargePercent}%`;
  const input = element(`#${prefix}-input`);
  input.textContent = unavailable ? "—" : `${station.inputWatts} Вт`;
  input.className = `power-flow ${!unavailable && station.inputWatts === 0 ? "power-input-zero" : "power-neutral"}`;
  const output = element(`#${prefix}-output`);
  output.textContent = unavailable ? "—" : `${station.outputWatts} Вт`;
  output.className = unavailable ? "power-flow power-neutral" :
    `power-flow power-output-${outputPowerBand(station.outputWatts)}`;
  const voltage = element(`#${prefix}-voltage`);
  voltage.textContent = unavailable ? "—" : `${station.acInputVolts} В`;
  voltage.className = `voltage voltage-${unavailable ? "neutral" : voltageBand(station.acInputVolts)}`;
  const label = element(`#${prefix}-remaining-label`);
  const value = element(`#${prefix}-remaining`);
  if (!unavailable && station.remainingMinutes !== null && station.state !== "idle") {
    label.textContent = station.state === "charging" ? "До повного заряду" : "Залишилось приблизно";
    value.textContent = formatMinutes(station.remainingMinutes);
    label.hidden = false; value.hidden = false;
  } else {
    label.textContent = ""; value.textContent = ""; label.hidden = true; value.hidden = true;
  }
  element(`#${prefix}-freshness`).textContent = station.observedAt ? formatFreshness(station.observedAt) : "Оновлення недоступне";
}

function render(payload) {
  lastValidPayload = payload;
  renderRecommendation(payload.recommendations, !payload.stations[0].available);
  payload.stations.forEach(station => renderStation(station));
}

function updateStaleness() {
  if (!lastValidPayload) return;
  const stale = lastValidPayload.stations.map(station => !station.available || !station.observedAt || Date.now() - Date.parse(station.observedAt) > MAX_FRESHNESS_MS);
  lastValidPayload.stations.forEach((station, index) => renderStation(station, stale[index]));
  renderRecommendation(lastValidPayload.recommendations, stale[0]);
  if (!lastRefreshFailed) hideBanner();
}

async function performRefresh() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`data.json?t=${Date.now()}`, {cache: "no-store", signal: controller.signal});
    if (!response.ok) throw new Error("request failed");
    const payload = await response.json();
    if (!validPayload(payload)) throw new Error("invalid payload");
    render(payload);
    lastRefreshFailed = false;
    hideBanner();
    updateStaleness();
  } catch (_error) {
    lastRefreshFailed = true;
    showBanner("Не вдалося оновити дані");
  } finally {
    clearTimeout(timeout);
  }
}

function refresh() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = performRefresh().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

refresh();
setInterval(updateStaleness, 1000);
setInterval(refresh, 30000);
