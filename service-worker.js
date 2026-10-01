/* ============================================================
   SERVICE WORKER — Afinador PWA
   ============================================================
   Estratégia: cache-first para o shell do app.
   Versionar o cache ao alterar arquivos (mude CACHE_VERSION).
   ============================================================ */

const CACHE_VERSION = "afinador-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.json"
];

// Instalação: pré-carrega o shell no cache
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

// Ativação: remove caches antigos
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_VERSION)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Fetch: cache-first, com fallback para rede
self.addEventListener("fetch", (event) => {
  // Ignorar requisições não-GET (ex: POST)
  if (event.request.method !== "GET") return;

  // Ignorar esquemas não-http(s) (chrome-extension, etc.)
  const url = new URL(event.request.url);
  if (!url.protocol.startsWith("http")) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          // Cachear apenas respostas válidas do próprio escopo
          if (
            response &&
            response.status === 200 &&
            response.type === "basic"
          ) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => {
              cache.put(event.request, clone);
            });
          }
          return response;
        })
        .catch(() => {
          // Offline e não está no cache: retorna index.html como fallback
          if (event.request.mode === "navigate") {
            return caches.match("./index.html");
          }
        });
    }),
  );
});