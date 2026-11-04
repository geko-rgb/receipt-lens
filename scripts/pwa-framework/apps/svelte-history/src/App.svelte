<script>
  import { Router, Route, Link } from "svelte-routing";
  import Capture from "./routes/Capture.svelte";
  import Bill from "./routes/Bill.svelte";
  import Share from "./routes/Share.svelte";

  window.__probe = { rawHash: "", routeParam: "", ocr: "idle", parsed: null, error: null };

  function syncHash() {
    window.__probe.rawHash = window.location.hash;
  }
  syncHash();
  window.addEventListener("popstate", syncHash);
</script>

<Router>
  <nav>
    <Link to="/">capture</Link>
    <Link to="/bill">bill</Link>
    <Link to="/share">share</Link>
  </nav>
  <main>
    <Route path="/"><Capture /></Route>
    <Route path="/bill"><Bill /></Route>
    <Route path="/share"><Share /></Route>
    <Route path="/v1/:payload"><Share /></Route>
  </main>
</Router>
