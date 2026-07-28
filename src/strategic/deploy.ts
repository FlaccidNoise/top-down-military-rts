// Deployment-zone constants (design doc §10, shipped 429a42c). Exported so
// player-facing text (the Field Manual) imports the live values instead of
// hand-copying numbers that drift.
export const DEPLOY_ATK_DEPTH = 32; // = ATTACK_POST_MARGIN
export const DEPLOY_DEF_LINE: Record<string, number> = { bourg: 60, woods: 80 };
export const DEPLOY_DEF_DEFAULT = 70;
