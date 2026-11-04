<script>
  import Router from "svelte-spa-router";
  import Capture from "./routes/Capture.svelte";
  import Bill from "./routes/Bill.svelte";
  import Share from "./routes/Share.svelte";

  const hashMode = import.meta.env.VITE_ROUTER_MODE === "hash";

  // Ticket 16 puts the whole share payload in the fragment: "#v1.<token>.<nonce>.<ct>".
  // The probe measures what the router does with that string in each routing mode.
  const routes = new Map([
    ["/", Capture],
    ["/bill", Bill],
    ["/share", Share],
    ["/v1/:payload", Share],
  ]);

  const href = (path) => (hashMode ? `#${path}` : path);

  window.__probe = { rawHash: "", routeParam: "", ocr: "idle", parsed: null, error: null };

  function syncHash(event) {
    window.__probe.rawHash = window.location.hash;
    const detail = event && event.detail ? event.detail : null;
    window.__probe.routeParam = detail && detail.params ? String(detail.params.payload ?? "") : "";
  }
</script>

<nav>
  <a href={href("/")}>capture</a>
  <a href={href("/bill")}>bill</a>
  <a href={href("/share")}>share</a>
</nav>
<main>
  <Router {routes} {hashMode} on:routeEvent={syncHash} on:hashchange={syncHash} />
</main>
