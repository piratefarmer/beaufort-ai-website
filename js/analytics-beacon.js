/* Beau city-level analytics beacon */
(function () {
  try {
    var host = location.hostname || "";
    if (
      host !== "beaufortai.ai" &&
      host !== "www.beaufortai.ai" &&
      host !== "beau.beaufort-ai.com" &&
      host !== "www.beaufort-ai.com" &&
      host.indexOf("beaufortai.pages.dev") === -1
    ) {
      return;
    }
    // Prefer custom domain; workers.dev is fallback if custom route fails
    var ENDPOINTS = [
      "https://analytics.beaufortai.ai/v",
      "https://beau-analytics.capt-barrett.workers.dev/v"
    ];
    var payload = {
      path: location.pathname + location.search,
      title: document.title || "",
      referrer: document.referrer || "",
      page_url: location.href,
      ts: new Date().toISOString()
    };
    var body = JSON.stringify(payload);

    function send(url) {
      if (navigator.sendBeacon) {
        try {
          return navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
        } catch (e) {}
      }
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: true,
        mode: "cors",
        credentials: "omit"
      }).catch(function () {});
      return true;
    }

    if (!send(ENDPOINTS[0])) {
      send(ENDPOINTS[1]);
    }
  } catch (e) {}
})();
