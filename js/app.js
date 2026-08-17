"use strict";

// Freie Routing- & Karten-Engine: OSRM/BRouter (Routing), OSM Nominatim (Geocoding),
// Nextbike Live-API (Frelo-Stationen). Alle Dienste sind kostenlos/öffentlich.

// ===== Konfiguration =====
const CONFIG = {
    cityId: 619,                        // Freiburg (Frelo) in der Nextbike-API
    center: [47.9978, 7.8413],          // Kartenmittelpunkt Freiburg
    zoom: 14,
    // Bounding-Box um Freiburg (begrenzt die Geocoding-Treffer)
    bbox: { west: 7.72, south: 47.92, east: 7.95, north: 48.06 },
    walkSpeedKmh: 5,                    // realistische Geh-Geschwindigkeit
    bikeSpeedKmh: 15,                   // realistische Rad-Geschwindigkeit
    minBikesToRent: 1,
    candidateLimit: 3,                  // so viele Stationen je Seite werden echt geroutet
    // Umwegfaktoren: Luftlinie -> reale Strecke. Nur noch Notnagel, falls kein
    // Routing-Dienst erreichbar ist.
    walkDetourFactor: 1.35,
    bikeDetourFactor: 1.25,
    requestTimeoutMs: 6000,
    maxParallelRequests: 4,             // öffentliche Routing-Server drosseln Bursts
    providerCooldownMs: 60000,          // nach einem Ausfall Dienst kurz überspringen
    // 1 genügt: osrmRoute versucht es bei Drosselung intern bereits ein zweites Mal
    providerFailLimit: 1
};

const EARTH_RADIUS_KM = 6371;
const GPS_LABEL = "Aktueller Standort (GPS)";

const ENDPOINTS = {
    nextbike: cityId => `https://maps.nextbike.net/maps/nextbike-live.json?city=${cityId}`,
    nominatim: "https://nominatim.openstreetmap.org/search",
    // FOSSGIS-OSRM: eigene Instanzen je Verkehrsmittel, CORS ist freigegeben.
    // Der Pfadbestandteil "driving" ist bei OSRM fix, entscheidend ist routed-<profil>.
    osrm: osrmProfile => `https://routing.openstreetmap.de/routed-${osrmProfile}`,
    brouter: "https://brouter.de/brouter"
};

// Profil-Definitionen: OSRM ist der Primärdienst, BRouter der Fallback.
// Wichtig: BRouter kennt KEIN "foot-fastest" (liefert HTTP 500) - für Fußwege
// ist "hiking-beta" das korrekte Profil.
const PROFILES = {
    foot: {
        osrm: "foot",
        brouter: "hiking-beta",
        speedKmh: CONFIG.walkSpeedKmh,
        detour: CONFIG.walkDetourFactor
    },
    bike: {
        osrm: "bike",
        brouter: "trekking",
        speedKmh: CONFIG.bikeSpeedKmh,
        detour: CONFIG.bikeDetourFactor
    }
};

