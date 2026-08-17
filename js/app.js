"use strict";

// Freie Routing- & Karten-Engine: OSRM (Routing), OSM Nominatim (Geocoding),
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
    minBikesToRent: 1
};

const EARTH_RADIUS_KM = 6371;
const GPS_LABEL = "Aktueller Standort (GPS)";

const ENDPOINTS = {
    nextbike: cityId => `https://maps.nextbike.net/maps/nextbike-live.json?city=${cityId}`,
    nominatim: "https://nominatim.openstreetmap.org/search",
    osrm: "https://router.project-osrm.org/route/v1"
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

// OSRM-Demo liefert nur Auto-Zeiten – wir schätzen die Dauer aus der Distanz.
const estimateMinutes = (distanceMeters, speedKmh) =>
    Math.max(1, Math.round((distanceMeters / 1000) / speedKmh * 60));

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

// OSRM-Route für ein Segment (foot/bike) abrufen.
async function fetchOSRMRoute(start, end, profile = "foot") {
    const url = `${ENDPOINTS.osrm}/${profile}/` +
        `${start.lng},${start.lat};${end.lng},${end.lat}` +
        `?overview=full&geometries=geojson`;
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.routes && data.routes.length > 0) {
            return data.routes[0];
        }
    } catch (err) {
        console.error("OSRM-Fehler:", err);
    }
    return null;
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

// Nächstgelegene passende Station finden.
//   purpose "rent"   -> es muss mindestens ein ausleihbares Rad geben
//   purpose "return" -> es muss eine offizielle Station (spot) sein
function findNearestStation(coords, purpose) {
    let best = null;
    let minDistance = Infinity;

    for (const st of freloStations) {
        const available = purpose === "rent"
            ? rentableBikes(st) >= CONFIG.minBikesToRent
            : Boolean(st.spot);

        if (!available) continue;

        const dist = getDistanceKm(coords, { lat: st.lat, lng: st.lng });
        if (dist < minDistance) {
            minDistance = dist;
            best = st;
        }
    }
    return best;
}

// ===== Haupt-Logik =====
async function handleRouteCalculation() {
    const btn = $("route-btn");
    if (btn.disabled) return; // laufende Berechnung nicht doppelt starten

    const startVal = $("start-input").value.trim();
    const destVal = $("dest-input").value.trim();

    if (!destVal) {
        showStatus("Bitte gib ein Ziel ein.", "error");
        return;
    }
    if (!usingGps && !startVal) {
        showStatus("Bitte gib einen Start ein oder nutze GPS.", "error");
        return;
    }

    const originalLabel = btn.innerText;
    btn.disabled = true;
    btn.innerText = "Berechne...";
    showStatus("Berechne optimale Frelo-Route...");

    try {
        // 1. Start- und Zielkoordinaten bestimmen
        if (!usingGps) startCoords = await geocode(startVal);
        destCoords = await geocode(destVal);

        if (!startCoords) {
            showStatus("Startadresse konnte nicht gefunden werden.", "error");
            return;
        }
        if (!destCoords) {
            showStatus("Zieladresse konnte nicht gefunden werden.", "error");
            return;
        }

        // 2. Stationsdaten sicherstellen
        if (freloStations.length === 0 && !(await loadFreloStations())) {
            showStatus("Stationsdaten sind nicht verfügbar. Bitte später erneut versuchen.", "error");
            return;
        }

        // 3. Nächste Ausleih- und Rückgabestation suchen
        const stationA = findNearestStation(startCoords, "rent");
        const stationB = findNearestStation(destCoords, "return");

        if (!stationA || !stationB) {
            showStatus("Keine passenden Frelo-Stationen gefunden.", "error");
            return;
        }

        const sameStation = stationA.uid === stationB.uid;
        if (sameStation) {
            showStatus("Start und Ziel liegen an derselben Station – zu Fuß bist du vermutlich schneller.", "info");
        }

        const aCoords = { lat: stationA.lat, lng: stationA.lng };
        const bCoords = { lat: stationB.lat, lng: stationB.lng };

        // 4. Die drei Segmente parallel routen
        const [route1, route2, route3] = await Promise.all([
            fetchOSRMRoute(startCoords, aCoords, "foot"),
            fetchOSRMRoute(aCoords, bCoords, "bike"),
            fetchOSRMRoute(bCoords, destCoords, "foot")
        ]);

        if (!route1 || !route2 || !route3) {
            showStatus("Route konnte nicht berechnet werden. Bitte erneut versuchen.", "error");
            return;
        }

        if (!sameStation) hideStatus();

        // 5. Karte und Info-Panel aktualisieren
        const coords = { start: startCoords, a: aCoords, b: bCoords, end: destCoords };
        renderRoutesOnMap(coords, [route1, route2, route3]);
        updateUI({
            stations: { a: stationA, b: stationB },
            routes: [route1, route2, route3],
            coords
        });
    } catch (err) {
        console.error("Fehler bei der Routenberechnung:", err);
        showStatus("Bei der Routenberechnung ist ein Fehler aufgetreten.", "error");
    } finally {
        btn.disabled = false;
        btn.innerText = originalLabel;
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

    // Geschätzte Zeiten (aus der Distanz, da OSRM-Demo nur Auto-Zeiten liefert)
    const t1 = estimateMinutes(r1.distance, CONFIG.walkSpeedKmh);
    const t2 = estimateMinutes(r2.distance, CONFIG.bikeSpeedKmh);
    const t3 = estimateMinutes(r3.distance, CONFIG.walkSpeedKmh);

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
