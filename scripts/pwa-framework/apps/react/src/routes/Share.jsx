import { useParams } from "react-router";

export default function Share() {
  const params = useParams();
  window.__probe.routeParam = String(params.payload ?? "");
  window.__probe.rawHash = window.location.hash;
  return (
    <div>
      <h1>Share</h1>
      <p>placeholder view - tickets 15 and 16 own this flow</p>
    </div>
  );
}
