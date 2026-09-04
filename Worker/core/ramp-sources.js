/**
 * ramp-sources.js — the four state ramp feeds, in ONE table.
 *
 * THERE WERE TWO, AND ONLY ONE OF THEM KNEW ABOUT FISH.
 *
 * `RAMP_SOURCES` in trollmap-worker.js served `/ramps` — the feed the browser reads for the map
 * layer, the ramp dropdown and the planner. `RESEARCH_RAMP_SOURCES` in research/facts-util.js
 * served the research pipeline off the SAME four ArcGIS layers. They drifted, and the drift ran
 * one way: the research copy read a species list and the app copy did not.
 *
 * Measured off the saved feeds in registry/, which are the app copy's own output:
 *
 *     _dnr_ramps_sc.json   438 ramps, 144 waterbodies   species: PRESENT
 *     _dnr_ramps_ga.json   659 ramps, 218 waterbodies   species: absent
 *     _dnr_ramps_nc.json   265 ramps, 114 waterbodies   species: absent
 *     _dnr_ramps_tn.json   678 ramps, 136 waterbodies   species: absent
 *
 * Georgia's layer carries species on 892 of 895 access points across 373 waterbodies — as
 * forty-eight yes/no columns rather than a list, which is why asking it for South Carolina's
 * `SpeciesList` returned undefined and recorded nothing. js/data/ga-access-species.js is the one
 * definition of that mapping. The research copy read it; the app copy asked for the wrong field.
 *
 * And South Carolina's species reached the browser all along and was thrown away there —
 * see keepSpecies() in js/data/access-index.js.
 *
 * Ryan, 2026-09-04: "why not stop the worker from throwing away the species lists that comes in
 * with the ramps feed". This file is that, and it is the prerequisite for reading a water's
 * species at plan time instead of out of a stored research profile — item 2 of the research
 * refactor, THE_PROFILE_BECAME_A_CACHE_AND_NOBODY_MOVED_THE_READS_2026-09-01.md.
 *
 * WHERE THE TWO COPIES DISAGREED, AND WHAT THIS TABLE DOES ABOUT IT
 *
 *   SC   Identical but for `idField`, which the research copy stated and the app copy left to
 *        fetchArcGisAllFeatures()'s default of 'OBJECTID' — the same value. Stated here.
 *
 *   GA   The app copy filtered `flagIsYes(p.Ramp)`, the research copy `p.Ramp === 'Y'`.
 *        flagIsYes is the shared helper and accepts y/yes/1/true/t, so it is the wider of the
 *        two and the one kept. Species added.
 *
 *   NC   Same filter both sides. NCWRC's layer has no species field at all, so no `species` key
 *        is emitted rather than an empty string — absent is "not published", `''` reads as
 *        "published, and empty". North Carolina's species come from
 *        registry/nc_species_by_lake.json instead; see the note in Worker/registry.js.
 *
 *   TN   THE ONE REAL DIVERGENCE. The two copies filtered on different columns:
 *          app       Type === 'Boat Launch' && IncludeWeb === 'Yes' && Status not closed/inactive
 *          research  Type === 'Boat Launch' && IncludeWeb ~= 'yes' && Ramps not 'none'/0
 *        They are testing different things and both are right: a closed site should not be
 *        offered, and a launch site with no ramp is not a ramp. So the merged filter is the
 *        conjunction of all of it. This is the one place the merge CHANGES what each caller
 *        sees — the app loses TN sites that have no ramp, research loses TN sites that are
 *        closed — and it is a change toward the truth in both directions.
 *
 * `metaMode` IS GONE. The app copy set `metaMode: 'flat'` on all four states and nothing has
 * ever read it: groupFeaturesByWaterbody() flattens meta unconditionally with Object.assign, and
 * `metaMode` appears nowhere else in Worker/, js/ or Scripts/. A property that looks like a
 * switch and is not one is worse than no property.
 *
 * AND THERE IS STILL A THIRD COPY. Scripts/build_dnr_ramps_by_lake.py carries its own table and
 * says so in its own header. Python cannot import this file; test/ramp-sources.test.js holds the
 * two together by reading both rather than by restating either.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */
