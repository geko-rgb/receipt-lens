import { demoParse } from "../lib/parse-demo.js";

export default function Bill() {
  const result = demoParse();
  window.__probe.parsedItems = result.items;
  return (
    <div>
      <h1>Bill</h1>
      <p>placeholder view - tickets 11 to 13 own this flow</p>
      <span id="parse-items">{result.items}</span>
    </div>
  );
}
