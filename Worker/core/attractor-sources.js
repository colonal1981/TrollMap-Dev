/**
 * attractor-sources.js — the four state fish-attractor feeds, in ONE table.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * THERE WERE TWO. The `/attractors` route in trollmap-worker.js carried this table inline, and
 * research/facts-util.js carried RESEARCH_ATTRACTOR_SOURCES off the same four ArcGIS layers, with
 * a note saying "fix both or collapse them; do not fix one". They had drifted: the research copy
 * handed Georgia's coded `attractor_code` through raw ("TRE PAL"), where the route decodes it
 * ("Trees/Brush"). This is the route's copy, collapsed 2026-09-25 the way ramp-sources.js was;
 * `label` and `idField` came from the research copy, which reads them. `metaMode` went: nothing
 * reads it (see ramp-sources.js).
 *
 * THE R2 OBJECT THEY SHARE. Both write `attractors/<st>/attractors.json`, in two shapes:
 *
 *   /attractors (handleGisRoute)   { state, source, count, waterbodies: { wb: [{name,lat,lon,type}] } }
 *   research (fetchArcGISGrouped)  { waterbodies: { wb: [{name,lat,lon,type}] } }
 *
 * The route rewrites the object whenever it is older than its 7-day TTL; the research path
 * writes only when the key is absent and never refreshes it. So what R2 holds is the route's
 * shape whenever the app has asked for attractors in the object's life, and the research shape
 * only between a research run on a missing key and the next app request. Every reader --
 * gis-toggles.js on the app side, getAttractorFacts() here -- reads `waterbodies` and nothing
 * else, which both shapes carry; nothing reads `state`, `source` or `count` off the object.
 */

// Read verbatim from the service's own cvd_attractor_code domain, 2026-08-06.
export const GA_ATTRACTOR_CODES = {
  AJK: "A Jack", ADU: "Air Diffuser Unit", BLD: "Boulders", CON: "Concrete",
  CRT: "Crate", GVL: "Gravel", HNH: "Honeyhole", MBK: "Mossback Trophy Tree XL",
  PAL: "Plastic Pallet Tent", PCP: "Porcupine Balls", PVC: "PVC Cube",
  PVT: "PVC Trees", RRP: "Rip Rap", STB: "Stake Bed", TRE: "Trees/Brush",
  UNK: "Unknown", OTH: "Other", other: "Other",
};
export const ATTRACTOR_SOURCES = {
  SC: {
    label: "SCDNR Freshwater Fish Attractors",
    idField: "OBJECTID",
    url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/SCDNR_Freshwater_Fish_Attractors_Public_Web_App/FeatureServer/0/query",
    filter: (p) => true,
    name: (p) => p.FishAttractorName,
    wb: (p) => p.Waterbody,
    lat: (p) => p.lat_dd,
    lon: (p) => p.lon_dd,
    type: (p) => p.Material,
  },
  // GA carried `lat: () => null, lon: () => null` -- every one of its 2,202
  // attractors came back with no position and was dropped by the client's
  // isFinite guard. It went unnoticed because the front end took GA from a
  // static snapshot instead of this route. Field names verified against the
  // service: lowercase `latitude` / `longitude`, esriFieldTypeDouble.
  GA: {
    label: "Georgia DNR Fish Attractors",
    idField: "OBJECTID",
    url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/Fish_Attractors_for_Download/FeatureServer/0/query",
    filter: (p) => true,
    name: (p) => (p.note || "").trim() || `${p.waterbody || "GA"} attractor`,
    wb: (p) => p.waterbody,
    lat: (p) => p.latitude,
    lon: (p) => p.longitude,
    // attractor_code is a coded-value domain; the raw code ("TRE", "PAL") is
    // meaningless to a user AND defeats the PVC/TREE icon test in gis-toggles.
    type: (p) => GA_ATTRACTOR_CODES[p.attractor_code]
      || (p.attractor_code_other || "").trim()
      || p.attractor_code
      || "Unknown",
  },
  NC: {
    label: "NC WRC Fish Attractors",
    idField: "OBJECTID",
    url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/Fish_Attractors_public_view/FeatureServer/0/query",
    filter: (p) => true,
    name: (p) => `${p.Waterbody} Attractor`,
    wb: (p) => p.Waterbody,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    type: (p) => `${p.Structure1 || ""} ${p.Structure2 || ""}`.trim() || p.Attractor_Type,
  },
  TN: {
    label: "Tennessee Wildlife Resources Agency Fish Attractors",
    idField: "OBJECTID",
    url: "https://services3.arcgis.com/PWXNAH2YKmZY7lBq/arcgis/rest/services/Fish_Attractor_Locations_view/FeatureServer/0/query",
    filter: (p) => true,
    name: (p) => p.Site_Name || (p.Embayment ? `${p.WaterBody} - ${p.Embayment}` : `${p.WaterBody} Attractor`),
    wb: (p) => p.WaterBody,
    lat: (p) => p.YLat,
    lon: (p) => p.XLong,
    type: (p) => [p.StructureTypes, p.Artificial, p.Natural_].filter(Boolean).join(", ") || "Unknown",
  }
};
