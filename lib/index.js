//#region lib/types/index.js
/**
 * Host marker for the push-to-talk browser contribution.
 *
 * All behavior lives in the client half (`./client`), which reuses the speech
 * Remote and the composer activity slot already provided by the enabled voice
 * input bundle. This half exists so the Loader row has a resolvable module.
 */
function apply() {}
//#endregion

export { apply };