// Die Nextbike-Live-API sendet CORS-Header, daher zuerst der Direktabruf.
// Fällt dieser aus, dienen die öffentlichen Proxys als Rückfallebene.
const DATA_SOURCES = [
    url => url,
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`
];

// Farben & Linienstile (mit den CSS-Klassen abgestimmt)
const FOOT_STYLE = { color: "#007aff", weight: 5, dashArray: "8, 8" };
const BIKE_STYLE = { color: "#34c759", weight: 6 };

// ===== Zustand =====
let map;
let routeLayers = [];
let freloStations = [];
let startCoords = null;
let destCoords = null;
let usingGps = false;

// ===== Hilfsfunktionen =====
const $ = id => document.getElementById(id);

const gmapsDir = (from, to, mode) =>
    `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}` +
    `&destination=${to.lat},${to.lng}&travelmode=${mode}`;

const estimateMinutes = (distanceMeters, speedKmh) =>
    Math.max(1, Math.round((distanceMeters / 1000) / speedKmh * 60));

// Dauer einer Etappe in Minuten: bevorzugt die vom Routing-Dienst gelieferte
// Fahrzeit, sonst aus der Distanz hochgerechnet.
const legMinutes = (route, speedKmh) =>
    Number.isFinite(route.duration) && route.duration > 0
        ? Math.max(1, Math.round(route.duration / 60))
        : estimateMinutes(route.distance, speedKmh);

function showStatus(msg, type = "info") {
    const el = $("status");
    el.className = `status-msg ${type}`;
    el.innerText = msg;
    el.style.display = "block";
}

function hideStatus() {
    $("status").style.display = "none";
}

// ===== App-Initialisierung =====
document.addEventListener("DOMContentLoaded", () => {
    initMap();
    loadFreloStations();

    $("route-btn").addEventListener("click", handleRouteCalculation);
    $("gps-btn").addEventListener("click", handleGPSClick);

    // Enter-Taste in den Eingabefeldern startet die Berechnung
    ["start-input", "dest-input"].forEach(id => {
        $(id).addEventListener("keydown", e => {
            if (e.key === "Enter") handleRouteCalculation();
        });
    });

    // Manuelle Eingabe hebt den GPS-Modus wieder auf
    $("start-input").addEventListener("input", () => { usingGps = false; });
});

function initMap() {
    map = L.map("map").setView(CONFIG.center, CONFIG.zoom);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap"
    }).addTo(map);
}

// ===== Datenabruf =====

// Ruft eine JSON-URL ab und probiert bei Fehlern die nächste Datenquelle.
async function fetchJson(url) {
    for (const wrap of DATA_SOURCES) {
        try {
            const res = await fetch(wrap(url));
            if (!res.ok) continue;
            return await res.json();
        } catch (err) {
            console.warn("Datenquelle nicht erreichbar, versuche nächste:", err);
        }
    }
    throw new Error("Keine Datenquelle erreichbar");
}

// Frelo-Stationen aus der Nextbike-Live-API laden.
async function loadFreloStations() {
    try {
        showStatus("Lade Frelo-Stationen...");
        const data = await fetchJson(ENDPOINTS.nextbike(CONFIG.cityId));

        const city = (data.countries || [])
            .flatMap(country => country.cities || [])
            .find(c => c.uid === CONFIG.cityId);

        if (city) {
            freloStations = city.places || [];
            console.log(`${freloStations.length} Frelo-Stationen geladen.`);
            hideStatus();
            return true;
        }

        showStatus("Keine Stationen für Freiburg gefunden.", "error");
    } catch (err) {
        console.error("Fehler beim Laden der Nextbike-API:", err);
        showStatus("Fehler beim Laden der Frelo-Daten. Bitte Seite neu laden.", "error");
    }
    return false;
}

// Geocoding via OpenStreetMap Nominatim, auf Freiburg begrenzt.
async function geocode(address) {
    const { west, south, east, north } = CONFIG.bbox;
    const params = new URLSearchParams({
        format: "json",
        q: `${address}, Freiburg`,
        limit: "1",
        countrycodes: "de",
        viewbox: `${west},${north},${east},${south}`,
        bounded: "1"
    });

    try {
        const res = await fetch(`${ENDPOINTS.nominatim}?${params}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
            return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
        }
    } catch (err) {
        console.error("Geocoding-Fehler:", err);
    }
    return null;
}

