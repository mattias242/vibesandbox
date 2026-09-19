/**
 * @vibesandbox/policy — vad appens kod får innehålla.
 *
 * Mönsterbaserat FÖRSVAR PÅ DJUPET. Det bärande skyddet är plattformens CSP i webbläsaren;
 * se README.md för vad policyn fångar, vad den inte fångar och varför den ändå finns.
 */
export { ALLOWED_IMPORTS, checkSourceFiles, SOURCE_LIMITS } from './source.ts';
export { checkBuiltBundle } from './bundle.ts';
export { ALLOWED_BUNDLE_URLS, ALLOWED_SOURCE_URLS } from './urls.ts';
