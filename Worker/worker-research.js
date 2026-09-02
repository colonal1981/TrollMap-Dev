// worker-research.js — public API barrel (impl in Worker/research/*)
export { handleResearchThermoclineSearch, handleResearchList, handleResearchGet, handleResearchSave, handleResearchApprove, handleResearchDelete, handleResearchDeleteNormalizedDoc, handleResearchPackage, handleResearchPackageFile, handleEnhancedLakeIntel, handleResearchValidationPass } from './research/storage.js';
export { handleResearchLimnologyData, refreshStaleLimnology } from './research/limnology.js';
export { handleResearchDiscover } from './research/discover.js';
export { handleResearchProxyDownload, handleResearchProxyDownloadBatch } from './research/download.js';
export { handleResearchDatasetHunt } from './research/dataset.js';
export { handleResearchDeterministicFacts, handleResearchSaveNormalized, handleResearchGetNormalized } from './research/deterministic.js';
export { handleResearchAnalyzeFacts, handleResearchDedupeContradictions, handleResearchMapFacts, handleResearchGapAnalysis, handleResearchGapSearch, GAP_QUERIES } from './research/extract.js';
export { handleResearchAgent, RESEARCH_AGENTS } from './research/agents.js';
export { sanitizeLakeId, lakeResearchMasterKey, lakePackageKey } from './research/keys.js';
// research/vision.js (Gemini chart-photo scanner) deleted 2026-08-06: 3 routes, 222 lines,
// zero callers anywhere in js/, Scripts/ or test/. Found by tools/audit.mjs.
export { handleSharedCheck, handleSharedStore, handleSharedQuery, handleSharedPublish, handleSharedStatus, handleSharedQuarantine, handleResearchRegsDebug } from './research/shared.js';
