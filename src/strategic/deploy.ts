// Deployment-zone constants (design doc §10, shipped 429a42c). Exported so
// player-facing text (the Field Manual) imports the live values instead of
// hand-copying numbers that drift.
import { ATTACK_POST_MARGIN } from './bridge';

// Equal to the attack-post filter line TODAY (shipped 429a42c) — bound by
// import so a retune cannot desync them silently. Design doc §10 argues for
// an independent 12; that is an open owner decision (HANDOFF findings).
export const DEPLOY_ATK_DEPTH = ATTACK_POST_MARGIN;
export const DEPLOY_DEF_LINE: Record<string, number> = { bourg: 60, woods: 80 };
export const DEPLOY_DEF_DEFAULT = 70;