import { flagIsYes } from './arcgis.js';
import { gaAccessSpecies } from '../../js/data/ga-access-species.js';

export const RAMP_SOURCES = {
  SC: {
    url: 'https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/South_Carolina_Public_Water_Access_PUBLIC_VIEW/FeatureServer/0/query',
    label: 'SCDNR South Carolina Public Water Access',
    idField: 'OBJECTID',
    filter: (p) => p.WaterAccessType === 'Boat Ramp'
                && String(p.Status || '').toLowerCase() === 'active'
                && String(p.PublicAccess || '').toLowerCase() !== 'closed',
    name: (p) => p.WaterAccessName,
    wb: (p) => p.Waterbody,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    // `SpeciesList` is a comma string. Georgia is joined into the same shape below on purpose,
    // so splitSpeciesText() reads both and nothing downstream has to know which state it has.
    meta: (p) => ({ lanes: p.LaunchLanes, dock: p.CourtesyDock, fee: false,
                    species: p.SpeciesList, county: p.County, owner: p.Owner,
                    comments: p.Comments }),
  },
  GA: {
    url: 'https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/WRD_Water_Access_Points/FeatureServer/0/query',
    label: 'Georgia DNR WRD Water Access Points',
    idField: 'FID',
    filter: (p) => flagIsYes(p.Ramp)
                && !['closed', 'inactive'].includes(String(p.Status || '').toLowerCase()),
    name: (p) => p.Name,
    wb: (p) => p.Waterbody,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    meta: (p) => ({ lanes: p.NumLanes, dock: p.Dock,
                    fee: String(p.Fee || '').toUpperCase() === 'Y',
                    species: gaAccessSpecies(p), county: p.County, owner: p.Owner,
                    motorRestrictions: p.MotorRest }),
  },
  NC: {
    url: 'https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/NCWRC_Boating_Access_Areas_view/FeatureServer/0/query',
    label: 'NC Wildlife Resources Commission Boating Access Areas',
    idField: 'OBJECTID',
    filter: (p) => !String(p.Site_Status || 'OPEN').toUpperCase().includes('CLOSED'),
    name: (p) => p.BAA_Name,
    wb: (p) => p.Water_Access || p.BAA_Alias,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    meta: (p) => ({ lanes: p.Launch_Lane_No, dock: p.Courtesy_Dock_No || p.Fix_Dock_No,
                    fee: false, county: p.County, owner: p.Owner,
                    motorRestrictions: p.Motorboats_Restricted }),
  },
  TN: {
    url: 'https://services3.arcgis.com/PWXNAH2YKmZY7lBq/arcgis/rest/services/Boat_Launch_Sites/FeatureServer/0/query',
    label: 'Tennessee Wildlife Resources Agency Boat Launch Sites',
    idField: 'OBJECTID',
    filter: (p) => p.Type === 'Boat Launch'
                && flagIsYes(p.IncludeWeb)
                && !['closed', 'inactive'].includes(String(p.Status || '').toLowerCase())
                && !/^(none|0)$/i.test(String(p.Ramps || '')),
    name: (p) => p.Name,
    wb: (p) => p.Waterway,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    meta: (p) => ({ lanes: p.Lanes,
                    dock: String(p.CourtesyDock || '').toLowerCase() === 'yes',
                    fee: String(p.AccessFee || '').toLowerCase() === 'yes',
                    county: p.County, owner: p.Owner,
                    restrooms: p.Restrooms === 'Yes', handicap: p.HandicapPark === 'Yes',
                    canoeLanding: p.CanoeLanding === 'Yes', launchable: p.Launchable }),
  },
};

/** The states this table covers, in the order the app has always requested them. */
export const RAMP_STATES = ['SC', 'NC', 'GA', 'TN'];