// fetch mit hartem Timeout - ein hängender Dienst darf die Route nicht blockieren.
async function fetchWithTimeout(url, timeoutMs = CONFIG.requestTimeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// Die öffentlichen Routing-Server drosseln Anfrage-Bursts (HTTP 429).
// Deshalb laufen nie mehr als CONFIG.maxParallelRequests Abrufe gleichzeitig.
let activeRequests = 0;
const requestQueue = [];

function withRequestSlot(task) {
    return new Promise((resolve, reject) => {
        const run = async () => {
            activeRequests++;
            try {
                resolve(await task());
            } catch (err) {
                reject(err);
            } finally {
                activeRequests--;
                const next = requestQueue.shift();
                if (next) next();
            }
        };

        if (activeRequests < CONFIG.maxParallelRequests) run();
        else requestQueue.push(run);
    });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Luftlinien-Notfallroute: Distanz wird mit dem Umwegfaktor beaufschlagt, damit
// die Anzeige nicht systematisch zu kurz ist. `estimated` markiert sie als Schätzung.
function beelineRoute(start, end, profileKey) {
    const p = PROFILES[profileKey];
    const meters = getDistanceKm(start, end) * 1000 * p.detour;
    return {
        geometry: {
            type: "LineString",
            coordinates: [[start.lng, start.lat], [end.lng, end.lat]]
        },
        distance: meters,
        duration: (meters / 1000) / p.speedKmh * 3600,
        estimated: true
    };
}

// OSRM (FOSSGIS): echtes Fußgänger- bzw. Radnetz, liefert Geometrie + Fahrzeit.
async function osrmRoute(start, end, profileKey) {
    const base = ENDPOINTS.osrm(PROFILES[profileKey].osrm);
    const coords = `${start.lng},${start.lat};${end.lng},${end.lat}`;
    const url = `${base}/route/v1/driving/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;

    let res = await withRequestSlot(() => fetchWithTimeout(url));

    // Bei Drosselung einmal kurz warten und erneut versuchen
    if (res.status === 429) {
        await sleep(600);
        res = await withRequestSlot(() => fetchWithTimeout(url));
    }
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);

    const data = await res.json();
    const route = data.code === "Ok" && data.routes && data.routes[0];
    if (!route || !route.geometry) throw new Error("OSRM ohne Route");

    return {
        geometry: route.geometry,
        distance: route.distance,   // Meter
        duration: route.duration,   // Sekunden
        estimated: false
    };
}

// BRouter als Zweitmeinung. Sendet selbst CORS-Header, daher erst direkt,
// nur im Notfall über den öffentlichen Proxy.
async function brouterRoute(start, end, profileKey) {
    const target = `${ENDPOINTS.brouter}?lonlats=${start.lng},${start.lat}|${end.lng},${end.lat}` +
        `&profile=${PROFILES[profileKey].brouter}&alternativeidx=0&format=geojson`;
    const urls = [target, `https://corsproxy.io/?url=${encodeURIComponent(target)}`];

    let lastErr;
    for (const url of urls) {
        try {
            const res = await withRequestSlot(() => fetchWithTimeout(url));
            if (!res.ok) throw new Error(`BRouter HTTP ${res.status}`);

            const data = await res.json();
            const feat = data.features && data.features[0];
            const trackLength = feat && parseFloat(feat.properties["track-length"]);
            if (!feat || !Number.isFinite(trackLength)) throw new Error("BRouter ohne Route");

            const totalTime = parseFloat(feat.properties["total-time"]);
            return {
                geometry: feat.geometry,
                distance: trackLength,
                duration: Number.isFinite(totalTime)
                    ? totalTime
                    : (trackLength / 1000) / PROFILES[profileKey].speedKmh * 3600,
                estimated: false
            };
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr;
}

// Einfacher Circuit-Breaker je Routing-Dienst: Ist ein Server down oder drosselt
// er uns, würde sonst jede einzelne Etappe erneut ins Timeout laufen.
const providerHealth = new Map();

function providerState(provider) {
    if (!providerHealth.has(provider)) {
        providerHealth.set(provider, { failures: 0, coldUntil: 0 });
    }
    return providerHealth.get(provider);
}

const isProviderCold = provider => Date.now() < providerState(provider).coldUntil;

function noteProviderFailure(provider) {
    const state = providerState(provider);
    state.failures++;
    if (state.failures >= CONFIG.providerFailLimit) {
        state.coldUntil = Date.now() + CONFIG.providerCooldownMs;
        state.failures = 0;
        console.warn(`${provider.name} wird für ${CONFIG.providerCooldownMs / 1000}s übersprungen.`);
    }
}

function noteProviderSuccess(provider) {
    providerHealth.set(provider, { failures: 0, coldUntil: 0 });
}

// Ergebnis-Cache: dieselbe Etappe (z.B. eine Station, die bei mehreren
// Berechnungen als Kandidat auftaucht) wird nicht erneut abgefragt.
const routeCache = new Map();
const routeKey = (start, end, profileKey) =>
    `${profileKey}:${start.lat.toFixed(5)},${start.lng.toFixed(5)}` +
    `>${end.lat.toFixed(5)},${end.lng.toFixed(5)}`;

// Robuste Fuß- und Rad-Routenberechnung: OSRM -> BRouter -> Luftlinie.
async function fetchRoute(start, end, profileKey = "foot") {
    // Start und Ziel praktisch identisch: kein Routing-Call nötig.
    if (getDistanceKm(start, end) * 1000 < 25) {
        const r = beelineRoute(start, end, profileKey);
        r.estimated = false;
        return r;
    }

    const key = routeKey(start, end, profileKey);
    if (routeCache.has(key)) return routeCache.get(key);

    for (const provider of [osrmRoute, brouterRoute]) {
        // Ist der Dienst gerade nicht erreichbar, nicht bei jeder Etappe erneut
        // ins Timeout laufen - das hat die Berechnung sonst um Minuten verzögert.
        if (isProviderCold(provider)) continue;

        try {
            const route = await provider(start, end, profileKey);
            noteProviderSuccess(provider);
            routeCache.set(key, route);
            return route;
        } catch (err) {
            noteProviderFailure(provider);
            console.warn(`Routing über ${provider.name} fehlgeschlagen (${profileKey}):`, err);
        }
    }

    // Schätzungen werden bewusst NICHT gecacht - beim nächsten Versuch soll
    // wieder ein echter Routing-Dienst zum Zug kommen.
    console.warn(`Kein Routing-Dienst erreichbar (${profileKey}) - Luftlinien-Schätzung.`);
    return beelineRoute(start, end, profileKey);
}


// ===== Standort & Geometrie =====

function handleGPSClick() {
    if (!navigator.geolocation) {
        showStatus("GPS wird von diesem Browser nicht unterstützt.", "error");
        return;
    }

    showStatus("Standort wird ermittelt...");
    navigator.geolocation.getCurrentPosition(
        pos => {
            startCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            usingGps = true;
            $("start-input").value = GPS_LABEL;
            hideStatus();
        },
        () => showStatus("GPS-Standort konnte nicht ermittelt werden.", "error"),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
}

// Haversine-Formel: Luftlinie in km.
function getDistanceKm(a, b) {
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 +
              Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// Anzahl aktuell ausleihbarer Räder einer Station.
const rentableBikes = st => st.bikes_available_to_rent ?? st.bikes ?? 0;

// Echte Frelo-Station? Die Nextbike-Antwort enthält neben den Stationen auch
// frei abgestellte Einzelräder (spot=false, Name "BIKE 123456") - die sind
// weder Leih- noch Rückgabeort im stationsbasierten Frelo-System.
const isStation = st => st.spot === true && st.active_place === 1;

// Ist an dieser Station eine Rückgabe möglich?
// Wichtig: free_racks===0 bedeutet bei Frelo NICHT "voll". Die meisten Stationen
// sind Schilder-Stationen (terminal_type "sign") mit weniger Bügeln als Rädern -
// im Live-Feed melden ~35% der Stationen free_racks=0, obwohl dort problemlos
// zurückgegeben werden kann. Die alte free_racks>0-Prüfung hat diese Stationen
// aussortiert und dadurch unnötig lange Fußwege zum Ziel erzwungen.
const canReturnBike = st => isStation(st);

// Liefert die N nächstgelegenen, verfügbaren Stationen (nicht nur die eine nächste),
// sortiert nach Luftlinien-Distanz. Grundlage für die Kombinations-Suche unten.
//   purpose "rent"   -> es muss mindestens ein ausleihbares Rad geben
//   purpose "return" -> es muss ein freier Rückgabeplatz zu erwarten sein
function getCandidateStations(coords, purpose, limit = CONFIG.candidateLimit) {
    const candidates = [];

    for (const st of freloStations) {
        if (!isStation(st)) continue;

        const available = purpose === "rent"
            ? rentableBikes(st) >= CONFIG.minBikesToRent
            : canReturnBike(st);

        if (!available) continue;

        const dist = getDistanceKm(coords, { lat: st.lat, lng: st.lng });
        candidates.push({ station: st, dist });
    }

    candidates.sort((a, b) => a.dist - b.dist);
    return candidates.slice(0, limit);
}

const stationPoint = st => ({ lat: st.lat, lng: st.lng });

// Luftlinien-Schätzung in Sekunden (Notnagel, wenn die Matrix nicht antwortet).
function estimateSeconds(a, b, profileKey) {
    const p = PROFILES[profileKey];
    const km = getDistanceKm(a, b) * p.detour;
    return km / p.speedKmh * 3600;
}

// Prüft alle sinnvollen Kombinationen aus Ausleih- und Rückgabestation und
// gibt die beste zurück - samt der bereits berechneten Fußwege, damit die
// Etappen 1 und 3 nicht ein zweites Mal geroutet werden müssen.
//
// Entscheidend: die Fußwege werden hier ECHT geroutet (OSRM-Fußgängernetz),
// nicht mehr per Luftlinie geschätzt. Dadurch verliert eine Station, die zwar
// nah liegt, aber nur über einen langen Umweg (Bahndamm, Dreisam, Sackgasse)
// erreichbar ist, gegen eine etwas entferntere mit direktem Fußweg.
// Die Radetappe wird für die Vorauswahl weiterhin geschätzt; für das gewählte
// Paar wird sie danach exakt geroutet.
async function findBestStationPair(startCoords, destCoords) {
    const candA = getCandidateStations(startCoords, "rent");
    const candB = getCandidateStations(destCoords, "return");

    if (candA.length === 0 || candB.length === 0) return null;

    // Erste Etappe als Probe einzeln routen: dadurch ist der Zustand der
    // Routing-Dienste bekannt, bevor der Rest parallel abgefragt wird. Ist ein
    // Dienst down, laufen so nicht alle Kandidaten gleichzeitig ins Timeout.
    const probe = await fetchRoute(startCoords, stationPoint(candA[0].station), "foot");

    // Restliche Kandidaten-Fußwege parallel (beide Richtungen korrekt herum)
    const [restA, footB] = await Promise.all([
        Promise.all(candA.slice(1).map(c => fetchRoute(startCoords, stationPoint(c.station), "foot"))),
        Promise.all(candB.map(c => fetchRoute(stationPoint(c.station), destCoords, "foot")))
    ]);
    const footA = [probe, ...restA];

    let best = null;

    candA.forEach((a, i) => {
        candB.forEach((b, j) => {
            // Gleiche Station für Ausleihe und Rückgabe ergibt keine sinnvolle Radetappe
            if (a.station.uid !== undefined && a.station.uid === b.station.uid) return;

            const bikeSeconds = estimateSeconds(
                stationPoint(a.station), stationPoint(b.station), "bike"
            );
            const total = footA[i].duration + bikeSeconds + footB[j].duration;

            if (!best || total < best.total) {
                best = {
                    stationA: a.station,
                    stationB: b.station,
                    footRouteA: footA[i],
                    footRouteB: footB[j],
                    total
                };
            }
        });
    });

    return best;
}

// ===== Haupt-Berechnung =====
// (Diese Funktion fehlte im Ausgangscode komplett, obwohl sie oben als
//  Click-Handler registriert wird -> ReferenceError beim Laden der Seite.)
async function handleRouteCalculation() {
    const startVal = $("start-input").value.trim();
    const destVal = $("dest-input").value.trim();

    if (!startVal) {
        showStatus("Bitte gib einen Startort ein (oder nutze den 📍 Button).", "error");
        return;
    }

    if (!destVal) {
        showStatus("Bitte gib eine Zieladresse ein.", "error");
        return;
    }

    const routeBtn = $("route-btn");
    routeBtn.disabled = true;
    showStatus("Berechne optimale Route...");

    try {
        // 1. Koordinaten auflösen
        if (!usingGps || !startCoords) {
            startCoords = await geocode(startVal);
        }
        destCoords = await geocode(destVal);

        if (!startCoords) {
            showStatus("Startadresse in Freiburg nicht gefunden.", "error");
            routeBtn.disabled = false;
            return;
        }
        if (!destCoords) {
            showStatus("Zieladresse in Freiburg nicht gefunden.", "error");
            routeBtn.disabled = false;
            return;
        }

        if (freloStations.length === 0) {
            await loadFreloStations();
        }

        // 2. Beste Stationskombination ermitteln - nicht einfach die per Luftlinie
        //    nächstgelegene Station pro Seite, sondern die Kombination mit der
        //    kürzesten Gesamtzeit auf Basis echt gerouteter Fußwege.
        const bestPair = await findBestStationPair(startCoords, destCoords);

        if (!bestPair) {
            showStatus("Keine passenden Frelo-Stationen gefunden.", "error");
            routeBtn.disabled = false;
            return;
        }

        const stationA = bestPair.stationA;
        const stationB = bestPair.stationB;

        const coords = {
            start: startCoords,
            a: { lat: stationA.lat, lng: stationA.lng },
            b: { lat: stationB.lat, lng: stationB.lng },
            end: destCoords
        };

        // 3. Die beiden Fußwege wurden bei der Stationswahl bereits geroutet,
        //    es fehlt nur noch die Radetappe.
        const routes = [
            bestPair.footRouteA,
            await fetchRoute(coords.a, coords.b, "bike"),
            bestPair.footRouteB
        ];

        // Warnen, wenn eine Etappe nur geschätzt werden konnte
        if (routes.some(r => r.estimated)) {
            showStatus("Hinweis: Für mindestens eine Etappe war kein Routing-Dienst erreichbar – " +
                "diese Angaben sind Luftlinien-Schätzungen.", "warn");
        } else {
            hideStatus();
        }

        // 4. Zeichnen und UI aktualisieren
        renderRoutesOnMap(coords, routes);
        updateUI({
            stations: { a: stationA, b: stationB },
            routes,
            coords
        });

    } catch (err) {
        console.error("Fehler bei der Berechnung:", err);
        showStatus("Fehler bei der Routenberechnung. Bitte erneut versuchen.", "error");
    } finally {
        routeBtn.disabled = false;
    }
}

// ===== Karten-Rendering =====

function makePin(pinClass) {
    return L.divIcon({
        className: "leaflet-div-icon",
        html: `<div class="marker-pin ${pinClass}"></div>`,
        iconSize: [30, 42],
        iconAnchor: [15, 42],
        popupAnchor: [0, -34]
    });
}

function renderRoutesOnMap(coords, [r1, r2, r3]) {
    // Alte Layer entfernen
    routeLayers.forEach(l => map.removeLayer(l));
    routeLayers = [];

    const polylines = [
        L.geoJSON(r1.geometry, { style: FOOT_STYLE }),
        L.geoJSON(r2.geometry, { style: BIKE_STYLE }),
        L.geoJSON(r3.geometry, { style: FOOT_STYLE })
    ];

    const markers = [
        L.marker([coords.start.lat, coords.start.lng], { icon: makePin("pin-start") }).bindPopup("<b>Start</b>"),
        L.marker([coords.a.lat, coords.a.lng], { icon: makePin("pin-station-a") }).bindPopup("<b>Ausleihe</b>"),
        L.marker([coords.b.lat, coords.b.lng], { icon: makePin("pin-station-b") }).bindPopup("<b>Rückgabe</b>"),
        L.marker([coords.end.lat, coords.end.lng], { icon: makePin("pin-end") }).bindPopup("<b>Ziel</b>")
    ];

    [...polylines, ...markers].forEach(layer => layer.addTo(map));
    routeLayers = [...polylines, ...markers];

    // Kartenausschnitt an die Route anpassen
    const bounds = L.featureGroup(polylines).getBounds();
    if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [30, 30] });
    }
}

// ===== Info-Panel =====
function updateUI({ stations, routes, coords }) {
    const [r1, r2, r3] = routes;
    const stA = stations.a;
    const stB = stations.b;

    $("info-panel").style.display = "block";

    // Zeiten kommen jetzt direkt vom Routing-Dienst (inkl. Steigungen bei BRouter);
    // nur wenn keine Fahrzeit geliefert wurde, wird aus der Distanz hochgerechnet.
    const t1 = legMinutes(r1, CONFIG.walkSpeedKmh);
    const t2 = legMinutes(r2, CONFIG.bikeSpeedKmh);
    const t3 = legMinutes(r3, CONFIG.walkSpeedKmh);

    const d1 = Math.round(r1.distance);                 // Meter
    const d2 = (r2.distance / 1000).toFixed(1);         // km
    const d3 = Math.round(r3.distance);                 // Meter
    const totalKm = ((r1.distance + r2.distance + r3.distance) / 1000).toFixed(1);

    $("total-time").innerText = `~${t1 + t2 + t3} min`;
    $("total-dist").innerText = `${totalKm} km`;

    // Etappe 1 – Fußweg zur Leihstation
    $("e1-dist").innerText = `${d1} m (${t1} min)`;
    $("station-a-name").innerText = stA.name;

    // Etappe 2 – Fahrt mit dem Frelo
    $("e2-dist").innerText = `${d2} km (${t2} min)`;
    $("e2-from").innerText = stA.name;
    $("e2-to").innerText = stB.name;
    $("station-a-bikes").innerText = rentableBikes(stA);

    // Etappe 3 – Fußweg zum Ziel
    $("e3-dist").innerText = `${d3} m (${t3} min)`;
    $("station-b-name").innerText = stB.name;
    const freeRacks = stB.free_racks;
    $("station-b-racks").innerText = freeRacks > 0
        ? `${freeRacks} freie Rückgabeplätze`
        : "Rückgabe möglich";

    // Google-Maps-Navigationslinks je Etappe
    $("e1-nav-btn").href = gmapsDir(coords.start, coords.a, "walking");
    $("e2-nav-btn").href = gmapsDir(coords.a, coords.b, "bicycling");
    $("e3-nav-btn").href = gmapsDir(coords.b, coords.end, "walking");
}
