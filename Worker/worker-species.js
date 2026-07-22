// worker-species.js — Species lists and ecological validation
// Extracted from trollmap-worker.js


var SPECIES_MIDLANDS_SANTEE = [
  "Striped Bass",
  "Largemouth Bass",
  "White Bass / Hybrid",
  "Chain Pickerel",
  "Bowfin",
  "Bowfin (Mudfish)",
  "Black Crappie",
  "White Crappie",
  "Crappie",
  "Bluegill",
  "Redear Sunfish (Shellcracker)",
  "Redbreast Sunfish",
  "Sunfish (Panfish)",
  "Yellow Perch",
  "Blue Catfish",
  "Channel Catfish",
  "Flathead Catfish",
  "Catfish",
  "Longnose Gar",
  "Spotted Gar",
  "Gar",
  "American Shad",
  "Herring",
  "Common Carp",
  "Grass Carp",
  "Tilapia"
];
var SPECIES_UPSTATE = [
  "Spotted Bass",
  "Largemouth Bass",
  "Smallmouth Bass",
  "Striped Bass",
  "Rainbow / Brown Trout",
  "Trout",
  "Black Crappie",
  "White Crappie",
  "Crappie",
  "Channel Catfish",
  "Catfish",
  "Walleye",
  "Yellow Perch",
  "Bluegill",
  "Chain Pickerel"
];
var SPECIES_COASTAL_SALTWATER = [
  "Red Drum (Redfish)",
  "Speckled Trout (Spotted Seatrout)",
  "Flounder",
  "Black Drum",
  "Sheepshead",
  "Bluefish",
  "Spanish Mackerel",
  "Black Sea Bass",
  "Atlantic Croaker",
  "Whiting / Sea Mullet",
  "Cobia",
  "Striped Bass",
  "Ladyfish",
  "Jack Crevalle",
  // freshwater strays in tidal creeks
  "Largemouth Bass",
  "Bowfin",
  "Catfish",
  "Bluegill",
  "Sunfish (Panfish)",
  "Gar"
];
var SPECIES_ALL_TROLLMAP = [...new Set([
  ...SPECIES_MIDLANDS_SANTEE,
  ...SPECIES_UPSTATE,
  ...SPECIES_COASTAL_SALTWATER,
  // catch-journal canonical aliases
  "Spotted Bass",
  "Smallmouth Bass",
  "Blue Catfish",
  "Channel Catfish",
  "Flathead Catfish",
  "Bowfin",
  "Chain Pickerel",
  "Bluegill",
  "Redear Sunfish (Shellcracker)",
  "Sunfish (Panfish)",
  "Warmouth",
  "Yellow Perch",
  "White Perch",
  "Longnose Gar",
  "Gar",
  "Red Drum (Redfish)",
  "Speckled Trout (Spotted Seatrout)",
  "Flounder",
  "American Shad",
  "White Bass / Hybrid",
  "Crappie",
  "Catfish",
  "Other Fish",
  "Not Fish"
])].sort();
function getSpeciesListForGps(lat, lon) {
  if (!isFinite(lat) || !isFinite(lon)) return SPECIES_MIDLANDS_SANTEE;
  if (lon > -80.2 && lat < 33.8) return SPECIES_COASTAL_SALTWATER;
  if (lat > 34.5 && lon < -82) return SPECIES_UPSTATE;
  return SPECIES_MIDLANDS_SANTEE;
}
var MAX_BIOLOGICAL_LENGTH = {
  "Largemouth Bass": 26.5,
  "Spotted Bass": 24,
  "Smallmouth Bass": 24.5,
  "Black Crappie": 18.5,
  "White Crappie": 18.5,
  "Crappie": 18.5,
  "Bluegill": 14,
  "Redear Sunfish (Shellcracker)": 15,
  "Redbreast Sunfish": 12,
  "Sunfish (Panfish)": 14,
  "Yellow Perch": 16,
  "White Bass / Hybrid": 30,
  "Chain Pickerel": 28.5,
  "Bowfin": 36,
  "Bowfin (Mudfish)": 36,
  "Striped Bass": 52,
  "Flounder": 32,
  "Speckled Trout (Spotted Seatrout)": 34,
  "Red Drum (Redfish)": 55
};
function checkBiologicalLength(species, length) {
  if (!length || !species) return [true, ""];
  const maxLen = MAX_BIOLOGICAL_LENGTH[species] ?? MAX_BIOLOGICAL_LENGTH[species?.replace(" (Mudfish)", "")] ?? 60;
  if (length > maxLen) return [false, `\u26A0\uFE0F LENGTH ANOMALY: Reported length (${length} in) exceeds biological limit for ${species} (max ~${maxLen} in).`];
  if (length < 3) return [false, `\u26A0\uFE0F LENGTH ANOMALY: Reported length (${length} in) is implausibly small.`];
  return [true, ""];
}
var PURE_SALTWATER = new Set([
  "Red Drum (Redfish)",
  "Speckled Trout (Spotted Seatrout)",
  "Flounder",
  "Black Drum",
  "Sheepshead",
  "Bluefish",
  "Spanish Mackerel",
  "Black Sea Bass",
  "Atlantic Croaker",
  "Whiting / Sea Mullet",
  "Cobia",
  "Ladyfish",
  "Jack Crevalle"
]);
var PURE_FRESHWATER = new Set([
  "Largemouth Bass",
  "Spotted Bass",
  "Smallmouth Bass",
  "Black Crappie",
  "White Crappie",
  "Crappie",
  "Chain Pickerel",
  "Bowfin",
  "Bowfin (Mudfish)",
  "Bluegill",
  "Redear Sunfish (Shellcracker)",
  "Redbreast Sunfish",
  "Sunfish (Panfish)",
  "Warmouth",
  "Walleye",
  "Rainbow / Brown Trout",
  "Trout",
  "Blue Catfish",
  "Channel Catfish",
  "Flathead Catfish",
  "Catfish",
  "Longnose Gar",
  "Spotted Gar",
  "Gar",
  "Yellow Perch",
  "White Perch",
  "Common Carp",
  "Grass Carp",
  "Tilapia"
]);
function checkEcologicalReality(lat, lon, species) {
  if (!isFinite(lat) || !isFinite(lon) || !species) return [true, ""];
  const s = String(species);
  if (["Not Fish", "No Fish", "Unknown", "Other Fish", "", "Other"].includes(s)) return [true, ""];
  if (34.3 <= lat && lat <= 34.42 && -80.22 <= lon && lon <= -80.08) {
    if (/Striped Bass|Striper|Hybrid/i.test(s)) {
      return [false, `\u26A0\uFE0F ECOLOGICAL ANOMALY: ${s} reported in Lake Robinson area (Darlington Co). Lake Robinson has NO established Striped Bass population.`];
    }
  }
  if (34.24 <= lat && lat <= 34.38 && -81.38 <= lon && lon <= -81.25) {
    if (/Striped Bass|Striper/i.test(s)) {
      return [false, `\u26A0\uFE0F ECOLOGICAL ANOMALY: ${s} reported in Monticello/Parr Reservoir area. No stocked striper population here.`];
    }
  }
  const is_murrells_inlet = 33.45 <= lat && lat <= 33.7 && lon >= -79.15;
  const is_charleston_coast = lat <= 32.9 && lon >= -79.95;
  const is_southern_coast = lat <= 32.45 && lon >= -80.75;
  if (is_murrells_inlet || is_charleston_coast || is_southern_coast) {
    if (PURE_FRESHWATER.has(s) || /Bass|Crappie|Pickerel|Bowfin|Catfish|Bluegill|Sunfish|Perch|Gar/i.test(s) && !/Striped Bass|White Bass|Sea Bass/i.test(s)) {
      const pureCheck = [...PURE_FRESHWATER].some((pf) => s === pf);
      if (pureCheck) {
        const place = is_murrells_inlet ? "Murrells Inlet / Grand Strand Estuary" : "High-Salinity Coastal Marine Estuary";
        return [false, `\u26A0\uFE0F ECOLOGICAL ANOMALY: Pure freshwater species (${s}) reported in ${place}.`];
      }
    }
  }
  if (lon <= -80.35 && lat >= 33.2) {
    if (PURE_SALTWATER.has(s)) {
      return [false, `\u26A0\uFE0F ECOLOGICAL ANOMALY: Pure saltwater marine species (${s}) reported in inland freshwater reservoir.`];
    }
  }
  if (/Smallmouth Bass/i.test(s)) {
    const in_monticello_parr = 34.15 <= lat && lat <= 34.45 && -81.45 <= lon && lon <= -81.15;
    const in_upstate_mountains = lat >= 34.5 && lon <= -82;
    if (!(in_monticello_parr || in_upstate_mountains)) {
      return [false, `\u26A0\uFE0F ECOLOGICAL ANOMALY: Smallmouth Bass reported outside valid habitat (only possible in Monticello/Parr Reservoir or cold Upstate mountain waters).`];
    }
  }
  if (/Trout|Walleye/i.test(s)) {
    if (lat < 34.5 || lon > -82) {
      return [false, `\u26A0\uFE0F ECOLOGICAL ANOMALY: Coldwater species (${s}) reported outside cold mountain waters.`];
    }
  }
  return [true, ""];
}

export { SPECIES_MIDLANDS_SANTEE, SPECIES_UPSTATE, SPECIES_COASTAL_SALTWATER, SPECIES_ALL_TROLLMAP, MAX_BIOLOGICAL_LENGTH, PURE_SALTWATER, PURE_FRESHWATER, getSpeciesListForGps, checkBiologicalLength, checkEcologicalReality };
