<script lang="ts">
  import { onMount } from "svelte";
  import { resolveLocation, targetUrl, ROUTE_PATHS, type RouteName } from "./lib/router.js";
  import Capture from "./routes/Capture.svelte";
  import Bill from "./routes/Bill.svelte";
  import Bills from "./routes/Bills.svelte";
  import StorageStatus from "./components/StorageStatus.svelte";
  import Share from "./routes/Share.svelte";
  import InstallBanner from "./components/InstallBanner.svelte";
  import ModelStatus from "./components/ModelStatus.svelte";
  import { onRouteChange } from "./lib/models/model-state.svelte.js";
  import NotFound from "./routes/NotFound.svelte";

  let route = $state<RouteName>("capture");
  let fragment = $state("");
  let renders = $state(0);

  // One read of the location into shell state. It is also the render counter: DECISIONS/0017 D3a
  // condition 1 is proved by this number advancing on a hash change while the document does not change.
  function sync(): void {
    const resolved = resolveLocation(window.location);
    route = resolved.route;
    fragment = resolved.fragment;
    renders += 1;
    // DECISIONS/0027 W2.1 (ruled): `/capture` is the only route that may prepare a model set. Every other
    // route reaches this same function and is refused by the trigger predicate, so a `/share` recipient or a
    // ledger browser never downloads weights.
    onRouteChange(route);
  }

  function go(pathname: string): void {
    // targetUrl carries the fragment through the path change byte-for-byte (D3a condition 3),
    // by concatenation — never through a URL object, which would re-encode it.
    window.history.pushState({}, "", targetUrl(pathname, fragment));
    sync();
  }

  function onNavClick(event: MouseEvent, pathname: string): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    go(pathname);
  }

  onMount(() => {
    sync();
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  });
</script>

<h1 id="shell-wordmark">receipt-lens</h1>

<nav aria-label="Views" id="shell-nav">
  <a href={ROUTE_PATHS.capture} data-nav="capture" onclick={(e) => onNavClick(e, ROUTE_PATHS.capture)}>Capture</a>
  <a href={ROUTE_PATHS.bill} data-nav="bill" onclick={(e) => onNavClick(e, ROUTE_PATHS.bill)}>Bill</a>
  <a href={ROUTE_PATHS.bills} data-nav="bills" onclick={(e) => onNavClick(e, ROUTE_PATHS.bills)}>Past bills</a>
  <a href={ROUTE_PATHS.share} data-nav="share" onclick={(e) => onNavClick(e, ROUTE_PATHS.share)}>Share</a>
</nav>

<InstallBanner />

{#if route !== "share"}
  <!-- Ticket 17: like the storage screens below, the model cache is shell state, not a condition of one view.
       It is absent on /share for the same reason DECISIONS/0023 gives — a recipient has no model history on
       this device and must not be told about one. -->
  <ModelStatus />
  <!-- Ticket 14: the storage screens are shell-level, because a migration gate or a full disk is not a
       condition of any one view — and /share must not show them (a recipient has no ledger on this device). -->
  <StorageStatus />
{/if}

<main id="shell-view" data-route={route} data-renders={renders} data-fragment-length={fragment.length}>
  {#if route === "capture"}
    <Capture />
  {:else if route === "bill"}
    <Bill />
  {:else if route === "bills"}
    <Bills />
  {:else if route === "share"}
    <Share {fragment} />
  {:else}
    <NotFound {fragment} />
  {/if}
</main>
