/* ============================================================
   sw.js — Service Worker (Offline-Fähigkeit + Update-Erkennung)
   Beim Deploy die CACHE-Version erhöhen: der Browser erkennt den
   geänderten Service Worker, installiert ihn und die Seite zeigt
   das "Neue Version verfügbar"-Banner (siehe js/app.js).
   ============================================================ */
const CACHE = "ew-cache-v28";

// Kern-Dateien (App-Shell). Relative Pfade, damit es auch unter
// einem Unterverzeichnis (GitHub Pages) funktioniert.
const CORE = [
    "./",
    "index.html",
    "elektroauto-kostenvergleich.html",
    "elektroauto-nachtfahrt.html",
    "zendure-simulation.html",
    "css/site.css",
    "css/tools.css",
    "js/app.js",
    "js/zendure-sim.js",
    "img/circuit.svg",
    "manifest.webmanifest",
    "icons/icon-192.png",
    "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then((c) => c.addAll(CORE))
            .catch(() => { /* einzelne fehlende Datei nicht fatal */ })
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Seiten (HTML): Network-first – online immer der aktuelle Stand,
// offline der zuletzt geladene. cache:"no-cache" umgeht den
// HTTP-Cache von GitHub Pages (max-age 10 min) per Revalidierung.
// Alles andere (CSS/JS/Bilder): Cache-first; Änderungen daran kommen
// über die CACHE-Version + Update-Banner.
function isPage(req) {
    return req.mode === "navigate" ||
        (req.headers.get("accept") || "").indexOf("text/html") !== -1;
}

self.addEventListener("fetch", (event) => {
    const req = event.request;
    const url = new URL(req.url);
    if (req.method !== "GET" || url.origin !== self.location.origin) return;

    if (isPage(req)) {
        event.respondWith(
            fetch(req, { cache: "no-cache" }).then((res) => {
                if (res && res.status === 200 && res.type === "basic") {
                    const copy = res.clone();
                    caches.open(CACHE).then((c) => c.put(req, copy));
                }
                return res;
            }).catch(() => caches.match(req).then((hit) => hit || caches.match("index.html")))
        );
        return;
    }

    event.respondWith(
        caches.match(req).then((hit) => {
            if (hit) return hit;
            return fetch(req).then((res) => {
                if (res && res.status === 200 && res.type === "basic") {
                    const copy = res.clone();
                    caches.open(CACHE).then((c) => c.put(req, copy));
                }
                return res;
            }).catch(() => hit);
        })
    );
});

// Auf Wunsch der Seite sofort aktiv werden → controllerchange → Reload.
self.addEventListener("message", (event) => {
    if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
