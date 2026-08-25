// EVERY COLUMN limnology.js LOOKS UP HAS TO EXIST IN THE PROFILE IT ASKED FOR.
//
// `col()` in Worker/research/limnology.js is a case-insensitive SUBSTRING match against the WQP
// header row, and it returns -1 when nothing matches. `cols[-1]` is `undefined` in JavaScript
// rather than an error, so a lookup for a column that is not there produces '' on every record
// and nothing anywhere reports a fault.
//
// That is what happened to `col('projectname')`. The resultPhysChem profile has no column whose
// name contains "projectname" -- it has `ProjectIdentifier` -- so `programs` was [] in the
// surfaceWater block for every lake in the app, for as long as the block has existed. It was
// found on 2026-08-25 by audit_upstream_fields.py, only after that script was taught that a
// column can be looked up by name instead of reached by one.
//
// The header below is the real one, from a captured resultPhysChem response
// (waterqualitydata.us/data/Result/search, mimeType=csv). If WQP renames a column this test
// fails, which is the point: today the rename would have been silent.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(path.join(REPO, 'Worker/research/limnology.js'), 'utf8');

const RESULT_PHYSCHEM_HEADER = [
  'OrganizationIdentifier', 'OrganizationFormalName', 'ActivityIdentifier', 'ActivityTypeCode',
  'ActivityMediaName', 'ActivityMediaSubdivisionName', 'ActivityStartDate',
  'ActivityStartTime/Time', 'ActivityStartTime/TimeZoneCode', 'ActivityEndDate',
  'ActivityEndTime/Time', 'ActivityEndTime/TimeZoneCode',
  'ActivityDepthHeightMeasure/MeasureValue', 'ActivityDepthHeightMeasure/MeasureUnitCode',
  'ActivityDepthAltitudeReferencePointText', 'ActivityTopDepthHeightMeasure/MeasureValue',
  'ActivityTopDepthHeightMeasure/MeasureUnitCode', 'ActivityBottomDepthHeightMeasure/MeasureValue',
  'ActivityBottomDepthHeightMeasure/MeasureUnitCode', 'ProjectIdentifier',
  'ActivityConductingOrganizationText', 'MonitoringLocationIdentifier', 'ActivityCommentText',
  'SampleAquifer', 'HydrologicCondition', 'HydrologicEvent',
  'SampleCollectionMethod/MethodIdentifier', 'SampleCollectionMethod/MethodIdentifierContext',
  'SampleCollectionMethod/MethodName', 'SampleCollectionEquipmentName',
  'ResultDetectionConditionText', 'CharacteristicName', 'ResultSampleFractionText',
  'ResultMeasureValue', 'ResultMeasure/MeasureUnitCode', 'MeasureQualifierCode',
  'ResultStatusIdentifier', 'StatisticalBaseCode', 'ResultValueTypeName', 'ResultWeightBasisText',
  'ResultTimeBasisText', 'ResultTemperatureBasisText', 'ResultParticleSizeBasisText',
  'PrecisionValue', 'ResultCommentText', 'USGSPCode', 'ResultDepthHeightMeasure/MeasureValue',
  'ResultDepthHeightMeasure/MeasureUnitCode', 'ResultDepthAltitudeReferencePointText',
  'SubjectTaxonomicName', 'SampleTissueAnatomyName', 'ResultAnalyticalMethod/MethodIdentifier',
  'ResultAnalyticalMethod/MethodIdentifierContext', 'ResultAnalyticalMethod/MethodName',
  'MethodDescriptionText', 'LaboratoryName', 'AnalysisStartDate', 'ResultLaboratoryCommentText',
  'DetectionQuantitationLimitTypeName', 'DetectionQuantitationLimitMeasure/MeasureValue',
  'DetectionQuantitationLimitMeasure/MeasureUnitCode', 'PreparationStartDate', 'ProviderName',
];

/** The same resolution limnology.js performs, so a passing test means the real lookup lands. */
const resolve = (needle) =>
  RESULT_PHYSCHEM_HEADER.findIndex((h) => h.toLowerCase().includes(needle.toLowerCase()));

/** Every `col('...')` literal in the source, in the order they appear. */
const lookups = [...SRC.matchAll(/\bcol\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);

describe('WQP column lookups in limnology.js', () => {
  it('finds the lookups at all, so an empty list cannot pass this file', () => {
    expect(lookups.length >= 8).toBe(true);
  });

  it('every col() in the source resolves against the real resultPhysChem header', () => {
    const missing = lookups.filter((n) => resolve(n) < 0);
    // Names the offenders rather than just failing, because the whole failure mode here is a
    // lookup that is wrong in a way nothing prints.
    expect(missing).toEqual([]);
  });

  it('the lookups are lower-case, which is what col() compares against', () => {
    expect(lookups.filter((n) => n !== n.toLowerCase())).toEqual([]);
  });

  it('projectname is gone and projectidentifier is there', () => {
    // The specific regression. `projectname` matches nothing in this profile.
    expect(resolve('projectname')).toBe(-1);
    expect(resolve('projectidentifier') >= 0).toBe(true);
    expect(lookups.includes('projectname')).toBe(false);
    expect(lookups.includes('projectidentifier')).toBe(true);
  });

  it('the organisation resolves, and is looked up BEFORE the project code', () => {
    // `programs` is read by a person. Measured against two real responses on 2026-08-25:
    // Lake Murray carries 11 ProjectIdentifiers against 1 organisation, Hartwell 11 against 2 --
    // and the 2 are the fact worth showing, since Georgia and South Carolina both monitor it.
    expect(resolve('organizationformalname') >= 0).toBe(true);
    expect(lookups.includes('organizationformalname')).toBe(true);
    expect(lookups.indexOf('organizationformalname') < lookups.indexOf('projectidentifier')).toBe(true);
    expect(/cols\[iOrg\]\s*\|\|\s*cols\[iProject\]/.test(SRC)).toBe(true);
  });

  it('the depth fallback stops where the evidence stops', () => {
    // ActivityDepth, then ResultDepth, and no further. Two real responses covering SCDES and
    // Georgia DNR EPD -- 10,952 rows between them -- carry ZERO values in the
    // ActivityTop/BottomDepthHeightMeasure pair, so a third fallback would be built on a guess.
    expect(lookups.includes('activitydepthheightmeasure/measurevalue')).toBe(true);
    expect(lookups.includes('resultdepthheightmeasure/measurevalue')).toBe(true);
    expect(lookups.some((n) => n.includes('topdepth') || n.includes('bottomdepth'))).toBe(false);
  });

  it('no lookup is ambiguous enough to hit a column it did not mean', () => {
    // `col('activitydepthheightmeasure/measurevalue')` must not also match the Top or Bottom
    // depth columns, which differ only by a word in the middle.
    for (const n of lookups) {
      const hits = RESULT_PHYSCHEM_HEADER.filter((h) => h.toLowerCase().includes(n.toLowerCase()));
      expect(`${n}: ${hits.length}`).toBe(`${n}: 1`);
    }
  });

  it('the columns the summary actually needs are all present', () => {
    for (const need of ['characteristicname', 'resultmeasurevalue',
                        'resultmeasure/measureunitcode', 'activitystartdate']) {
      expect(lookups.includes(need)).toBe(true);
    }
  });

  it('the dead `location` field is gone from the record', () => {
    // It came from a lookup that never resolved either, and nothing ever read it.
    expect(/\bcol\(\s*'monitoringlocationname'/.test(SRC)).toBe(false);
    expect(/\bconst\s+iLoc\b/.test(SRC)).toBe(false);
  });
});
